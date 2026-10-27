import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

async function assertSnapshotAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink path is unsupported: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Includes ignored/cache files too: a reviewed release must detect every runtime byte change. */
export async function ownershipRuntimeSnapshot(path: string): Promise<string> {
  await assertSnapshotAncestors(path);
  const hash = createHash("sha256");
  async function visit(candidate: string): Promise<void> {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`Unsupported ownership runtime path: ${candidate}`);
    }
    hash.update(JSON.stringify([relative(path, candidate), info.isDirectory() ? "dir" : "file", info.mode & 0o7777]));
    if (info.isDirectory()) {
      for (const name of (await readdir(candidate)).sort()) await visit(join(candidate, name));
    } else {
      const content = await readFile(candidate);
      hash.update(String(content.length)).update("\0").update(content);
    }
  }
  await visit(path);
  return hash.digest("hex");
}

