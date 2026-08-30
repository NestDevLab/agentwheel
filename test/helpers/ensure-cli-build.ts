import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureCliBuild(cli: string): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const key = `agentwheel-test-build-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16)}`;
  const lock = join(tmpdir(), `${key}.lock`);
  const release = await acquireCliBuildLock(lock);
  try {
    if (!(await cliBuildIsFresh(cli, repositoryRoot))) {
      await execFileAsync("pnpm", ["build"], {
        cwd: repositoryRoot,
        maxBuffer: 20 * 1024 * 1024,
      });
    }
  } finally {
    await release();
  }
}

export async function acquireCliBuildLock(
  lock: string,
  timeoutMs = 30_000,
): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner.json"), `${JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await reapStaleCliBuildLock(lock)) continue;
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for CLI test build lock: ${lock}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

async function reapStaleCliBuildLock(lock: string): Promise<boolean> {
  let stale = false;
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid?: unknown };
    stale = typeof owner.pid === "number" && !processIsAlive(owner.pid);
  } catch {
    try {
      stale = Date.now() - (await stat(lock)).mtimeMs > 1_000;
    } catch {
      return false;
    }
  }
  if (!stale) return false;
  const archive = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lock, archive);
    await rm(archive, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      && (error as { code?: string }).code === "EPERM";
  }
}

async function cliBuildIsFresh(cli: string, repositoryRoot: string): Promise<boolean> {
  let builtAt: number;
  try {
    builtAt = (await stat(cli)).mtimeMs;
  } catch {
    return false;
  }
  const inputs = [
    join(repositoryRoot, "src"),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "pnpm-lock.yaml"),
    join(repositoryRoot, "tsconfig.json"),
    join(repositoryRoot, "tsup.config.ts"),
    join(repositoryRoot, "VERSION"),
  ];
  return builtAt >= await newestMtime(inputs);
}

async function newestMtime(paths: string[]): Promise<number> {
  let newest = 0;
  const pending = [...paths];
  while (pending.length > 0) {
    const path = pending.pop()!;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    newest = Math.max(newest, info.mtimeMs);
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(path)) pending.push(join(path, entry));
  }
  return newest;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}
