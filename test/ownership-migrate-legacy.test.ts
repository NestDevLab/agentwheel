import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { applyMigrateLegacyOwnership as applyRaw, planMigrateLegacyOwnership, type MigrateLegacyOwnershipRequest } from "../src/lifecycle/ownership-migrate-legacy.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../src/model/manifest.js";
import { localTransport } from "../src/transport/index.js";
import { GovernedMutation, recoverMutationRuntime } from "../src/mutation/coordinator.js";

const roots: string[] = [];
const originalState = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  if (originalState === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalState;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sourceKey = "openclaw.user.legacy", destinationKey = "openclaw.user.current";
async function fixture(merge = false) {
  const root = await mkdtemp(join(tmpdir(), "aw-migration-")); roots.push(root);
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(root, "receipts");
  const target = join(root, "target"), workspace = join(root, "workspace");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true });
  await writeFile(join(workspace, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4, packages: [], mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "off" } } }));
  const path = merge ? ".openclaw/openclaw.json" : ".openclaw/skills/example/SKILL.md";
  const live = join(target, path);
  await mkdir(dirname(live), { recursive: true });
  await writeFile(live, merge ? '{"tools":{"allow":["example"]},"userSetting":true}\n' : "Example skill\n");
  const entry: InstallManifestEntry = { path, artifactType: merge ? "settings" : "skills", artifactName: "example", installName: "example",
    kind: "file", hash: merge ? "a".repeat(64) : await localTransport.hashPath(live), sourceHash: "b".repeat(64),
    updatedAt: new Date().toISOString(), channel: "managed", dependencyRole: "root", owners: ["example"], refCount: 1, workspaceOwner: workspaceOwnerForRoot(workspace),
    ...(merge ? { mergeStrategy: "openclaw-json-deep" as const, mergeRemoval: { tools: { allow: ["example"] } } } : {}) };
  const manifest: InstallManifestV2 = { version: 2, adapter: "openclaw", installationType: "user", stateKey: sourceKey,
    targetRoot: target, generatedAt: new Date().toISOString(), revision: "pending-fixture-00", legacy: false, entries: [entry] };
  await writeInstallManifest(manifest);
  const request: MigrateLegacyOwnershipRequest = { targetRoot: target, workspaceRoot: workspace, globalRoot: join(root, "home"), adapter: "openclaw",
    installationType: "user", sourceStateKey: sourceKey, destinationStateKey: destinationKey,
    desiredCoverage: [{ path, artifactType: entry.artifactType, artifactName: "example", kind: "file" }],
    destinationGraphLockPath: join(workspace, ".agentwheel/locks/stable.graph-lock.json") };
  return { root, target, workspace, path, live, entry, manifest, request };
}
async function applyMigrateLegacyOwnership(request: MigrateLegacyOwnershipRequest) {
  const mutation = await GovernedMutation.begin({ workspaceRoot: request.workspaceRoot, globalRoot: request.globalRoot,
    commandName: "agentwheel ownership migrate-legacy", reason: "Verify synthetic metadata migration" });
  try { const result = await applyRaw(request); await mutation?.complete(); return result; }
  catch (error) { await mutation?.fail(error); throw error; }
}
async function reviewed(request: MigrateLegacyOwnershipRequest) {
  const plan = await planMigrateLegacyOwnership(request);
  return { ...request, planDigest: plan.planDigest, expectedSourceRevision: plan.source.revision ?? "absent",
    expectedDestinationRevision: plan.destination.revision ?? "absent", expectedInventoryRevision: plan.manifestInventoryRevision };
}
/** Serves the real manifest for the first `honest` reads of `path`, then a copy with one extra foreign entry. */
function tamperedReads(path: string, honest: number, extra: InstallManifestEntry) {
  let reads = 0;
  return { reads: () => reads, transport: { ...localTransport, async readFile(candidate: string) {
    const raw = await localTransport.readFile(candidate);
    if (candidate !== path || ++reads <= honest) return raw;
    const manifest = JSON.parse(raw);
    return JSON.stringify({ ...manifest, entries: [...manifest.entries, extra] });
  } } };
}
const read = (target: string, key: string) => readInstallManifest(target, "openclaw", localTransport, { installationType: "user", stateKey: key });

describe("current-owner legacy state migration", () => {
  it.each([false, true])("moves exact claims including merge contributions, never runtime bytes (merge=%s)", async merge => {
    const f = await fixture(merge), before = await readFile(f.live);
    const first = await planMigrateLegacyOwnership(f.request);
    expect(await planMigrateLegacyOwnership(f.request)).toEqual(first);
    expect(await read(f.target, destinationKey)).toBeUndefined();
    const result = await applyMigrateLegacyOwnership(await reviewed(f.request));
    expect(result.migratedEntries).toBe(1);
    expect((await read(f.target, destinationKey))?.entries).toEqual([f.entry]);
    expect(await read(f.target, sourceKey)).toBeUndefined();
    expect(await readFile(f.live)).toEqual(before);
    expect((await planMigrateLegacyOwnership(f.request)).selected).toEqual([]);
    expect((await applyMigrateLegacyOwnership(await reviewed(f.request))).migratedEntries).toBe(0);
  });

  it("refuses entries the configured packages no longer install unless the reviewed plan allows them", async () => {
    const f = await fixture();
    const covered = await planMigrateLegacyOwnership(f.request);
    expect(covered.selected).toMatchObject([{ path: f.path, desired: true }]);
    expect(covered.desiredCoverage).toEqual([{ path: f.path, artifactType: "skills", artifactName: "example", kind: "file" }]);
    const undesired = { ...f.request, desiredCoverage: [] };
    await expect(planMigrateLegacyOwnership(undesired)).rejects.toThrow(/no longer install .*--allow-undesired/);
    const allowed = await planMigrateLegacyOwnership({ ...undesired, allowUndesired: true });
    expect(allowed).toMatchObject({ allowUndesired: true, desiredCoverage: [], selected: [{ path: f.path, desired: false }] });
    expect((await planMigrateLegacyOwnership({ ...f.request, allowUndesired: true })).planDigest).not.toBe(covered.planDigest);
    const reviewedAllowed = await reviewed({ ...undesired, allowUndesired: true });
    await expect(applyMigrateLegacyOwnership({ ...reviewedAllowed, allowUndesired: false })).rejects.toThrow(/no longer install/);
    await expect(applyMigrateLegacyOwnership({ ...reviewedAllowed, desiredCoverage: f.request.desiredCoverage })).rejects.toThrow(/Stale plan digest/);
    const other = { ...f.request, desiredCoverage: [{ path: f.path, artifactType: "skills", artifactName: "replacement", kind: "file" }] };
    for (const request of [other, { ...other, allowUndesired: true }]) {
      await expect(planMigrateLegacyOwnership(request)).rejects.toThrow(/plans a different artifact/);
    }
    expect(await read(f.target, destinationKey)).toBeUndefined();
    expect((await applyMigrateLegacyOwnership(reviewedAllowed)).migratedEntries).toBe(1);
  });

  it("refuses a stable graph lock left without a destination manifest", async () => {
    const f = await fixture();
    await mkdir(dirname(f.request.destinationGraphLockPath), { recursive: true });
    await writeFile(f.request.destinationGraphLockPath, "{}");
    await expect(planMigrateLegacyOwnership(f.request))
      .rejects.toThrow(`Destination has a stable graph lock without a stable manifest at ${f.request.destinationGraphLockPath}; reconcile it before migrating legacy state.`);
    await writeInstallManifest({ ...f.manifest, stateKey: destinationKey, entries: [] });
    expect((await planMigrateLegacyOwnership(f.request)).selected).toHaveLength(1);
  });

  it.each(["source", "destination"] as const)("refuses an apply whose re-read %s differs from the reviewed plan", async side => {
    const f = await fixture();
    if (side === "destination") {
      await writeInstallManifest({ ...f.manifest, stateKey: destinationKey, entries: [{ ...f.entry, path: ".openclaw/skills/unrelated/SKILL.md" }] });
    }
    const path = installManifestPath(f.target, "openclaw", { stateKey: side === "source" ? sourceKey : destinationKey });
    const counter = tamperedReads(path, Number.POSITIVE_INFINITY, f.entry);
    await planMigrateLegacyOwnership({ ...f.request, transport: counter.transport });
    const destinationBefore = side === "destination" ? await readFile(path) : undefined;
    const extra = { ...f.entry, path: ".openclaw/skills/injected/SKILL.md", workspaceOwner: "workspace:other" };
    const { transport } = tamperedReads(path, counter.reads(), extra);
    await expect(applyMigrateLegacyOwnership({ ...await reviewed(f.request), transport })).rejects.toThrow(`Stale ${side} revision`);
    expect((await read(f.target, sourceKey))?.entries).toEqual([f.entry]);
    if (destinationBefore) expect(await readFile(path)).toEqual(destinationBefore);
    else expect(await read(f.target, destinationKey)).toBeUndefined();
  });

  it("treats an explicitly selected path that an earlier apply migrated as a no-op", async () => {
    const f = await fixture();
    const foreign = { ...f.entry, path: ".openclaw/skills/other", workspaceOwner: "workspace:other" };
    await writeInstallManifest({ ...f.manifest, entries: [f.entry, foreign] });
    const request = { ...f.request, paths: [f.path] };
    expect((await applyMigrateLegacyOwnership(await reviewed(request))).migratedEntries).toBe(1);
    const rerun = await planMigrateLegacyOwnership(request);
    expect(rerun.selected).toEqual([]);
    expect(rerun.alreadyMigrated).toEqual([{ path: f.path, destinationEntryDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const destination = await readFile(installManifestPath(f.target, "openclaw", { stateKey: destinationKey }));
    expect((await applyMigrateLegacyOwnership(await reviewed(request))).migratedEntries).toBe(0);
    expect(await readFile(installManifestPath(f.target, "openclaw", { stateKey: destinationKey }))).toEqual(destination);
    await expect(planMigrateLegacyOwnership({ ...f.request, paths: [".openclaw/skills/missing"] })).rejects.toThrow(/current workspace/);
    await expect(planMigrateLegacyOwnership({ ...f.request, paths: [foreign.path] })).rejects.toThrow(/current workspace/);
    await writeFile(f.live, "Drift\n");
    await expect(planMigrateLegacyOwnership(request)).rejects.toThrow();
  });

  it("supports unsuffixed source and explicitly configured destination state keys", async () => {
    const f = await fixture();
    await rm(installManifestPath(f.target, "openclaw", { stateKey: sourceKey }));
    await writeInstallManifest({ ...f.manifest, stateKey: "openclaw.user" });
    const request = { ...f.request, sourceStateKey: "openclaw.user", destinationStateKey: "configured-target" };
    await applyMigrateLegacyOwnership(await reviewed(request));
    expect((await read(f.target, "configured-target"))?.entries).toEqual([f.entry]);
  });

  it("preserves foreign entries and refuses explicitly selected foreign ownership", async () => {
    const f = await fixture();
    const foreign = { ...f.entry, path: ".openclaw/skills/other", workspaceOwner: "workspace:other" };
    await writeInstallManifest({ ...f.manifest, entries: [f.entry, foreign] });
    await expect(planMigrateLegacyOwnership({ ...f.request, paths: [foreign.path] })).rejects.toThrow(/current workspace/);
    await applyMigrateLegacyOwnership(await reviewed(f.request));
    expect((await read(f.target, sourceKey))?.entries).toEqual([foreign]);
  });

  it.each([false, true])("rejects runtime drift (merge=%s)", async merge => {
    const f = await fixture(merge);
    await writeFile(f.live, merge ? '{"tools":{"allow":["changed"]}}' : "Changed\n");
    await expect(planMigrateLegacyOwnership(f.request)).rejects.toThrow();
    expect(await read(f.target, destinationKey)).toBeUndefined();
  });

  it("refuses incomplete merge metadata and foreign, duplicate, cross-adapter, and ancestor claims", async () => {
    const f = await fixture(true);
    await writeInstallManifest({ ...f.manifest, entries: [{ ...f.entry, mergeRemoval: undefined }] });
    await expect(planMigrateLegacyOwnership(f.request)).rejects.toThrow(/incomplete merge/);
    await writeInstallManifest(f.manifest);
    for (const other of [ { ...f.entry, workspaceOwner: "workspace:other" }, f.entry, { ...f.entry, path: ".openclaw" } ]) {
      await writeInstallManifest({ ...f.manifest, stateKey: "openclaw.user.other", entries: [other] });
      await expect(planMigrateLegacyOwnership(f.request)).rejects.toThrow(/Conflicting/);
    }
    await rm(installManifestPath(f.target, "openclaw", { stateKey: "openclaw.user.other" }));
    await writeInstallManifest({ ...f.manifest, adapter: "claude", stateKey: "claude.user.other", entries: [f.entry] });
    await expect(planMigrateLegacyOwnership(f.request)).rejects.toThrow(/Conflicting/);
  });

  it("retires exact covered duplicates after destination-first interruption", async () => {
    const f = await fixture(true), before = await readFile(f.live);
    await writeInstallManifest({ ...f.manifest, stateKey: destinationKey });
    expect((await planMigrateLegacyOwnership(f.request)).selected[0]?.action).toBe("retire-covered");
    const destination = await readFile(installManifestPath(f.target, "openclaw", { stateKey: destinationKey }));
    await applyMigrateLegacyOwnership(await reviewed(f.request));
    expect(await readFile(installManifestPath(f.target, "openclaw", { stateKey: destinationKey }))).toEqual(destination);
    expect(await read(f.target, sourceKey)).toBeUndefined();
    expect(await readFile(f.live)).toEqual(before);
  });

  it("refuses even a reviewed local apply without a matching durable receipt", async () => {
    const f = await fixture();
    await expect(applyRaw(await reviewed(f.request))).rejects.toThrow(/durable mutation receipt/);
    expect(await read(f.target, destinationKey)).toBeUndefined();
  });

  it("requires all reviewed values and refuses stale runtime, manifest and inventory", async () => {
    const f = await fixture();
    await expect(applyMigrateLegacyOwnership(f.request)).rejects.toThrow(/reviewed/);
    const request = await reviewed(f.request);
    await writeFile(f.live, "Drift\n");
    await expect(applyMigrateLegacyOwnership(request)).rejects.toThrow();
    await writeFile(f.live, "Example skill\n");
    await writeInstallManifest({ ...f.manifest, stateKey: "openclaw.user.unrelated", entries: [] });
    await expect(applyMigrateLegacyOwnership(request)).rejects.toThrow(/Stale/);
    expect(await read(f.target, destinationKey)).toBeUndefined();
  });

  it("refuses pending journals and recovers a crash after the destination journal write", async () => {
    const f = await fixture(), before = await readFile(f.live);
    let fail = true;
    const transport = { ...localTransport, async writeJsonAtomic(path: string, data: unknown) {
      await localTransport.writeJsonAtomic(path, data);
      if (fail && path.endsWith(".apply-journal.json")) { fail = false; throw new Error("Injected crash"); }
    } };
    const request = await reviewed({ ...f.request, transport });
    await expect(applyMigrateLegacyOwnership(request)).rejects.toThrow(/Injected crash/);
    await expect(planMigrateLegacyOwnership(f.request)).rejects.toThrow(/Pending/);
    const journal = JSON.parse(await readFile(join(f.target, ".agentwheel", `${destinationKey}.apply-journal.json`), "utf8"));
    const recovered = await recoverMutationRuntime(journal.mutation.operationId);
    expect(recovered.runtimeJournals.every(item => item.status === "resolved")).toBe(true);
    await applyMigrateLegacyOwnership(await reviewed(f.request));
    expect(await readFile(f.live)).toEqual(before);
    expect(await read(f.target, sourceKey)).toBeUndefined();
  });
});
