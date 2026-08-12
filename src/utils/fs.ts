import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const IGNORED_ENTRY_NAMES = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);
const IGNORED_SUFFIXES = [".pyc", ".pyo"];

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashPath(path: string): Promise<string> {
  const stats = await stat(path);
  if (stats.isFile()) {
    const content = await readFile(path);
    return createHash("sha256").update("file\0").update(content).digest("hex");
  }

  if (!stats.isDirectory()) {
    throw new Error(`Unsupported path kind: ${path}`);
  }

  const hash = createHash("sha256").update("dir\0");
  const files = await listFiles(path);
  for (const file of files) {
    hash.update(relative(path, file).replaceAll("\\", "/")).update("\0");
    hash.update(await hashPath(file)).update("\0");
  }
  return hash.digest("hex");
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredGeneratedEntry(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export function isIgnoredGeneratedEntry(name: string): boolean {
  return IGNORED_ENTRY_NAMES.has(name) || IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export async function atomicCopy(source: string, dest: string, kind: "file" | "dir"): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.agentwheel-tmp-${process.pid}-${Date.now()}`;
  await rm(temp, { recursive: true, force: true });
  if (kind === "file") {
    await copyFile(source, temp);
  } else {
    await cp(source, temp, { recursive: true, dereference: true, filter: (path) => !isIgnoredGeneratedEntry(path.split(/[\\/]/).at(-1) ?? "") });
  }
  await rm(dest, { recursive: true, force: true });
  await rename(temp, dest);
}

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/**
 * Serializes writers that share a cache path across Agentwheel CLI processes.
 * The lock directory is created atomically, so it is safe beyond one Node.js
 * process while still keeping lock ownership inspectable.
 */
export async function withFilesystemLock<T>(
  lockPath: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  description = "cache",
): Promise<T> {
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
        throw new Error(`Timed out waiting for ${description} lock at ${lockPath}`);
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

export function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
