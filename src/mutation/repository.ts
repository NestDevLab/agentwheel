import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import type { RevisionPath } from "./protocol.js";
import { runProcess } from "./process.js";

export interface GitRepositoryState {
  root: string;
  head: string;
  branch: string;
}

export interface RepositorySnapshot {
  changed: Map<string, string | null>;
}

export async function discoverGitRepository(start: string): Promise<GitRepositoryState | undefined> {
  const probe = await runProcess("git", ["-C", start, "rev-parse", "--show-toplevel"], { allowExitCodes: [0, 128] });
  if (probe.exitCode !== 0) return undefined;
  const root = probe.stdout.toString("utf8").trim();
  const head = (await runProcess("git", ["-C", root, "rev-parse", "HEAD"])).stdout.toString("utf8").trim();
  const branchProbe = await runProcess("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { allowExitCodes: [0, 1] });
  if (branchProbe.exitCode !== 0) throw new Error(`Revisioning requires an attached Git branch at ${root}.`);
  return { root, head, branch: branchProbe.stdout.toString("utf8").trim() };
}

export async function assertGitPreflight(repository: GitRepositoryState): Promise<void> {
  const current = (await runProcess("git", ["-C", repository.root, "rev-parse", "HEAD"])).stdout.toString("utf8").trim();
  if (current !== repository.head) throw new Error(`Git HEAD changed during mutation preflight: expected ${repository.head}, found ${current}.`);
  const staged = await runProcess("git", ["-C", repository.root, "diff", "--cached", "--quiet"], { allowExitCodes: [0, 1] });
  if (staged.exitCode !== 0) throw new Error("Revisioning requires a clean Git index; existing staged changes are not owned by this operation.");
  const conflicts = (await runProcess("git", ["-C", repository.root, "diff", "--name-only", "--diff-filter=U", "-z"])).stdout;
  if (conflicts.length > 0) throw new Error("Revisioning refuses a repository with unresolved Git conflicts.");
  const gitDir = (await runProcess("git", ["-C", repository.root, "rev-parse", "--absolute-git-dir"])).stdout.toString("utf8").trim();
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const result = await runProcess("git", ["-C", repository.root, "rev-parse", "--verify", "--quiet", marker], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode === 0) throw new Error(`Revisioning refuses an in-progress Git operation (${marker}) in ${gitDir}.`);
  }
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    if (await exists(resolve(gitDir, marker))) throw new Error(`Revisioning refuses an in-progress Git operation (${marker}) in ${gitDir}.`);
  }
}

export async function snapshotRepository(repositoryRoot: string): Promise<RepositorySnapshot> {
  const paths = await changedRepositoryPaths(repositoryRoot);
  const changed = new Map<string, string | null>();
  for (const path of paths) changed.set(path, await hashWorkingPath(repositoryRoot, path));
  return { changed };
}

export async function collectIntroducedPaths(
  repositoryRoot: string,
  expectedHead: string,
  before: RepositorySnapshot,
  declaredPaths: string[],
): Promise<RevisionPath[]> {
  const after = await snapshotRepository(repositoryRoot);
  const touchedPreexisting = new Set<string>();
  for (const [path, hash] of before.changed) {
    if (!after.changed.has(path) || after.changed.get(path) !== hash) touchedPreexisting.add(path);
  }
  if (touchedPreexisting.size > 0) {
    throw new Error(`Mutation touched pre-existing dirty paths: ${[...touchedPreexisting].sort().join(", ")}.`);
  }

  const introduced = [...after.changed.keys()]
    .filter((path) => !before.changed.has(path))
    .sort((a, b) => a.localeCompare(b));
  const allowed = new Set(declaredPaths);
  const unexpected = introduced.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Mutation produced undeclared repository paths: ${unexpected.join(", ")}.`);
  }
  const result: RevisionPath[] = [];
  for (const path of introduced) {
    result.push({
      path,
      beforeSha256: await hashHeadPath(repositoryRoot, expectedHead, path),
      afterSha256: after.changed.get(path) ?? null,
    });
  }
  return result;
}

export async function verifyRevisionPaths(repositoryRoot: string, expectedHead: string, paths: RevisionPath[]): Promise<void> {
  for (const entry of paths) {
    const before = await hashHeadPath(repositoryRoot, expectedHead, entry.path);
    const after = await hashWorkingPath(repositoryRoot, entry.path);
    if (before !== entry.beforeSha256 || after !== entry.afterSha256) {
      throw new Error(`Revision path lease changed for ${entry.path}.`);
    }
  }
}

export async function stageExactPaths(repositoryRoot: string, paths: RevisionPath[]): Promise<void> {
  if (paths.length === 0) return;
  await runProcess("git", ["-C", repositoryRoot, "add", "--", ...paths.map((entry) => entry.path)]);
  const staged = splitNull((await runProcess("git", ["-C", repositoryRoot, "diff", "--cached", "--name-only", "-z"])).stdout);
  const expected = paths.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
  const actual = [...new Set(staged)].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Exact staging mismatch: expected [${expected.join(", ")}], found [${actual.join(", ")}].`);
  }
}

export async function currentHead(repositoryRoot: string): Promise<string> {
  return (await runProcess("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.toString("utf8").trim();
}

async function changedRepositoryPaths(repositoryRoot: string): Promise<string[]> {
  const result = await runProcess("git", [
    "-C",
    repositoryRoot,
    "ls-files",
    "-m",
    "-d",
    "-o",
    "--exclude-standard",
    "-z",
  ]);
  return [...new Set(splitNull(result.stdout).map(normalizeRepoPath))].sort((a, b) => a.localeCompare(b));
}

async function hashHeadPath(repositoryRoot: string, head: string, path: string): Promise<string | null> {
  const result = await runProcess("git", ["-C", repositoryRoot, "show", `${head}:${path}`], { allowExitCodes: [0, 128] });
  if (result.exitCode !== 0) return null;
  return sha256(result.stdout);
}

async function hashWorkingPath(repositoryRoot: string, path: string): Promise<string | null> {
  const absolute = resolve(repositoryRoot, ...path.split("/"));
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink()) return sha256(Buffer.from(await readlink(absolute), "utf8"));
  if (stats.isFile()) return sha256(await readFile(absolute));
  if (stats.isDirectory()) return hashDirectory(absolute);
  throw new Error(`Unsupported repository path kind: ${path}`);
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = resolve(dir, entry.name);
      const relativePath = normalizeRepoPath(relative(root, absolute));
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isSymbolicLink()) hash.update(relativePath).update("\0").update(await readlink(absolute)).update("\0");
      else if (entry.isFile()) hash.update(relativePath).update("\0").update(await readFile(absolute)).update("\0");
    }
  }
  await walk(root);
  return hash.digest("hex");
}

function splitNull(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean);
}

function normalizeRepoPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join(posix.sep);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
