import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import { isIgnoredGeneratedEntry } from "../utils/fs.js";

// The service-side worker receives bytes, never caller-side source paths.
export const runAsStagingLimits = { bytes: 8 * 1024 * 1024, entries: 4096, depth: 64 } as const;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ path: z.string(), kind: z.literal("file"), mode: z.literal(0o600), content: z.string() }).strict(),
  z.object({ path: z.string(), kind: z.literal("dir"), mode: z.literal(0o700) }).strict(),
]);
const payloadSchema = z.object({
  version: z.literal(1), kind: z.enum(["file", "dir"]), hash: digestSchema,
  entries: z.array(entrySchema).min(1).max(runAsStagingLimits.entries),
}).strict();
export type RunAsCopyPayload = z.infer<typeof payloadSchema>;

function assertEntryPath(path: string): void {
  if (path === "") return;
  if (path.includes("\0") || path.includes("\\") || posix.isAbsolute(path)
    || path.split("/").length > runAsStagingLimits.depth
    || path.split("/").some((part) => !part || part === "." || part === ".." || isIgnoredGeneratedEntry(part))) {
    throw new Error("Invalid run-as staged entry path.");
  }
}

export function hashRunAsCopyPayload(payload: RunAsCopyPayload): string {
  const fileHash = (content: string) => createHash("sha256").update("file\0").update(Buffer.from(content, "base64")).digest("hex");
  if (payload.kind === "file") {
    const root = payload.entries[0]!;
    if (root.kind !== "file") throw new Error("Run-as staged root kind mismatch.");
    return fileHash(root.content);
  }
  const hash = createHash("sha256").update("dir\0");
  // Match hashPath's sorted depth-first file traversal, including nested entries.
  const visit = (directory: string): void => {
    const children = payload.entries.filter((entry) => entry.path !== "" && posix.dirname(entry.path) === (directory || "."))
      .sort((left, right) => posix.basename(left.path).localeCompare(posix.basename(right.path)));
    for (const entry of children) {
      if (entry.kind === "dir") visit(entry.path);
      else hash.update(entry.path).update("\0").update(fileHash(entry.content)).update("\0");
    }
  };
  visit("");
  return hash.digest("hex");
}

/** Validate the complete payload before a future confined worker makes any target write. */
export function validateRunAsCopyPayload(value: unknown): RunAsCopyPayload {
  // Bound encoded bytes as well as decoded content before schema parsing and hashing.
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > runAsStagingLimits.bytes * 2) {
    throw new Error("Run-as staged payload exceeds its size limit.");
  }
  const payload = payloadSchema.parse(value);
  const entries = new Map<string, RunAsCopyPayload["entries"][number]>();
  let bytes = 0;
  for (const entry of payload.entries) {
    assertEntryPath(entry.path);
    if (entries.has(entry.path)) throw new Error("Duplicate run-as staged entry.");
    entries.set(entry.path, entry);
    if (entry.kind === "file") {
      const content = Buffer.from(entry.content, "base64");
      if (content.toString("base64") !== entry.content) throw new Error("Invalid run-as staged base64 content.");
      bytes += content.length;
      if (bytes > runAsStagingLimits.bytes) throw new Error("Run-as staged bytes exceed their size limit.");
    }
  }
  if (entries.get("")?.kind !== payload.kind || (payload.kind === "file" && entries.size !== 1)) {
    throw new Error("Run-as staged root kind mismatch.");
  }
  for (const path of entries.keys()) {
    if (path !== "" && entries.get(posix.dirname(path) === "." ? "" : posix.dirname(path))?.kind !== "dir") {
      throw new Error("Run-as staged entry has no parent directory.");
    }
  }
  if (hashRunAsCopyPayload(payload) !== payload.hash) throw new Error("Run-as staged content hash mismatch.");
  return payload;
}

/**
 * Capture a bounded source snapshot as the caller, with no inherited modes or ownership.
 * Source ancestors belong to the trusted caller staging area and must remain stable.
 * This is byte validation, not a filesystem confinement primitive for target writes.
 */
export async function stageRunAsCopy(source: string, kind: "file" | "dir", expectedHash: string): Promise<RunAsCopyPayload> {
  digestSchema.parse(expectedHash);
  const entries: RunAsCopyPayload["entries"] = [];
  let bytes = 0;
  const visit = async (path: string, relative: string): Promise<void> => {
    assertEntryPath(relative);
    if (entries.length >= runAsStagingLimits.entries) throw new Error("Too many run-as staged entries.");
    const before = await lstat(path);
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (before.isFile() && before.nlink !== 1)) {
      throw new Error("Run-as staging refuses links and special files.");
    }
    if (before.isDirectory()) {
      entries.push({ path: relative, kind: "dir", mode: 0o700 });
      for (const name of (await readdir(path)).sort((a, b) => a.localeCompare(b))) {
        if (!isIgnoredGeneratedEntry(name)) await visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
    } else {
      // O_NOFOLLOW rejects replacement of the final component by a symlink.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new Error("Run-as staging source changed while opening.");
        }
        if (opened.size > runAsStagingLimits.bytes - bytes) throw new Error("Run-as staged bytes exceed their size limit.");
        // A bounded read also handles files that grow after fstat.
        const buffer = Buffer.alloc(runAsStagingLimits.bytes - bytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        bytes += length;
        if (bytes > runAsStagingLimits.bytes) throw new Error("Run-as staged bytes exceed their size limit.");
        entries.push({ path: relative, kind: "file", mode: 0o600, content: buffer.subarray(0, length).toString("base64") });
      } finally {
        await file.close();
      }
    }
  };
  await visit(source, "");
  return validateRunAsCopyPayload({ version: 1, kind, hash: expectedHash, entries });
}
