import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface EffectSnapshot {
  tree: Record<string, { kind: string; mode: number; bytes?: string; target?: string }>;
  claims: Record<string, unknown>;
  git?: { index: string; refs: string; head: string; indexBytes: string };
}
export interface EffectPolicy {
  // Exact relative paths only, each with a fixture-specific reason. No globs or prefixes.
  exclude?: Record<string, string>;
  manifests?: string[];
  git?: boolean;
}

export async function snapshot(root: string, policy: EffectPolicy = {}): Promise<EffectSnapshot> {
  for (const [path, reason] of Object.entries(policy.exclude ?? {})) {
    if (!reason.trim() || path.startsWith("/") || path.split("/").some(p => p === ".." || p === "." || !p)
      || /[*?\[\]]/.test(path)) throw new Error("Exclusions require an exact relative path and reason");
  }
  const result: EffectSnapshot = { tree: {}, claims: {} };
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      result.tree[relative || "."] = { kind: "directory", mode: stat.mode & 0o7777 };
      for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (!Object.hasOwn(policy.exclude ?? {}, relative)) {
      result.tree[relative] = stat.isSymbolicLink()
        ? { kind: "symlink", mode: stat.mode & 0o7777, target: await readlink(path) }
        : { kind: "file", mode: stat.mode & 0o7777, bytes: (await readFile(path)).toString("base64") };
    } else if ((policy.manifests ?? []).includes(relative)) {
      throw new Error("Manifest claims cannot be excluded");
    }
  }
  await visit("");
  for (const path of policy.manifests ?? []) result.claims[path] = JSON.parse(await readFile(join(root, path), "utf8"));
  if (policy.git) {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    const indexPath = git("rev-parse", "--git-path", "index").trim();
    const indexBytes = (await readFile(isAbsolute(indexPath) ? indexPath : resolve(root,indexPath))).toString("base64");
    result.git = { indexBytes, index: git("ls-files", "--stage", "-z"), refs: git("show-ref", "--head"), head: git("symbolic-ref", "-q", "HEAD") };
  }
  return result;
}

export function diffEffects(before: EffectSnapshot, after: EffectSnapshot): string[] {
  const changes: string[] = [];
  for (const section of ["tree", "claims", "git"] as const) {
    const left = before[section] ?? {};
    const right = after[section] ?? {};
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (JSON.stringify(left[key as keyof typeof left]) !== JSON.stringify(right[key as keyof typeof right])) changes.push(`${section}:${key}`);
    }
  }
  return changes;
}
