import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readPackageManifest } from "../model/package.js";
import {
  hashPath,
  isAlreadyExists,
  pathExists,
  withFilesystemLock,
} from "../utils/fs.js";
import { gitAuthArguments } from "./auth.js";
import {
  createGitSnapshotLease,
  pruneGitCache,
  withGitCacheMaintenanceLock,
} from "./cache.js";
import { LocalSourceDriver } from "./local.js";
import type { ResolvedSource, SourceDriver, SourceResolveOptions } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitSourceDriver implements SourceDriver {
  readonly name = "git";
  private readonly local = new LocalSourceDriver();

  async resolve(source: string, options: SourceResolveOptions = {}): Promise<ResolvedSource> {
    const parsed = parseGitSource(source);
    const requestedRef = options.ref ?? parsed.ref ?? "HEAD";
    const mode = options.mode ?? (parsed.ref ? "pinned" : "tracking");
    return {
      driver: this.name,
      source,
      resolvedPath: cachePathFor(parsed.url, options.cacheRoot),
      mode,
      requestedRef,
      frozenLock: options.frozenLock,
      cacheLockTimeoutMs: options.cacheLockTimeoutMs,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    return withFilesystemLock(`${resolved.resolvedPath}.lock`, resolved.cacheLockTimeoutMs ?? 30_000, async () => {
      const parsed = parseGitSource(resolved.source);
      const cacheRoot = dirname(resolved.resolvedPath);
      await mkdir(cacheRoot, { recursive: true });
      await assertOwnedByCurrentUser(cacheRoot);
      if (await pathExists(resolved.resolvedPath)) await assertOwnedByCurrentUser(resolved.resolvedPath);
      if (!(await pathExists(join(resolved.resolvedPath, ".git")))) {
        if (resolved.frozenLock) {
          throw new Error(`Frozen lock requires cached git checkout at ${resolved.resolvedPath}`);
        }
        await rm(resolved.resolvedPath, { recursive: true, force: true });
        await git([...(await gitAuthArguments(parsed.url)), "clone", "--no-checkout", parsed.url, resolved.resolvedPath]);
        await assertOwnedByCurrentUser(resolved.resolvedPath);
      } else if (!resolved.frozenLock) {
        await git([
          ...(await gitAuthArguments(parsed.url)),
          "-C",
          resolved.resolvedPath,
          "fetch",
          "--tags",
          "--prune",
          "origin",
        ]);
      }

      const ref = resolved.requestedRef ?? parsed.ref ?? "HEAD";
      const resolvedCommit = await resolveCommit(resolved.resolvedPath, ref);
      const snapshot = await withGitCacheMaintenanceLock(
        cacheRoot,
        resolved.cacheLockTimeoutMs ?? 30_000,
        async () => {
          const path = await snapshotCommit(resolved.resolvedPath, resolvedCommit);
          const leasePath = await createGitSnapshotLease(path);
          await pruneGitCache(cacheRoot, {
            currentSnapshot: path,
            maintenanceLockHeld: true,
          });
          return { path, leasePath };
        },
      );
      const snapshotPath = snapshot.path;
      const manifest = await readPackageManifest(snapshotPath);
      return {
        ...resolved,
        resolvedPath: snapshotPath,
        packageName: manifest?.name,
        packageVersion: manifest?.version,
        resolvedCommit,
        sourceHash: await hashPath(snapshotPath),
        cacheLeasePath: snapshot.leasePath,
      };
    }, "git cache");
  }

  async list(resolved: ResolvedSource) {
    return this.local.list({ ...resolved, driver: "local" });
  }

  async scan(resolved: ResolvedSource) {
    return this.local.scan({ ...resolved, driver: "local" });
  }

  async translate(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  async export(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }
}

function parseGitSource(source: string): { url: string; ref?: string } {
  if (source.startsWith("github:")) {
    const rest = source.slice("github:".length);
    const [repo, ref] = rest.split("#", 2);
    if (!repo.includes("/")) throw new Error(`Invalid GitHub source: ${source}`);
    return { url: `https://github.com/${repo}.git`, ref };
  }
  if (source.startsWith("git:")) {
    const rest = source.slice("git:".length);
    const hashIndex = rest.lastIndexOf("#");
    if (hashIndex >= 0) {
      return { url: rest.slice(0, hashIndex), ref: rest.slice(hashIndex + 1) };
    }
    return { url: rest };
  }
  throw new Error(`Invalid git source: ${source}`);
}

function cachePathFor(url: string, cacheRoot?: string): string {
  const root = cacheRoot ? resolve(cacheRoot) : join(homedir(), ".agentwheel", "cache");
  const slug = url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return join(root, slug || basename(url));
}

async function git(args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync("git", args, { env, maxBuffer: 1024 * 1024 * 10 });
}

async function resolveCommit(checkoutPath: string, ref: string): Promise<string> {
  const candidates = ref === "HEAD"
    ? ["origin/HEAD"]
    : /^[0-9a-f]{7,40}$/i.test(ref)
      ? [ref]
      : [`origin/${ref}`, ref];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const { stdout } = await git(["-C", checkoutPath, "rev-parse", "--verify", `${candidate}^{commit}`]);
      return stdout.trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function snapshotCommit(checkoutPath: string, commit: string): Promise<string> {
  const snapshotPath = join(dirname(checkoutPath), `${basename(checkoutPath)}-${commit.slice(0, 12)}`);
  if (await pathExists(snapshotPath)) return snapshotPath;
  const tempPath = join(dirname(checkoutPath), `${basename(snapshotPath)}.tmp-${process.pid}-${Date.now()}`);
  const tempIndexPath = `${tempPath}.index`;
  await rm(tempPath, { recursive: true, force: true });
  await rm(tempIndexPath, { force: true });
  await mkdir(tempPath, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: tempIndexPath };
  try {
    await git(["-C", checkoutPath, "read-tree", commit], env);
    await git(["-C", checkoutPath, "checkout-index", "--all", `--prefix=${resolve(tempPath)}${sep}`], env);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tempIndexPath, { force: true });
  }
  try {
    await rename(tempPath, snapshotPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await rm(tempPath, { recursive: true, force: true });
    return snapshotPath;
  }
  return snapshotPath;
}

async function assertOwnedByCurrentUser(path: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return;
  const ownerUid = (await stat(path)).uid;
  if (ownerUid !== currentUid) {
    throw new Error(
      `Git cache path ${path} is owned by uid ${ownerUid}, but Agentwheel is running as uid ${currentUid}. `
      + "Run Agentwheel as the cache owner or use a separate cache root.",
    );
  }
}
