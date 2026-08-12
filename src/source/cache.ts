import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIgnoredGeneratedEntry, pathExists } from "../utils/fs.js";

const snapshotNamePattern = /^(.*)-([0-9a-f]{12})$/i;

export interface GitCachePruneOptions {
  keepSnapshots?: number;
  currentSnapshot?: string;
  dryRun?: boolean;
}

export interface GitCachePruneResult {
  removedPaths: string[];
  retainedPaths: string[];
}

interface SnapshotEntry {
  path: string;
  commitPrefix: string;
  modifiedAt: number;
}

/**
 * Remove old per-commit snapshots while retaining recent and locked commits.
 * The mutable checkout itself is never removed.
 */
export async function pruneGitCache(cacheRoot: string, options: GitCachePruneOptions = {}): Promise<GitCachePruneResult> {
  if (!(await pathExists(cacheRoot))) return { removedPaths: [], retainedPaths: [] };
  const referencedCommits = await referencedGraphLockCommits(join(dirname(cacheRoot), "locks"));
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const groups = new Map<string, SnapshotEntry[]>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = snapshotNamePattern.exec(entry.name);
    if (!match) continue;
    const checkoutPath = join(cacheRoot, match[1]);
    if (!(await pathExists(join(checkoutPath, ".git")))) continue;
    const snapshotPath = join(cacheRoot, entry.name);
    const snapshotStats = await stat(snapshotPath);
    const snapshots = groups.get(checkoutPath) ?? [];
    snapshots.push({ path: snapshotPath, commitPrefix: match[2].toLowerCase(), modifiedAt: snapshotStats.mtimeMs });
    groups.set(checkoutPath, snapshots);
  }

  const keepCount = Math.max(1, Math.floor(options.keepSnapshots ?? 3));
  const removedPaths: string[] = [];
  const retainedPaths: string[] = [];

  for (const [checkoutPath, snapshots] of groups) {
    if (!options.dryRun) await removeGeneratedEntries(checkoutPath, true);
    snapshots.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    const keep = new Set<string>();
    for (const snapshot of snapshots.slice(0, keepCount)) keep.add(snapshot.path);
    if (options.currentSnapshot) keep.add(options.currentSnapshot);
    for (const snapshot of snapshots) {
      if ([...referencedCommits].some((commit) => commit.startsWith(snapshot.commitPrefix))) keep.add(snapshot.path);
    }

    for (const snapshot of snapshots) {
      if (keep.has(snapshot.path)) {
        retainedPaths.push(snapshot.path);
        if (!options.dryRun) await removeGeneratedEntries(snapshot.path, false);
      } else {
        removedPaths.push(snapshot.path);
        if (!options.dryRun) await rm(snapshot.path, { recursive: true, force: true });
      }
    }
  }

  return { removedPaths, retainedPaths };
}

export async function removeGeneratedEntries(root: string, preserveGit: boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (isIgnoredGeneratedEntry(entry.name) && !(preserveGit && entry.name === ".git")) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removeGeneratedEntries(path, preserveGit);
    }
  }
}

async function referencedGraphLockCommits(lockRoot: string): Promise<Set<string>> {
  const commits = new Set<string>();
  await walkJson(lockRoot, (value) => collectResolvedCommits(value, commits));
  return commits;
}

async function walkJson(root: string, visit: (value: unknown) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJson(path, visit);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        visit(JSON.parse(await readFile(path, "utf8")));
      } catch {
        // Ignore unrelated or partially-written lock files during maintenance.
      }
    }
  }
}

function collectResolvedCommits(value: unknown, commits: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectResolvedCommits(item, commits);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "resolvedCommit" && typeof item === "string" && /^[0-9a-f]{12,40}$/i.test(item)) {
      commits.add(item.toLowerCase());
    }
    collectResolvedCommits(item, commits);
  }
}
