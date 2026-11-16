import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitManifestMetadataJournal, previewMetadataJournal } from "../src/install/apply.js";
import { exactManagedInstructionBlockSnapshot } from "../src/install/instructions-block.js";
import { readInstallManifest, withManifestRevision, writeInstallManifest } from "../src/install/manifest.js";
import { observeOwnershipRuntime, type ApplyJournal } from "../src/install/transaction.js";
import { installManifestPath } from "../src/install/paths.js";
import { localTransport } from "../src/transport/index.js";

const roots: string[] = [];
const scope = { installationType: "local", stateKey: "fixture.local" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(managedBlock = true, legacyGuard = false) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-metadata-cas-")); roots.push(root);
  const path = join(root, "instructions.md"), body = "Managed guidance.\n";
  const prefix = "x".repeat(8592) + "\n";
  const content = managedBlock
    ? `${prefix}<!-- BEGIN openpack:include fixture sha256:${hash(body)} -->\n${body}<!-- END openpack:include fixture -->\nLocal suffix.\n`
    : "Entire managed file.\n";
  await writeFile(path, content);
  await writeInstallManifest({ version: 2, adapter: "fixture", ...scope, targetRoot: root,
    generatedAt: "2026-01-01T00:00:00.000Z", revision: "pending", legacy: false, entries: legacyGuard ? [{
      path: "instructions.md", artifactType: "instructions", artifactName: "fixture", logicalSelector: "fixture",
      kind: "file", hash: hash(body), sourceHash: hash(body), updatedAt: "2026-01-01T00:00:00.000Z",
      mode: "managed-block",
    }] : [] });
  const before = (await readInstallManifest(root, "fixture", localTransport, scope))!;
  if (before.version !== 2) throw new Error("Expected v2 manifest");
  const exact = managedBlock ? exactManagedInstructionBlockSnapshot(content, "fixture") : undefined;
  const journal: ApplyJournal = {
    version: 1, adapter: "fixture", ...scope, targetRoot: root, mode: "uninstall", baseRevision: before.revision,
    createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", operations: [], completed: [],
    manifest: withManifestRevision({ ...before, generatedAt: "2026-01-02T00:00:00.000Z" }),
    metadataGuards: { inventory: [{ stateKey: scope.stateKey, revision: before.revision }],
      runtime: [{ path: "instructions.md", hash: exact?.hash ?? hash(content),
        snapshotDigest: (await observeOwnershipRuntime(path)).snapshotDigest, ...(exact && !legacyGuard ? { managedBlock: exact } : {}) }] },
  };
  return { root, path, content, body, prefix, journal, manifest: installManifestPath(root, "fixture", scope) };
}

describe("metadata runtime CAS hash domains", () => {
  it.each([true, false])("commits using the correct hash domain (managed block=%s)", async (block) => {
    const f = await fixture(block);
    if (block) {
      expect(Buffer.byteLength(f.prefix)).toBe(8593);
      expect(f.journal.metadataGuards!.runtime[0]!.hash).toBe(hash(f.body));
      expect(hash(f.content)).not.toBe(hash(f.body));
    }
    await expect(commitManifestMetadataJournal(f.journal)).resolves.toMatchObject({ adapter: "fixture" });
    expect(await readFile(f.path, "utf8")).toBe(f.content);
  });

  it("resolves a legacy zero-operation block guard from the verified inventory", async () => {
    const f = await fixture(true, true);
    await expect(previewMetadataJournal(f.journal)).resolves.toMatchObject({ manifestPath: f.manifest });
    await expect(commitManifestMetadataJournal(f.journal)).resolves.toMatchObject({ adapter: "fixture" });
    expect(await readFile(f.path, "utf8")).toBe(f.content);
  });

  it("refuses a preview with any runtime completion record", async () => {
    const f = await fixture();
    f.journal.completed.push({ index: 0, destPath: f.path, kind: "file", hadExisting: true, completed: true });
    await expect(previewMetadataJournal(f.journal)).rejects.toThrow(/zero runtime operations/);
  });

  it.each(["body", "marker", "missing", "prefix", "hash", "snapshot", "inventory", "full-file"])("refuses changed %s without committing metadata", async (change) => {
    const f = await fixture(change !== "full-file");
    const before = await readFile(f.manifest);
    const guard = f.journal.metadataGuards!.runtime[0]!;
    if (change === "body") await writeFile(f.path, f.content.replace(f.body, "Changed guidance.\n"));
    if (change === "marker") await writeFile(f.path, f.content.replace(hash(f.body), "b".repeat(64)));
    if (change === "missing" || change === "full-file") await writeFile(f.path, "Replaced file.\n");
    if (change === "prefix") await writeFile(f.path, "Changed prefix.\n" + f.content);
    // Keep the full-file snapshot current to prove the block/hash CAS independently rejects drift.
    if (["body", "marker", "missing", "prefix", "full-file"].includes(change)) guard.snapshotDigest = (await observeOwnershipRuntime(f.path)).snapshotDigest;
    if (change === "hash") guard.hash = "b".repeat(64);
    if (change === "snapshot") guard.snapshotDigest = "b".repeat(64);
    if (change === "inventory") f.journal.metadataGuards!.inventory.push({ stateKey: "other.local", revision: "b".repeat(64) });
    await expect(commitManifestMetadataJournal(f.journal)).rejects.toThrow(/CAS|drift|marker/i);
    await expect(previewMetadataJournal(f.journal)).rejects.toThrow(/CAS|drift|marker/i);
    expect(await readFile(f.manifest)).toEqual(before);
  });
});
