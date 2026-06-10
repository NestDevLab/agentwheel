import { execFile } from "node:child_process";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readPackageManifest } from "../model/package.js";
import { hashPath, pathExists } from "../utils/fs.js";
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
      await mkdir(resolve(resolved.resolvedPath, ".."), { recursive: true });
      if (!(await pathExists(join(resolved.resolvedPath, ".git")))) {
        if (resolved.frozenLock) {
          throw new Error(`Frozen lock requires cached git checkout at ${resolved.resolvedPath}`);
        }
        await rm(resolved.resolvedPath, { recursive: true, force: true });
        await git(["clone", "--no-tags", parsed.url, resolved.resolvedPath]);
      } else if (!resolved.frozenLock) {
        await git(["-C", resolved.resolvedPath, "fetch", "--prune", "origin"]);
      }

      const ref = resolved.requestedRef ?? parsed.ref ?? "HEAD";
      if (ref === "HEAD") {
        await git(["-C", resolved.resolvedPath, "checkout", "--detach", "origin/HEAD"]);
      } else if (/^[0-9a-f]{7,40}$/i.test(ref)) {
        await git(["-C", resolved.resolvedPath, "checkout", "--detach", ref]);
      } else {
        try {
          await git(["-C", resolved.resolvedPath, "checkout", ref]);
          await git(["-C", resolved.resolvedPath, "reset", "--hard", `origin/${ref}`]);
        } catch {
          await git(["-C", resolved.resolvedPath, "checkout", "--detach", ref]);
        }
      }

      const { stdout } = await git(["-C", resolved.resolvedPath, "rev-parse", "HEAD"]);
      const resolvedCommit = stdout.trim();
      const snapshotPath = await snapshotCheckout(resolved.resolvedPath, resolvedCommit);
      const manifest = await readPackageManifest(snapshotPath);
      return {
        ...resolved,
        resolvedPath: snapshotPath,
        packageName: manifest?.name,
        packageVersion: manifest?.version,
        resolvedCommit,
        sourceHash: await hashPath(snapshotPath),
      };
    });
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

async function git(args: string[]) {
  return execFileAsync("git", args, { maxBuffer: 1024 * 1024 * 10 });
}

async function snapshotCheckout(checkoutPath: string, commit: string): Promise<string> {
  const snapshotPath = join(dirname(checkoutPath), `${basename(checkoutPath)}-${commit.slice(0, 12)}`);
  if (await pathExists(snapshotPath)) return snapshotPath;
  const tempPath = join(dirname(checkoutPath), `${basename(snapshotPath)}.tmp-${process.pid}-${Date.now()}`);
  await rm(tempPath, { recursive: true, force: true });
  await cp(checkoutPath, tempPath, { recursive: true, dereference: true });
  await rm(join(tempPath, ".git"), { recursive: true, force: true });
  try {
    await rename(tempPath, snapshotPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await rm(tempPath, { recursive: true, force: true });
    return snapshotPath;
  }
  return snapshotPath;
}

async function withFilesystemLock<T>(lockPath: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for git cache lock at ${lockPath}`);
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
