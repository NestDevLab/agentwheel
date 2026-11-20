import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCombinedInstallPlan, applyCombinedInstallPlan, readInstallManifest, type DesiredArtifact } from "../../src/install/index.js";
import { targetMappingSchema, type AdapterConfig } from "../../src/model/adapter.js";
import { hashPath } from "../../src/utils/fs.js";
import { diffEffects, snapshot } from "../helpers/effects.js";

async function observeStaleMergeAdmission() {
  const root = await mkdtemp(join(tmpdir(), "invariant-i5-"));
  try {
    const sourcePath = join(root, "source.json");
    await writeFile(sourcePath, JSON.stringify({ managed: { value: "current" } }));
    const adapter: AdapterConfig = { name: "synthetic", targets: { settings: {
      local: targetMappingSchema.parse({ enabled: true, dest: "config.json", merge: "json-deep" }),
    } } };
    const artifact: DesiredArtifact = { type: "settings", name: "synthetic", sourcePath, stagedPath: sourcePath,
      relativePath: "source.json", kind: "file", hash: await hashPath(sourcePath), channel: "managed", meta: { dependencyRole: "root", owners: ["synthetic"], logicalSelector: "settings/synthetic" } };
    await applyCombinedInstallPlan(await createCombinedInstallPlan([artifact], adapter, root));
    const manifest = (await readInstallManifest(root, adapter.name))!;
    manifest.entries[0]!.mergeRemoval = { managed: { value: "stale" } };
    // Source hash is unchanged; user-owned fields must survive both admission paths.
    await writeFile(join(root, "config.json"), JSON.stringify({ managed: { value: "current" }, user: { keep: true } }));
    const before = await snapshot(root);
    const preview = await createCombinedInstallPlan([artifact], adapter, root, manifest);
    expect(diffEffects(before, await snapshot(root))).toEqual([]);
    const failure = await applyCombinedInstallPlan(preview).then(() => undefined, error => error);
    return { preview, failure, effects: diffEffects(before, await snapshot(root)) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Expected: preview blocks the same stale contribution that apply rejects.
it.fails("stale_merge_metadata_rejected_in_all_paths", async () => {
  const { preview, failure, effects } = await observeStaleMergeAdmission();
  expect(failure).toBeInstanceOf(Error);
  expect(preview.hasBlockingChanges).toBe(true);
  expect(preview.operations).toEqual(expect.arrayContaining([expect.objectContaining({
    action: "conflict", blockedReason: expect.stringMatching(/contribution|merge/i),
  })]));
  expect(effects).toEqual([]);
});

it("stale_merge_metadata_rejected_in_all_paths_current_defect_skips_preview_but_apply_refuses", async () => {
  const { preview, failure } = await observeStaleMergeAdmission();
  expect(preview.hasBlockingChanges).toBe(false);
  expect(preview.operations).toMatchObject([{ action: "skip" }]);
  expect(preview.operations).toHaveLength(1);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/exact merge contribution/);
});
