import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageRunAsCopy, validateRunAsCopyPayload } from "../src/transport/run-as-staging.js";
import { hashPath } from "../src/utils/fs.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0; });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "aw-staging-")); roots.push(root); return root; }

describe("run-as source staging", () => {
  it("captures binary files, empty directories and deterministic hashes without source paths or modes", async () => {
    const root = await fixture();
    await mkdir(join(root, "a"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "a", "z"), Buffer.from([0, 255, 13, 10]), { mode: 0o755 });
    await writeFile(join(root, "a.txt"), "text");
    const payload = await stageRunAsCopy(root, "dir", await hashPath(root));
    expect(validateRunAsCopyPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain(root);
    expect(payload.entries.find((entry) => entry.path === "a/z")).toEqual({ path: "a/z", kind: "file", mode: 0o600, content: "AP8NCg==" });
    expect(payload.entries).toContainEqual({ path: "empty", kind: "dir", mode: 0o700 });
  });

  it("refuses stale source hashes, hardlinks, symlinks and wrong root kinds", async () => {
    const root = await fixture();
    const source = join(root, "source");
    await writeFile(source, "old");
    const hash = await hashPath(source);
    await writeFile(source, "new");
    await expect(stageRunAsCopy(source, "file", hash)).rejects.toThrow(/hash mismatch/);
    await expect(stageRunAsCopy(source, "dir", await hashPath(source))).rejects.toThrow(/kind mismatch/);
    await symlink(source, join(root, "symlink"));
    await expect(stageRunAsCopy(join(root, "symlink"), "file", hash)).rejects.toThrow(/links/);
    await link(source, join(root, "hardlink"));
    await expect(stageRunAsCopy(source, "file", hash)).rejects.toThrow(/links/);
  });

  it("validates untrusted payload paths, hierarchy, bytes, modes and duplicate entries before writes", async () => {
    const root = await fixture();
    await writeFile(join(root, "file"), "data");
    const payload = await stageRunAsCopy(root, "dir", await hashPath(root));
    for (const path of ["../escape", "/absolute", "x\\y", "x/./y", "x//y", "x\0y", "missing/file"]) {
      const changed = structuredClone(payload);
      changed.entries[1]!.path = path;
      expect(() => validateRunAsCopyPayload(changed)).toThrow();
    }
    expect(() => validateRunAsCopyPayload({ ...payload, source: "/caller/private" })).toThrow();
    expect(() => validateRunAsCopyPayload({ ...payload, entries: [...payload.entries, payload.entries[1]] })).toThrow(/Duplicate/);
    const changed = structuredClone(payload);
    const file = changed.entries[1]!;
    if (file.kind !== "file") throw new Error("fixture");
    file.content = "ZGF0YQ==!";
    expect(() => validateRunAsCopyPayload(changed)).toThrow(/base64/);
    file.content = Buffer.from("tampered").toString("base64");
    expect(() => validateRunAsCopyPayload(changed)).toThrow(/hash mismatch/);
    expect(() => validateRunAsCopyPayload({ ...payload, entries: [{ ...payload.entries[0], mode: 0o777 }] })).toThrow();
  });

  it("enforces cumulative bytes, entry count, depth and generated-entry filtering", async () => {
    const root = await fixture();
    await writeFile(join(root, "a"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await writeFile(join(root, "b"), Buffer.alloc(4 * 1024 * 1024));
    await expect(stageRunAsCopy(root, "dir", "a".repeat(64))).rejects.toThrow(/size limit/);
    await rm(join(root, "a"));
    await rm(join(root, "b"));
    const deep = "a/".repeat(64) + "file";
    const empty = await stageRunAsCopy(root, "dir", await hashPath(root));
    expect(() => validateRunAsCopyPayload({ ...empty, entries: [...empty.entries, { path: deep, kind: "file", mode: 0o600, content: "" }] })).toThrow(/entry path/);
    expect(() => validateRunAsCopyPayload({ ...empty, entries: Array.from({ length: 4097 }, () => empty.entries[0]) })).toThrow();
    await mkdir(join(root, "node_modules"));
    await symlink("/outside", join(root, "node_modules", "ignored"));
    await writeFile(join(root, "ignored.pyc"), "ignored");
    expect((await stageRunAsCopy(root, "dir", await hashPath(root))).entries).toEqual(empty.entries);
  });

  it("rejects special files without opening them", async () => {
    const root = await fixture();
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    await expect(stageRunAsCopy(fifo, "file", "a".repeat(64))).rejects.toThrow(/special files/);
  });

  it("rejects an oversized file before reading it", async () => {
    const root = await fixture();
    const source = join(root, "large");
    await writeFile(source, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(stageRunAsCopy(source, "file", "a".repeat(64))).rejects.toThrow(/size limit/);
  });
});
