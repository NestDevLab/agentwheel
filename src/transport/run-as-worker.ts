import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { hashPath } from "../utils/fs.js";

export type ReadOperation = "pathExists" | "hashPath" | "readFile" | "listDir";
export interface ReadRequest { version: 1; operation: ReadOperation; path: string }

/** Resolve a relative target path without following symlink components. */
export async function containedReadPath(root: string, requested: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root || !requested || requested.includes("\0") || requested.includes("\\") || isAbsolute(requested)
    || (requested !== "." && requested.split(sep).some((part) => part === ".." || part === "." || part === ""))) {
    throw new Error("Run-as read path is not a contained relative path.");
  }
  let current = parse(root).root;
  for (const part of root.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Run-as root contains a symlink.");
  }
  if (await realpath(root) !== root) throw new Error("Run-as root changed.");
  if (requested === ".") return root;
  current = root;
  for (const part of requested.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Run-as path contains a symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const rel = relative(root, current);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Run-as path escapes target root.");
  return current;
}

async function rejectNestedLinks(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Run-as read path contains a symlink.");
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await rejectNestedLinks(join(path, entry));
}

export async function executeRead(root: string, request: ReadRequest): Promise<unknown> {
  if (request.version !== 1 || !["pathExists", "hashPath", "readFile", "listDir"].includes(request.operation)) {
    throw new Error("Unsupported run-as read protocol request.");
  }
  const path = await containedReadPath(root, request.path);
  let exists = true;
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (request.operation === "pathExists") return exists;
  if (request.operation === "listDir" && !exists) return [];
  if (!exists) throw new Error("Run-as target path does not exist.");
  if (request.operation === "hashPath") {
    await rejectNestedLinks(path);
    return hashPath(path);
  }
  if (request.operation === "readFile") return readFile(path, "utf8");
  return readdir(path);
}

async function main(): Promise<void> {
  const [flagRoot, root, flagUid, rawUid, flagGid, rawGid] = process.argv.slice(2);
  if (flagRoot !== "--root" || flagUid !== "--uid" || flagGid !== "--gid" || !root || !rawUid || !rawGid || process.argv.length !== 8) {
    throw new Error("Invalid run-as worker arguments.");
  }
  const uid = Number(rawUid);
  const gid = Number(rawGid);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0
    || process.getuid?.() !== uid || process.getgid?.() !== gid || (await lstat(root)).uid !== uid) {
    throw new Error("Run-as worker UID or root ownership mismatch.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw new Error("Run-as request exceeds 64 KiB.");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReadRequest;
  const result = await executeRead(root, request);
  process.stdout.write(`${JSON.stringify({ version: 1, result })}\n`);
}

if (process.argv[1] && /run-as-worker\.(?:js|mjs|ts)$/.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`run-as worker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
