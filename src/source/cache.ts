import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIgnoredGeneratedEntry, pathExists } from "../utils/fs.js";

const snapshotNamePattern = /^(.*)-([0-9a-f]{12})$/i;
const leaseMarker = ".agentwheel-lease-";

export interface GitCachePruneOptions {
  keepSnapshots?: number;
  currentSnapshot?: string;
  dryRun?: boolean;
  maintenanceLockHeld?: boolean;
  cacheLockTimeoutMs?: number;
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
 * Remove old per-commit snapshots while retaining recent, locked, and leased commits.
 * The mutable checkout itself is never removed.
 */
export async function pruneGitCache(cacheRoot: string, options: GitCachePruneOptions = {}): Promise<GitCachePruneResult> {
  if (!(await pathExists(cacheRoot))) return { removedPaths: [], retainedPaths: [] };
  if (options.maintenanceLockHeld) return pruneGitCacheUnlocked(cacheRoot, options);
  return withGitCacheMaintenanceLock(
    cacheRoot,
    options.cacheLockTimeoutMs ?? 30_000,
    () => pruneGitCacheUnlocked(cacheRoot, options),
  );
}

export async function withGitCacheMaintenanceLock<T>(
  cacheRoot: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = join(cacheRoot, ".maintenance.lock");
  await mkdir(cacheRoot, { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        "utf8",
      );
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await removeStaleMaintenanceLock(lockPath)) continue;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for git cache maintenance lock at ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function createGitSnapshotLease(snapshotPath: string): Promise<string> {
  const leasePath = `${snapshotPath}${leaseMarker}${process.pid}-${randomUUID()}`;
  await writeFile(leasePath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
    encoding: "utf8",
    flag: "wx",
  });
  return leasePath;
}

export async function releaseGitSnapshotLease(leasePath: string | undefined): Promise<void> {
  if (leasePath) await rm(leasePath, { force: true });
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

async function pruneGitCacheUnlocked(cacheRoot: string, options: GitCachePruneOptions): Promise<GitCachePruneResult> {
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
      if (await hasLiveSnapshotLease(snapshot.path, options.dryRun === true)) keep.add(snapshot.path);
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

async function referencedGraphLockCommits(lockRoot: string): Promise<Set<string>> {
  const commits = new Set<string>();
  await walkGraphLocks(lockRoot, (value) => collectResolvedCommits(value, commits));
  return commits;
}

async function walkGraphLocks(root: string, visit: (value: unknown) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw new Error(`Cannot inspect graph-lock directory ${root}; cache prune aborted: ${errorMessage(error)}`);
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkGraphLocks(path, visit);
    } else if (entry.isFile() && entry.name.endsWith(".graph-lock.json")) {
      try {
        visit(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        throw new Error(`Cannot read graph lock ${path}; cache prune aborted: ${errorMessage(error)}`);
      }
    }
  }
}

async function hasLiveSnapshotLease(snapshotPath: string, dryRun: boolean): Promise<boolean> {
  const directory = dirname(snapshotPath);
  const prefix = `${snapshotPath.slice(directory.length + 1)}${leaseMarker}`;
  const entries = await readdir(directory, { withFileTypes: true });
  let live = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const leasePath = join(directory, entry.name);
    try {
      const value = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: unknown };
      if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
        live = true;
      } else if (isProcessAlive(value.pid)) {
        live = true;
      } else if (!dryRun) {
        await rm(leasePath, { force: true });
      }
    } catch {
      // A lease that cannot be verified is retained fail-closed.
      live = true;
    }
  }
  return live;
}

async function removeStaleMaintenanceLock(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || isProcessAlive(value.pid)) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      && (error as { code?: string }).code !== "ESRCH";
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
