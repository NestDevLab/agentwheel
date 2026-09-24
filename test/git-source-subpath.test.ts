import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDependencyGraph } from "../src/resolve/graph.js";
import { GitSourceDriver } from "../src/source/git.js";
import { parseGitSource, resolveGitRelativeSubpath } from "../src/source/git-source.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-git-subpath-"));
  tempRoots.push(root);
  return root;
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeOpenPack(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeText(join(root, "openpack.json"), `${JSON.stringify({ schemaVersion: 2, version: "1.0.0", ...manifest }, null, 2)}\n`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function commitAll(repo: string): Promise<string> {
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "initial"]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

// A monorepo whose nested package depends on a sibling and on the repository root.
async function monorepo(root: string): Promise<{ repo: string; commit: string }> {
  const repo = join(root, "repo");
  await writeText(join(repo, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: shared\n---\n");
  await writeOpenPack(repo, { name: "acme/root", provides: [{ type: "skills", path: "skills" }] });
  await writeText(join(repo, "packages", "helper", "rules", "helper.md"), "# Helper\n");
  await writeOpenPack(join(repo, "packages", "helper"), { name: "acme/helper", provides: [{ type: "rules", path: "rules" }] });
  await writeText(join(repo, "packages", "pack", "rules", "pack.md"), "# Pack\n");
  await writeOpenPack(join(repo, "packages", "pack"), {
    name: "acme/pack",
    requires: {
      root: { source: "../..", select: ["skills/shared"] },
      helper: { source: "../helper", select: ["rules/helper.md"] },
    },
    provides: [{ type: "rules", path: "rules" }],
  });
  return { repo, commit: await commitAll(repo) };
}

describe("git source subpath parsing", () => {
  it("separates ref and subpath on the double slash", () => {
    expect(parseGitSource("git:ssh://host/org/repo.git#main//packages/pack")).toEqual({
      url: "ssh://host/org/repo.git",
      ref: "main",
      subpath: "packages/pack",
    });
  });

  it("keeps slashes that belong to the ref", () => {
    expect(parseGitSource("git:https://host/r.git#fix/some-branch//packages/pack")).toMatchObject({
      ref: "fix/some-branch",
      subpath: "packages/pack",
    });
  });

  it("allows a subpath without a ref", () => {
    expect(parseGitSource("git:https://host/r.git#//packages/pack")).toEqual({
      url: "https://host/r.git",
      subpath: "packages/pack",
    });
  });

  it("reads a subpath from a github source", () => {
    expect(parseGitSource("github:Acme/Repo#main//packages/pack")).toEqual({
      url: "https://github.com/Acme/Repo.git",
      ref: "main",
      subpath: "packages/pack",
    });
  });

  it("leaves a source without subpath unchanged", () => {
    expect(parseGitSource("git:https://host/r.git#main")).toEqual({ url: "https://host/r.git", ref: "main" });
  });

  it("refuses a subpath that leaves the repository", () => {
    expect(() => parseGitSource("git:https://host/r.git#main//../other")).toThrow(/escapes the repository/);
    expect(() => parseGitSource("git:https://host/r.git#main///etc")).toThrow(/relative to the repository/);
  });

  it("resolves a relative dependency against the declaring package's place in the repository", () => {
    expect(resolveGitRelativeSubpath("packages/pack", "../..", "src")).toBeUndefined();
    expect(resolveGitRelativeSubpath("packages/pack", "../helper", "src")).toBe("packages/helper");
    expect(resolveGitRelativeSubpath(undefined, "./packages/pack", "src")).toBe("packages/pack");
    expect(() => resolveGitRelativeSubpath("packages/pack", "../../..", "src")).toThrow(/escapes the git repository/);
  });
});

describe("git source driver with a subpath", () => {
  it("treats the subpath as the package root", async () => {
    const root = await tempRoot();
    const { repo, commit } = await monorepo(root);
    const driver = new GitSourceDriver();
    const fetched = await driver.fetch(await driver.resolve(`git:${repo}#main//packages/helper`, { cacheRoot: join(root, "cache") }));

    expect(fetched.resolvedPath.endsWith(join("packages", "helper"))).toBe(true);
    expect(fetched.packageName).toBe("acme/helper");
    expect(fetched.resolvedCommit).toBe(commit);
  });

  it("names the missing subpath and commit instead of reading the repository root", async () => {
    const root = await tempRoot();
    const { repo } = await monorepo(root);
    const driver = new GitSourceDriver();
    const resolved = await driver.resolve(`git:${repo}#main//packages/missing`, { cacheRoot: join(root, "cache") });

    await expect(driver.fetch(resolved)).rejects.toThrow(/subpath 'packages\/missing' does not exist/);
  });
});

describe("relative dependencies inside a git package", () => {
  it("resolve to the same repository at the same commit, never to a cache path", async () => {
    const root = await tempRoot();
    const { repo, commit } = await monorepo(root);
    const cacheRoot = join(root, "cache");

    const graph = await resolveDependencyGraph(
      [{ rootId: "pack", source: `git:${repo}#main//packages/pack`, mode: "tracking" }],
      { workspaceRoot: root, cacheRoot },
    );

    const sources = graph.nodes.map((node) => node.normalizedSource).sort();
    expect(sources).toEqual([
      `git:${repo}#${commit}`,
      `git:${repo}#${commit}//packages/helper`,
      `git:${repo}#main//packages/pack`,
    ].sort());
    expect(graph.nodes.every((node) => node.resolvedCommit === commit)).toBe(true);
    expect(sources.some((source) => source.includes(cacheRoot))).toBe(false);
  });

  it("refuse to reach outside the repository", async () => {
    const root = await tempRoot();
    const repo = join(root, "repo");
    await writeText(join(repo, "packages", "pack", "rules", "pack.md"), "# Pack\n");
    await writeOpenPack(join(repo, "packages", "pack"), {
      name: "acme/pack",
      requires: { outside: { source: "../../../elsewhere", select: ["rules/x"] } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await commitAll(repo);

    await expect(resolveDependencyGraph(
      [{ rootId: "pack", source: `git:${repo}#main//packages/pack`, mode: "tracking" }],
      { workspaceRoot: root, cacheRoot: join(root, "cache") },
    )).rejects.toThrow(/escapes the git repository/);
  });
});
