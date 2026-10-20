import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCombinedInstallPlan, readInstallManifest, recoverPendingApply, writeInstallManifest } from "../src/install/index.js";
import { removeStateFiles } from "../src/install/manifest.js";
import { installManifestPath, stateKeyFor } from "../src/install/paths.js";
import { applyJournalPath } from "../src/install/transaction.js";
import {
  applyAdoptLegacyOwnership,
  desiredCoverageFromPlan,
  planAdoptLegacyOwnership,
  type AdoptLegacyOwnershipPlan,
  type AdoptLegacyOwnershipRequest,
} from "../src/lifecycle/ownership-adopt-legacy.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import { canonicalGraphLockJson, readGraphLock, writeGraphLock } from "../src/model/graph-lock.js";
import type { InstallManifestV2 } from "../src/model/manifest.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import { exactManagedInstructionBlockSnapshot, managedInstructionSelector } from "../src/install/instructions-block.js";
import { ownershipRuntimeSnapshot } from "../src/install/transaction.js";
import { GovernedMutation, recoverMutationRuntime } from "../src/mutation/coordinator.js";

const tempRoots: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
const adapter: AdapterConfig = {
  name: "fixture-runtime",
  targets: {
    skills: { local: { enabled: true, dest: ".runtime/skills", root: "target" } },
    instructions: { local: { enabled: true, dest: ".runtime/AGENTS.md", root: "target", mode: "managed-block" } },
  },
};
const targetKey = "runtime-agent";
const alpha = ".runtime/skills/alpha-skill";
const beta = ".runtime/skills/beta-skill";
const gamma = ".runtime/skills/gamma-skill";
const workspaceSelection = ["skills/alpha-skill", "skills/beta-skill"];
const scope = (stateKey: string) => ({ installationType: "local", stateKey });

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("legacy ownership adoption", () => {
  it("adopts foreign and own legacy ownership so the nested workspace plans updates without force", async () => {
    const fixture = await createFixture();
    await expect(installPlan(fixture)).rejects.toThrow(/another workspace[\s\S]*agentwheel ownership adopt-legacy/);
    const runtimeBefore = await runtimeHashes(fixture, [alpha, beta]);

    const foreign = await planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.scratch));
    expect(foreign.source).toMatchObject({
      stateKey: fixture.legacyKey,
      owner: workspaceOwnerForRoot(fixture.scratch),
      class: "foreign-root",
      provenanceLock: { path: fixture.scratchLock, digest: await lockDigest(fixture.scratchLock) },
    });
    expect(foreign.destination).toMatchObject({
      revision: null,
      owner: workspaceOwnerForRoot(fixture.parent, "delivery"),
      workspaceRoot: fixture.workspace,
    });
    expect(foreign.selected).toMatchObject([{ path: alpha, action: "adopt", drift: false, runtimeHash: runtimeBefore[alpha] }]);
    expect(foreign.retained).toEqual([{ path: beta, owner: workspaceOwnerForRoot(fixture.workspace), reason: "other-owner" }]);
    expect(foreign.remainingDuplicates).toEqual([]);
    await applyAdoptLegacyOwnership(applyRequest(await adoptRequest(fixture, fixture.scratch), foreign));

    const own = await planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.workspace));
    expect(own.source).toMatchObject({ class: "own-legacy-owner", provenanceLock: { path: fixture.workspaceLock } });
    expect(own.selected).toMatchObject([{ path: beta, action: "adopt", drift: false }]);
    expect(own.destination.revision).toMatch(/^[a-f0-9]{64}$/);
    const result = await applyAdoptLegacyOwnership(applyRequest(await adoptRequest(fixture, fixture.workspace), own));
    expect(result).toMatchObject({ applied: true, sourceManifestRemoved: true, adoptedEntries: 1, retainedSourceEntries: 0 });

    await expect(stat(fixture.legacyManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    const destination = await readV2(fixture, (await coverage(fixture)).destinationStateKey);
    expect(destination.entries.map((entry) => [entry.path, entry.workspaceOwner])).toEqual([
      [alpha, workspaceOwnerForRoot(fixture.parent, "delivery")],
      [beta, workspaceOwnerForRoot(fixture.parent, "delivery")],
    ]);
    expect(await runtimeHashes(fixture, [alpha, beta])).toEqual(runtimeBefore);
    expect(await readFile(fixture.scratchLock, "utf8")).toBe(fixture.scratchLockContent);

    const after = await installPlan(fixture);
    expect(actions(after)).toEqual({ [alpha]: "update", [beta]: "update" });
    expect(after.plan.hasBlockingChanges).toBe(false);
  });

  it("adopts into a nested workspace outside any registered Fleet with its plain owner", async () => {
    const fixture = await createFixture({ fleet: false, ownLegacy: false });
    const plan = await planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.scratch));
    expect(plan.destination.owner).toBe(workspaceOwnerForRoot(fixture.workspace));
    expect(plan.selected).toMatchObject([{ path: alpha, action: "adopt" }]);
    await applyAdoptLegacyOwnership(applyRequest(await adoptRequest(fixture, fixture.scratch), plan));
    const after = await installPlan(fixture);
    expect(actions(after)).toEqual({ [alpha]: "update", [beta]: "create" });
    expect(after.plan.hasBlockingChanges).toBe(false);

    await expect(planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.workspace)))
      .rejects.toThrow(/already the destination owner/i);
  });

  it("requires exactly one legacy-named lock that proves every foreign entry", async () => {
    const missing = await createFixture({ ownLegacy: false });
    await rm(missing.scratchLock);
    await expect(planAdoptLegacyOwnership(await adoptRequest(missing, missing.scratch)))
      .rejects.toThrow(/no legacy-named graph lock/i);

    const renamed = await createFixture({ ownLegacy: false });
    await rename(renamed.scratchLock, join(dirname(renamed.scratchLock), `${"c".repeat(64)}.graph-lock.json`));
    await expect(planAdoptLegacyOwnership(await adoptRequest(renamed, renamed.scratch)))
      .rejects.toThrow(/no legacy-named graph lock/i);

    const twice = await createFixture({ ownLegacy: false });
    const copy = legacyLockPath(twice.scratch, twice.fingerprint, "other-agent");
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(twice.scratchLock, copy);
    await expect(planAdoptLegacyOwnership(await adoptRequest(twice, twice.scratch)))
      .rejects.toThrow(/exactly one legacy-named graph lock/i);

    const digest = await createFixture({ ownLegacy: false });
    await patchLegacyEntry(digest, alpha, { graphLockDigest: "e".repeat(64) });
    await expect(planAdoptLegacyOwnership(await adoptRequest(digest, digest.scratch)))
      .rejects.toThrow(/graph-lock digest/i);

    const sourceHash = await createFixture({ ownLegacy: false });
    await patchLegacyEntry(sourceHash, alpha, { sourceHash: "d".repeat(64) });
    await expect(planAdoptLegacyOwnership(await adoptRequest(sourceHash, sourceHash.scratch)))
      .rejects.toThrow(/does not cover/i);
  });

  it("refuses foreign source roots inside a registered Fleet or related to the workspace", async () => {
    const fleetScratch = await createFixture({ ownLegacy: false });
    await writeConfig(fleetScratch.scratch, { schemaVersion: 3, fleetId: "scratch", packages: [fleetPackage()] });
    await writeConfig(fleetScratch.home, {
      schemaVersion: 3,
      fleets: {
        delivery: { root: fleetScratch.parent, requiredPackages: ["core"] },
        scratch: { root: fleetScratch.scratch, requiredPackages: ["core"] },
      },
    });
    await expect(planAdoptLegacyOwnership(await adoptRequest(fleetScratch, fleetScratch.scratch)))
      .rejects.toThrow(/inside registered Fleet 'scratch'/i);

    const plain = await createFixture({ fleet: false, ownLegacy: false });
    await expect(planAdoptLegacyOwnership(await adoptRequest(plain, plain.parent)))
      .rejects.toThrow(/contains or is contained by/i);
    await expect(planAdoptLegacyOwnership(await adoptRequest(plain, join(plain.workspace, "child"))))
      .rejects.toThrow(/contains or is contained by/i);
  });

  it("refuses drift unless it is carried, and carried drift stays visible to install", async () => {
    const fixture = await createFixture();
    const recordedHash = (await readV2(fixture, fixture.legacyKey)).entries.find((entry) => entry.path === alpha)!.hash;
    await writeFile(join(fixture.target, alpha, "LOCAL.md"), "local edit\n");
    const liveHash = await localTransport.hashPath(join(fixture.target, alpha));
    await expect(planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.scratch))).rejects.toThrow(/drifted/i);

    const carried = await planAdoptLegacyOwnership({ ...await adoptRequest(fixture, fixture.scratch), carryDrift: true });
    expect(carried.selected).toMatchObject([{ path: alpha, drift: true, recordedHash, runtimeHash: liveHash }]);
    await applyAdoptLegacyOwnership(applyRequest({ ...await adoptRequest(fixture, fixture.scratch), carryDrift: true }, carried));
    const own = await planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.workspace));
    await applyAdoptLegacyOwnership(applyRequest(await adoptRequest(fixture, fixture.workspace), own));

    const destination = await readV2(fixture, (await coverage(fixture)).destinationStateKey);
    expect(destination.entries.find((entry) => entry.path === alpha)?.hash).toBe(recordedHash);
    expect(actions(await installPlan(fixture))).toEqual({ [alpha]: "drift", [beta]: "update" });

    const missing = await createFixture({ ownLegacy: false });
    await rm(join(missing.target, alpha), { recursive: true });
    await expect(planAdoptLegacyOwnership(await adoptRequest(missing, missing.scratch))).rejects.toThrow(/missing/i);
    const carriedMissing = await planAdoptLegacyOwnership({ ...await adoptRequest(missing, missing.scratch), carryDrift: true });
    expect(carriedMissing.selected).toMatchObject([{ path: alpha, drift: true, runtimeHash: null }]);
  });

  it("retains owned entries the workspace does not desire and refuses when nothing is desired", async () => {
    const fixture = await createFixture({ ownLegacy: false, scratchSkills: ["alpha-skill", "gamma-skill"] });
    const request = await adoptRequest(fixture, fixture.scratch);
    expect(request.desiredCoverage.map((item) => item.path)).toEqual([alpha, beta]);
    const plan = await planAdoptLegacyOwnership(request);
    expect(plan.selected.map((entry) => entry.path)).toEqual([alpha]);
    expect(plan.retained).toEqual([{ path: gamma, owner: workspaceOwnerForRoot(fixture.scratch), reason: "not-desired" }]);
    expect(plan.desiredCoverage.map((item) => item.path)).toEqual([alpha]);
    const result = await applyAdoptLegacyOwnership(applyRequest(request, plan));
    expect(result).toMatchObject({ sourceManifestRemoved: false, retainedSourceEntries: 1 });
    expect((await readV2(fixture, fixture.legacyKey)).entries.map((entry) => entry.path)).toEqual([gamma]);

    await expect(planAdoptLegacyOwnership({ ...request, desiredCoverage: [] })).rejects.toThrow(/nothing to adopt/i);
    const different = await createFixture({ ownLegacy: false });
    const differentRequest = await adoptRequest(different, different.scratch);
    await expect(planAdoptLegacyOwnership({
      ...differentRequest,
      desiredCoverage: differentRequest.desiredCoverage.map((item) => ({ ...item, artifactName: "other-skill" })),
    })).rejects.toThrow(/different artifact/i);
  });

  it("refuses other owners at a selected path and completes same-owner duplicates in a second run", async () => {
    for (const owner of ["workspace-root:/elsewhere", "workspace:unknown"]) {
      const fixture = await createFixture({ ownLegacy: false });
      const legacy = await readV2(fixture, fixture.legacyKey);
      await writeInstallManifest({
        ...legacy,
        stateKey: "fixture-runtime.local.other",
        entries: legacy.entries.map((entry) => ({ ...entry, workspaceOwner: owner })),
      });
      await expect(planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.scratch)))
        .rejects.toThrow(/also claimed by/i);
    }

    const fixture = await createFixture({ ownLegacy: false });
    const second = await seedSecondLegacyState(fixture);
    const first = await planAdoptLegacyOwnership(await adoptRequest(fixture, fixture.scratch));
    expect(first.remainingDuplicates).toEqual([{ stateKey: second.stateKey, path: alpha }]);
    await applyAdoptLegacyOwnership(applyRequest(await adoptRequest(fixture, fixture.scratch), first));
    const destinationKey = (await coverage(fixture)).destinationStateKey;
    const destinationBefore = await readFile(installManifestPath(fixture.target, adapter.name, scope(destinationKey)));

    const secondRequest = { ...await adoptRequest(fixture, fixture.scratch), sourceStateKey: second.stateKey };
    const retire = await planAdoptLegacyOwnership(secondRequest);
    expect(retire.source.provenanceLock.path).toBe(second.lockPath);
    expect(retire.selected).toMatchObject([{ path: alpha, action: "retire-covered" }]);
    expect(retire.selected[0]?.destinationEntryDigest).toMatch(/^[a-f0-9]{64}$/);
    const result = await applyAdoptLegacyOwnership(applyRequest(secondRequest, retire));
    expect(result).toMatchObject({ sourceManifestRemoved: true, adoptedEntries: 0 });
    await expect(stat(installManifestPath(fixture.target, adapter.name, scope(second.stateKey))))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(installManifestPath(fixture.target, adapter.name, scope(destinationKey)))).toEqual(destinationBefore);
  });

  it("refuses a same-owner claim that a follow-up run could not retire", async () => {
    // a migrating install that crashed after writing its stable manifest leaves this non-legacy duplicate
    const stable = await createFixture({ ownLegacy: false });
    const scratchState = await graphPlan(stable, stable.scratch, {
      select: ["skills/alpha-skill"],
      freshGraphOnly: true,
      deferForeignStateCheck: true,
    });
    const legacy = await readV2(stable, stable.legacyKey);
    await writeInstallManifest({
      ...legacy,
      stateKey: scratchState.plan.stateKey!,
      entries: legacy.entries.filter((entry) => entry.path === alpha),
    });
    const scratchInstall = () => graphPlan(stable, stable.scratch, { select: ["skills/alpha-skill"] });
    expect((await scratchInstall()).plan.hasBlockingChanges).toBe(false);
    const legacyBefore = await readFile(stable.legacyManifestPath);
    await expect(planAdoptLegacyOwnership(await adoptRequest(stable, stable.scratch)))
      .rejects.toThrow(/also claimed by .* could not retire: .*no legacy-named graph lock/i);
    expect(await readFile(stable.legacyManifestPath)).toEqual(legacyBefore);
    expect((await scratchInstall()).plan.hasBlockingChanges).toBe(false);

    const changed = await createFixture({ ownLegacy: false });
    const changedSecond = await seedSecondLegacyState(changed);
    await patchManifestEntry(installManifestPath(changed.target, adapter.name, scope(changedSecond.stateKey)), alpha, {
      hash: "f".repeat(64),
    });
    await expect(planAdoptLegacyOwnership(await adoptRequest(changed, changed.scratch)))
      .rejects.toThrow(/could not retire: .*recorded hashes differ/i);

    const unproven = await createFixture({ ownLegacy: false });
    const unprovenSecond = await seedSecondLegacyState(unproven);
    await patchManifestEntry(installManifestPath(unproven.target, adapter.name, scope(unprovenSecond.stateKey)), alpha, {
      graphLockDigest: "e".repeat(64),
    });
    await expect(planAdoptLegacyOwnership(await adoptRequest(unproven, unproven.scratch)))
      .rejects.toThrow(/could not retire: .*graph-lock digest/i);
  });

  it("refuses unsafe destination state and Fleet targets", async () => {
    const foreign = await createFixture({ ownLegacy: false });
    const legacy = await readV2(foreign, foreign.legacyKey);
    const destinationKey = (await coverage(foreign)).destinationStateKey;
    await writeInstallManifest({
      ...legacy,
      stateKey: destinationKey,
      entries: legacy.entries.map((entry) => ({ ...entry, workspaceOwner: "workspace-root:/elsewhere" })),
    });
    await expect(planAdoptLegacyOwnership(await adoptRequest(foreign, foreign.scratch)))
      .rejects.toThrow(/destination state at .*alpha-skill/i);

    const lockOnly = await createFixture({ ownLegacy: false });
    const lockOnlyRequest = await adoptRequest(lockOnly, lockOnly.scratch);
    await mkdir(dirname(lockOnlyRequest.destinationGraphLockPath), { recursive: true });
    await copyFile(lockOnly.scratchLock, lockOnlyRequest.destinationGraphLockPath);
    await expect(planAdoptLegacyOwnership(lockOnlyRequest)).rejects.toThrow(/stable graph lock without a stable manifest/i);

    const fleet = await createFixture({ ownLegacy: false });
    await expect(planAdoptLegacyOwnership({ ...await adoptRequest(fleet, fleet.scratch), destinationFleetId: "delivery" }))
      .rejects.toThrow(/Fleet target/i);
  });

  it("plans run-as legacy claims through the transport without enabling adoption", async () => {
    const fixture = await createFixture({ ownLegacy: false });
    const request = await adoptRequest(fixture, fixture.scratch);
    const reads: string[] = [];
    const noWrite = async () => { throw new Error("unexpected target write"); };
    const transport: TargetTransport = {
      ...localTransport, kind: "local-run-as", description: "local-run-as://service:998@fixture",
      readFile: async (path) => { reads.push(path); return localTransport.readFile(path); },
      mkdirExclusive: noWrite, writeFileAtomic: noWrite, writeJsonAtomic: noWrite, atomicCopy: noWrite, rm: noWrite,
    };
    const local = await planAdoptLegacyOwnership(request);
    const plan = await planAdoptLegacyOwnership({ ...request, transport });
    expect(plan.selected).toEqual(local.selected);
    expect(plan.planDigest).not.toBe(local.planDigest);
    expect(reads).toContain(fixture.legacyManifestPath);
    const otherIdentity = await planAdoptLegacyOwnership({ ...request, transport: { ...transport, description: "local-run-as://service:999@fixture" } });
    expect(otherIdentity.planDigest).not.toBe(plan.planDigest);
    await expect(applyAdoptLegacyOwnership({ ...applyRequest(request, plan), transport }))
      .rejects.toThrow(/requires a local filesystem transport/);
  });

  it("refuses unsupported source state before selecting entries", async () => {
    const fixture = await createFixture({ ownLegacy: false });
    const request = await adoptRequest(fixture, fixture.scratch);
    await expect(planAdoptLegacyOwnership({ ...request, transport: { ...localTransport, kind: "ssh" } }))
      .rejects.toThrow(/SSH/);
    await expect(planAdoptLegacyOwnership({ ...request, sourceStateKey: "fixture-runtime.local.not-a-fingerprint" }))
      .rejects.toThrow(/legacy state key/i);
    await expect(planAdoptLegacyOwnership({ ...request, sourceStateKey: request.destinationStateKey }))
      .rejects.toThrow(/legacy state key|must differ/i);

    for (const patch of [
      { mode: "managed-block" },
      { mergeStrategy: "json-deep", mergeRemoval: { managed: true } },
      { semanticCommand: ["fixture"] },
      { executed: true },
    ]) {
      const categorized = await createFixture({ ownLegacy: false });
      await patchLegacyEntry(categorized, alpha, patch);
      await expect(planAdoptLegacyOwnership(await adoptRequest(categorized, categorized.scratch)))
        .rejects.toThrow(/plain file or directory/i);
    }

    const adapterCode = await createFixture({ ownLegacy: false });
    const raw = JSON.parse(await readFile(adapterCode.legacyManifestPath, "utf8"));
    raw.adapterCode = { modulePath: "adapter.mjs", hash: "a".repeat(64) };
    await writeFile(adapterCode.legacyManifestPath, JSON.stringify(raw));
    await expect(planAdoptLegacyOwnership(await adoptRequest(adapterCode, adapterCode.scratch)))
      .rejects.toThrow(/adapter code/i);

    const mixed = await createFixture({ ownLegacy: false });
    await patchLegacyEntry(mixed, alpha, { workspaceOwner: workspaceOwnerForRoot(mixed.parent, "delivery") });
    await expect(planAdoptLegacyOwnership(await adoptRequest(mixed, mixed.scratch)))
      .rejects.toThrow(/already owned by the destination/i);
  });

  it("fails closed on stale review values, runtime changes under the lock, and pending journals", async () => {
    const fixture = await createFixture({ ownLegacy: false });
    const request = await adoptRequest(fixture, fixture.scratch);
    const plan = await planAdoptLegacyOwnership(request);
    const reviewed = applyRequest(request, plan);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, planDigest: undefined })).rejects.toThrow(/reviewed lowercase SHA-256 plan digest/i);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, planDigest: "0".repeat(64) })).rejects.toThrow(/plan digest/i);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, expectedSourceRevision: "0".repeat(64) }))
      .rejects.toThrow(/source manifest revision/i);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, expectedDestinationRevision: "0".repeat(64) }))
      .rejects.toThrow(/destination manifest revision/i);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, expectedInventoryRevision: "0".repeat(64) }))
      .rejects.toThrow(/inventory revision/i);

    let injected = false;
    const transport: TargetTransport = {
      ...localTransport,
      mkdirExclusive: async (path) => {
        await localTransport.mkdirExclusive(path);
        if (!injected && path.endsWith(".runtime-apply-lock")) {
          injected = true;
          await writeFile(join(fixture.target, alpha, "LOCAL.md"), "concurrent edit\n");
        }
      },
    };
    const sourceBefore = await readFile(fixture.legacyManifestPath);
    await expect(applyAdoptLegacyOwnership({ ...reviewed, transport })).rejects.toThrow(/drifted/i);
    expect(await readFile(fixture.legacyManifestPath)).toEqual(sourceBefore);
    await expect(stat(installManifestPath(fixture.target, adapter.name, scope(request.destinationStateKey))))
      .rejects.toMatchObject({ code: "ENOENT" });

    const pending = await createFixture({ ownLegacy: false });
    const pendingRequest = await adoptRequest(pending, pending.scratch);
    const pendingPlan = await planAdoptLegacyOwnership(pendingRequest);
    await localTransport.writeJsonAtomic(applyJournalPath(pending.target, adapter.name, scope("fixture-runtime.local.other")), {
      version: 1,
      adapter: adapter.name,
      installationType: "local",
      stateKey: "fixture-runtime.local.other",
      targetRoot: pending.target,
      baseRevision: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      operations: [],
      completed: [],
      manifest: { ...await readV2(pending, pending.legacyKey), stateKey: "fixture-runtime.local.other", entries: [] },
    });
    await expect(applyAdoptLegacyOwnership(applyRequest(pendingRequest, pendingPlan))).rejects.toThrow(/journal.*pending/i);
    await expect(planAdoptLegacyOwnership(pendingRequest)).rejects.toThrow(/journal.*pending/i);
  });

  it("completes after a crash following the destination commit and then reports nothing to adopt", async () => {
    const fixture = await createFixture({ ownLegacy: false });
    const request = await adoptRequest(fixture, fixture.scratch);
    const destinationManifestPath = installManifestPath(fixture.target, adapter.name, scope(request.destinationStateKey));
    const plan = await planAdoptLegacyOwnership(request);
    let injected = false;
    const transport: TargetTransport = {
      ...localTransport,
      writeJsonAtomic: async (path, value) => {
        await localTransport.writeJsonAtomic(path, value);
        if (!injected && path === destinationManifestPath) {
          injected = true;
          throw new Error("injected after destination manifest write");
        }
      },
    };
    await expect(applyAdoptLegacyOwnership({ ...applyRequest(request, plan), transport }))
      .rejects.toThrow(/injected after destination manifest write/i);
    await expect(stat(applyJournalPath(fixture.target, adapter.name, scope(request.destinationStateKey)))).resolves.toBeTruthy();
    const recovered = await recoverPendingApply(fixture.target, adapter.name, localTransport, scope(request.destinationStateKey));
    expect(recovered?.entries.map((entry) => entry.path)).toEqual([alpha]);
    await expect(stat(fixture.legacyManifestPath)).resolves.toBeTruthy();

    const rerun = await planAdoptLegacyOwnership(request);
    expect(rerun.selected).toMatchObject([{ path: alpha, action: "retire-covered" }]);
    const result = await applyAdoptLegacyOwnership(applyRequest(request, rerun));
    expect(result.sourceManifestRemoved).toBe(true);
    await expect(planAdoptLegacyOwnership(request)).rejects.toThrow(/nothing to adopt/i);
    expect(actions(await installPlan(fixture))).toEqual({ [alpha]: "update", [beta]: "create" });
  });
});

interface Fixture {
  home: string;
  parent: string;
  workspace: string;
  scratch: string;
  target: string;
  pack: string;
  fingerprint: string;
  legacyKey: string;
  legacyManifestPath: string;
  scratchLock: string;
  scratchLockContent: string;
  workspaceLock?: string;
}

async function createFixture(options: { fleet?: boolean; ownLegacy?: boolean; scratchSkills?: string[] } = {}): Promise<Fixture> {
  const home = await tempRoot("agentwheel-adopt-home-");
  isolateProcessRoots(home);
  const parent = await tempRoot("agentwheel-adopt-fleet-");
  const workspace = join(parent, "profiles", "nested");
  const scratch = await tempRoot("agentwheel-adopt-scratch-");
  const target = await tempRoot("agentwheel-adopt-target-");
  const pack = await tempRoot("agentwheel-adopt-pack-");
  await mkdir(workspace, { recursive: true });
  await writeConfig(home, { schemaVersion: 2 });
  await writePack(pack, "ONE");
  const base = { home, parent, workspace, scratch, target, pack };

  const scratchPlan = await graphPlan(base, scratch, {
    select: (options.scratchSkills ?? ["alpha-skill"]).map((name) => `skills/${name}`),
  });
  const fingerprint = scratchPlan.targetFingerprint;
  const legacyKey = stateKeyFor(adapter.name, { installationType: "local", targetFingerprint: fingerprint });
  const scratchLock = legacyLockPath(scratch, fingerprint);
  await seedPlan(scratchPlan, legacyKey, scratchLock);

  let workspaceLock: string | undefined;
  if (options.ownLegacy ?? options.fleet !== false) {
    // before Fleet registration this workspace wrote a plain owner into the same fingerprint key
    const workspacePlan = await graphPlan(base, workspace, { select: ["skills/beta-skill"], deferForeignStateCheck: true });
    expect(workspacePlan.targetFingerprint).toBe(fingerprint);
    workspaceLock = legacyLockPath(workspace, fingerprint);
    const seedKey = "fixture-runtime.local.seed";
    await seedPlan(workspacePlan, seedKey, workspaceLock);
    const legacy = await readV2({ target }, legacyKey);
    const seeded = await readV2({ target }, seedKey);
    await writeInstallManifest({ ...legacy, entries: [...legacy.entries, ...seeded.entries] });
    await removeStateFiles(target, adapter.name, localTransport, scope(seedKey));
  }
  if (options.fleet !== false) {
    await writeConfig(parent, { schemaVersion: 3, fleetId: "delivery", packages: [fleetPackage()] });
    await writeConfig(home, { schemaVersion: 3, fleets: { delivery: { root: parent, requiredPackages: ["core"] } } });
  }
  await writePack(pack, "TWO");
  return {
    ...base,
    fingerprint,
    legacyKey,
    legacyManifestPath: installManifestPath(target, adapter.name, scope(legacyKey)),
    scratchLock,
    scratchLockContent: await readFile(scratchLock, "utf8"),
    workspaceLock,
  };
}

async function seedPlan(result: Awaited<ReturnType<typeof graphPlan>>, stateKey: string, lockPath: string): Promise<void> {
  // old releases keyed state and graph locks by target fingerprint only
  await applyCombinedInstallPlan(
    { ...result.plan, stateKey, baseRevision: null, targetStateFilePreconditions: undefined },
    { transport: localTransport, graphLockDigest: result.graphLockDigest, graphLock: { path: lockPath, lock: result.bundle.graphLock } },
  );
}

async function seedSecondLegacyState(fixture: Fixture): Promise<{ stateKey: string; lockPath: string }> {
  const fingerprint = createHash("sha256").update("second legacy target").digest("hex");
  const lock = await readGraphLock(fixture.scratchLock);
  const lockPath = legacyLockPath(fixture.scratch, fingerprint, "other-agent");
  const secondLock = { ...lock, canonical: { ...lock.canonical, targetFingerprint: fingerprint } };
  await writeGraphLock(lockPath, secondLock);
  const stateKey = stateKeyFor(adapter.name, { installationType: "local", targetFingerprint: fingerprint });
  const legacy = await readV2(fixture, fixture.legacyKey);
  const digest = createHash("sha256").update(canonicalGraphLockJson(secondLock)).digest("hex");
  await writeInstallManifest({
    ...legacy,
    stateKey,
    entries: legacy.entries.filter((entry) => entry.path === alpha).map((entry) => ({ ...entry, graphLockDigest: digest })),
  });
  return { stateKey, lockPath };
}

type FixtureRoots = Pick<Fixture, "home" | "target" | "pack">;

function graphPlan(
  fixture: FixtureRoots,
  workspaceRoot: string,
  options: { select?: string[]; freshGraphOnly?: boolean; deferForeignStateCheck?: boolean } = {},
) {
  return createGraphSourcePlan({
    roots: [{ rootId: "fixture", source: fixture.pack, mode: "pinned", select: options.select }],
    targetRoot: fixture.target,
    workspaceRoot,
    globalRoot: fixture.home,
    adapter,
    transport: localTransport,
    installationType: "local",
    targetKey,
    targetFingerprintParts: {
      adapter: adapter.name,
      installationType: "local",
      agentName: targetKey,
      targetRoot: fixture.target,
      transport: "local",
    },
    trustStorePath: join(fixture.home, ".agentwheel", "trust.json"),
    readOnly: true,
    isTTY: false,
    freshGraphOnly: options.freshGraphOnly,
    deferForeignStateCheck: options.deferForeignStateCheck,
  });
}

function installPlan(fixture: Fixture) {
  return graphPlan(fixture, fixture.workspace, { select: workspaceSelection });
}

async function coverage(fixture: Fixture) {
  const result = await graphPlan(fixture, fixture.workspace, {
    select: workspaceSelection,
    freshGraphOnly: true,
    deferForeignStateCheck: true,
  });
  return {
    desiredCoverage: desiredCoverageFromPlan(result.plan),
    destinationStateKey: result.plan.stateKey!,
    destinationGraphLockPath: result.graphLockPath,
  };
}

async function adoptRequest(fixture: Fixture, fromWorkspaceRoot: string): Promise<AdoptLegacyOwnershipRequest> {
  return {
    targetRoot: fixture.target,
    adapter: adapter.name,
    installationType: "local",
    sourceStateKey: fixture.legacyKey,
    fromWorkspaceRoot,
    workspaceRoot: fixture.workspace,
    globalRoot: fixture.home,
    ...await coverage(fixture),
  };
}

function applyRequest(request: AdoptLegacyOwnershipRequest, plan: AdoptLegacyOwnershipPlan): AdoptLegacyOwnershipRequest {
  return {
    ...request,
    planDigest: plan.planDigest,
    expectedSourceRevision: plan.source.revision,
    expectedDestinationRevision: plan.destination.revision ?? "absent",
    expectedInventoryRevision: plan.manifestInventoryRevision,
  };
}

function actions(result: Awaited<ReturnType<typeof graphPlan>>): Record<string, string> {
  return Object.fromEntries(result.plan.operations.map((operation) => [operation.relativeDestPath, operation.action]));
}

async function runtimeHashes(fixture: Fixture, paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await localTransport.hashPath(join(fixture.target, path))])));
}

async function readV2(fixture: Pick<Fixture, "target">, stateKey: string): Promise<InstallManifestV2> {
  const manifest = await readInstallManifest(fixture.target, adapter.name, localTransport, scope(stateKey));
  if (!manifest || manifest.version !== 2) throw new Error(`missing v2 manifest ${stateKey}`);
  return manifest;
}

async function patchLegacyEntry(fixture: Fixture, path: string, patch: Record<string, unknown>): Promise<void> {
  await patchManifestEntry(fixture.legacyManifestPath, path, patch);
}

async function patchManifestEntry(manifestPath: string, path: string, patch: Record<string, unknown>): Promise<void> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  raw.entries = raw.entries.map((entry: { path: string }) => entry.path === path ? { ...entry, ...patch } : entry);
  await writeFile(manifestPath, JSON.stringify(raw));
}

async function lockDigest(path: string): Promise<string> {
  return createHash("sha256").update(canonicalGraphLockJson(await readGraphLock(path))).digest("hex");
}

function legacyLockPath(workspaceRoot: string, fingerprint: string, agent = targetKey): string {
  return join(workspaceRoot, ".agentwheel", "locks", agent, adapter.name, `${fingerprint}.graph-lock.json`);
}

async function writePack(root: string, marker: string): Promise<void> {
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture/adopt-legacy",
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`);
  for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), [
      "---",
      `name: ${name}`,
      "description: Fixture skill for legacy ownership adoption.",
      "---",
      "",
      `Version ${marker}.`,
      "",
    ].join("\n"));
  }
}

function fleetPackage() {
  return { name: "core", source: "/packages/core", driver: "local", adapter: "codex", mode: "pinned" };
}

async function writeConfig(root: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, ".agentwheel"), { recursive: true });
  await writeFile(join(root, ".agentwheel", "config.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function isolateProcessRoots(globalRoot: string): void {
  const roots: Record<string, string> = {
    HOME: join(globalRoot, "home"),
    XDG_CONFIG_HOME: join(globalRoot, "xdg-config"),
    XDG_CACHE_HOME: join(globalRoot, "xdg-cache"),
    XDG_STATE_HOME: join(globalRoot, "xdg-state"),
    AGENTWHEEL_TEST_HOME: join(globalRoot, "home"),
    AGENTWHEEL_TRUST_STORE: join(globalRoot, "agentwheel", "trust.json"),
    AGENTWHEEL_AUTH_CONFIG: join(globalRoot, "agentwheel", "auth.json"),
    AGENTWHEEL_MUTATION_STATE_ROOT: join(globalRoot, "agentwheel", "mutations"),
  };
  for (const [key, value] of Object.entries(roots)) {
    if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

describe("coherent managed-block legacy adoption", () => {
  it("uses a worker snapshot for run-as managed blocks and refuses a missing snapshot capability", async () => {
    const f = await managedFixture();
    const snapshots: string[] = [];
    const transport: TargetTransport = {
      ...localTransport, kind: "local-run-as", description: "local-run-as://service:998@fixture",
      ownershipSnapshot: async (path) => { snapshots.push(path); return ownershipRuntimeSnapshot(path); },
    };
    const plan = await planAdoptLegacyOwnership({ ...f.request, transport });
    expect(snapshots).toEqual([f.file]);
    expect(plan.selected[0]!.runtimeSnapshotDigest).toBe(await ownershipRuntimeSnapshot(f.file));
    await expect(planAdoptLegacyOwnership({ ...f.request, transport: { ...transport, ownershipSnapshot: undefined } }))
      .rejects.toThrow(/service-user runtime snapshot/);
  });

  it("moves metadata while preserving block hash, full file, prefix, suffix, mode and legacy lock", async () => {
    const f = await managedFixture();
    const before = await readFile(f.file);
    const snapshot = await ownershipRuntimeSnapshot(f.file);
    const lockBefore = await readFile(f.legacyLock);
    const mode = (await stat(f.file)).mode;
    const plan = await planAdoptLegacyOwnership(f.request);
    expect(plan.selected[0]).toMatchObject({ drift: false, recordedHash: f.entry.hash, managedBlock: { hash: f.entry.hash } });
    expect(plan.selected[0]!.runtimeHash).not.toBe(f.entry.hash);
    expect(plan.selected[0]!.managedBlock!.prefixHash).toBe(sha(f.prefix));
    expect(plan.selected[0]!.managedBlock!.suffixHash).toBe(sha(f.suffix));
    await applyAdoptLegacyOwnership(applyRequest(f.request, plan));
    const destination = await readV2({ target: f.target }, f.request.destinationStateKey);
    expect(destination.entries).toEqual([{ ...f.entry, workspaceOwner: workspaceOwnerForRoot(f.parent, "delivery") }]);
    expect(await readFile(f.file)).toEqual(before);
    expect(await ownershipRuntimeSnapshot(f.file)).toBe(snapshot);
    expect((await stat(f.file)).mode).toBe(mode);
    expect(await readFile(f.legacyLock)).toEqual(lockBefore);
    // A later source version is a separate update; adoption does not rewrite or bless it.
    const ordinary = await graphPlan(f, f.workspace, { select: ["instructions/AGENTS.md"] });
    expect(ordinary.plan.operations.map((operation) => operation.action)).toEqual(["update"]);
    expect(ordinary.plan.hasBlockingChanges).toBe(false);
    expect(await readFile(f.file)).toEqual(before);
  });

  it("plans without any runtime, manifest or lock writes", async () => {
    const f = await managedFixture();
    const runtimeBefore = await readFile(f.file);
    const manifestBefore = await readFile(f.manifest);
    const lockBefore = await readFile(f.legacyLock);
    const one = await planAdoptLegacyOwnership(f.request);
    expect(await planAdoptLegacyOwnership(f.request)).toEqual(one);
    expect(await readFile(f.file)).toEqual(runtimeBefore);
    expect(await readFile(f.manifest)).toEqual(manifestBefore);
    expect(await readFile(f.legacyLock)).toEqual(lockBefore);
    await expect(stat(installManifestPath(f.target, adapter.name, scope(f.request.destinationStateKey))))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["body", "marker", "recorded", "missing-end", "duplicate", "incomplete-duplicate", "overlap", "selector", "carry"])("rejects %s inconsistencies without repairs", async (kind) => {
    const f = await managedFixture();
    let text = await readFile(f.file, "utf8");
    if (kind === "body") text = text.replace("Historical body.", "Edited historical body.");
    if (kind === "marker") text = text.replace(`sha256:${f.entry.hash}`, `sha256:${"0".repeat(64)}`);
    if (kind === "missing-end") text = text.replace(`<!-- END openpack:include ${f.selector} -->`, "");
    if (kind === "duplicate") text += f.block;
    if (kind === "incomplete-duplicate") text += `<!-- BEGIN openpack:include ${f.selector} sha256:incomplete`;
    if (kind === "overlap") text = `<!-- BEGIN openpack:include instructions/outer.md sha256:${"a".repeat(64)} -->\n${text}<!-- END openpack:include instructions/outer.md -->\n`;
    if (kind === "selector") text = text.replaceAll(f.selector, "instructions/another.md");
    await writeFile(f.file, text);
    if (kind === "recorded") await patchManifestEntry(f.manifest, ".runtime/AGENTS.md", { hash: "f".repeat(64) });
    const runtimeBefore = await readFile(f.file);
    const manifestBefore = await readFile(f.manifest);
    await expect(planAdoptLegacyOwnership({ ...f.request, carryDrift: kind === "carry" }))
      .rejects.toThrow(/block|marker|hash|drift/i);
    expect(await readFile(f.file)).toEqual(runtimeBefore);
    expect(await readFile(f.manifest)).toEqual(manifestBefore);
  });

  it.each(["prefix", "suffix", "mode", "inventory"])("refuses a stale reviewed %s snapshot before manifest writes", async (kind) => {
    const f = await managedFixture();
    const plan = await planAdoptLegacyOwnership(f.request);
    if (kind === "prefix") await writeFile(f.file, `New prefix\n${await readFile(f.file, "utf8")}`);
    if (kind === "suffix") await writeFile(f.file, `${await readFile(f.file, "utf8")}New suffix\n`);
    if (kind === "mode") await chmod(f.file, 0o600);
    if (kind === "inventory") await writeInstallManifest({ ...await readV2({ target: f.target }, f.request.sourceStateKey), adapter: "other", stateKey: "other.local", entries: [] });
    const before = await readFile(f.manifest);
    await expect(applyAdoptLegacyOwnership(applyRequest(f.request, plan))).rejects.toThrow(/plan digest|revision|CAS/i);
    expect(await readFile(f.manifest)).toEqual(before);
  });

  it.each(["same-adapter", "other-adapter", "ancestor"])("rejects %s overlapping claims", async (kind) => {
    const f = await managedFixture();
    const source = await readV2({ target: f.target }, f.request.sourceStateKey);
    await writeInstallManifest({ ...source,
      adapter: kind === "other-adapter" ? "other" : adapter.name,
      stateKey: kind === "other-adapter" ? "other.local" : `${adapter.name}.local.duplicate`,
      entries: [{ ...f.entry, ...(kind === "ancestor" ? { path: ".runtime", kind: "dir", mode: undefined } : {}) }],
    });
    await expect(planAdoptLegacyOwnership(f.request)).rejects.toThrow(/overlapping|duplicate/i);
  });

  it("does not retire a source against a destination with different recorded metadata", async () => {
    const f = await managedFixture();
    const source = await readV2({ target: f.target }, f.request.sourceStateKey);
    await writeInstallManifest({ ...source, stateKey: f.request.destinationStateKey,
      entries: [{ ...f.entry, workspaceOwner: workspaceOwnerForRoot(f.parent, "delivery"), owners: ["different-root"], refCount: 1 }],
    });
    await expect(planAdoptLegacyOwnership(f.request)).rejects.toThrow(/not an exact copy/i);
  });

  it.each(["before", "after"])("recovers an interrupted %s-destination write and then retires the exact source copy", async (when) => {
    const f = await managedFixture();
    const before = await readFile(f.file);
    const plan = await planAdoptLegacyOwnership(f.request);
    const destinationPath = installManifestPath(f.target, adapter.name, scope(f.request.destinationStateKey));
    let injected = false;
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      if (path === destinationPath && !injected && when === "before") { injected = true; throw new Error("interrupted destination"); }
      await localTransport.writeJsonAtomic(path, value);
      if (path === destinationPath && !injected && when === "after") { injected = true; throw new Error("interrupted destination"); }
    } };
    await expect(applyAdoptLegacyOwnership({ ...applyRequest(f.request, plan), transport })).rejects.toThrow(/interrupted/);
    await recoverPendingApply(f.target, adapter.name, localTransport, scope(f.request.destinationStateKey));
    const rerun = await planAdoptLegacyOwnership(f.request);
    expect(rerun.selected[0]!.action).toBe("retire-covered");
    await applyAdoptLegacyOwnership(applyRequest(f.request, rerun));
    expect((await readV2({ target: f.target }, f.request.destinationStateKey)).entries[0]!.hash).toBe(f.entry.hash);
    expect(await readFile(f.file)).toEqual(before);
  });

  it("recovers a source-removal interruption using exact before/after inventory CAS", async () => {
    const f = await managedFixture();
    const plan = await planAdoptLegacyOwnership(f.request);
    const transport: TargetTransport = { ...localTransport, rm: async (path) => {
      await localTransport.rm(path);
      if (path === f.manifest) throw new Error("interrupted source removal");
    } };
    await expect(applyAdoptLegacyOwnership({ ...applyRequest(f.request, plan), transport })).rejects.toThrow(/interrupted source/);
    await recoverPendingApply(f.target, adapter.name, localTransport, scope(f.request.sourceStateKey));
    await expect(stat(f.manifest)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.file, "utf8")).toBe(f.prefix + f.block + f.suffix);
  });

  it.each(["prefix", "mode", "inventory"])("preserves concurrent %s changes rather than replaying a partial transaction", async (kind) => {
    const f = await managedFixture();
    const plan = await planAdoptLegacyOwnership(f.request);
    const destinationPath = installManifestPath(f.target, adapter.name, scope(f.request.destinationStateKey));
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      await localTransport.writeJsonAtomic(path, value);
      if (path === destinationPath) throw new Error("interrupt after destination");
    } };
    await expect(applyAdoptLegacyOwnership({ ...applyRequest(f.request, plan), transport })).rejects.toThrow(/interrupt/);
    if (kind === "prefix") await writeFile(f.file, `Concurrent prefix\n${await readFile(f.file, "utf8")}`);
    if (kind === "mode") await chmod(f.file, 0o600);
    if (kind === "inventory") await writeInstallManifest({ ...await readV2({ target: f.target }, f.request.sourceStateKey), adapter: "other", stateKey: "other.local", entries: [] });
    const before = await readFile(f.file);
    const destinationBefore = await readFile(destinationPath);
    await expect(recoverPendingApply(f.target, adapter.name, localTransport, scope(f.request.destinationStateKey)))
      .rejects.toThrow(/CAS|inventory/i);
    expect(await readFile(f.file)).toEqual(before);
    expect(await readFile(destinationPath)).toEqual(destinationBefore);
  });

  it("recovers receipt-linked guarded adoption with revisioning off", async () => {
    const f = await managedFixture();
    await writeConfig(f.workspace, { schemaVersion: 4, mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "off" } } });
    const plan = await planAdoptLegacyOwnership(f.request);
    const mutation = await GovernedMutation.begin({ workspaceRoot: f.workspace, globalRoot: f.home, commandName: "agentwheel ownership adopt-legacy", reason: "Adopt the coherent fixture block", operationId: "managed-adopt-fixture" });
    const destinationPath = installManifestPath(f.target, adapter.name, scope(f.request.destinationStateKey));
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      await localTransport.writeJsonAtomic(path, value);
      if (path === destinationPath) throw new Error("linked interruption");
    } };
    try {
      await applyAdoptLegacyOwnership({ ...applyRequest(f.request, plan), transport });
      throw new Error("fixture did not interrupt");
    } catch (error) {
      await mutation!.fail(error);
    }
    const receipt = await recoverMutationRuntime("managed-adopt-fixture");
    expect(receipt.runtimeJournals.every((journal) => journal.status === "resolved")).toBe(true);
    expect(await readFile(f.file, "utf8")).toBe(f.prefix + f.block + f.suffix);
  });
});

async function managedFixture() {
  const home = await tempRoot("agentwheel-block-home-"); isolateProcessRoots(home);
  const parent = await tempRoot("agentwheel-block-fleet-"); const workspace = join(parent, "profiles/nested");
  const target = await tempRoot("agentwheel-block-target-"); const pack = await tempRoot("agentwheel-block-pack-");
  await mkdir(workspace, { recursive: true }); await writeConfig(home, { schemaVersion: 2 });
  await mkdir(join(pack, "instructions"));
  await writeFile(join(pack, "openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/managed-adopt", version: "1.0.0", provides: [{ type: "instructions", path: "instructions/AGENTS.md" }] }));
  await writeFile(join(pack, "instructions/AGENTS.md"), "Historical body.\n");
  const roots = { home, parent, workspace, target, pack };
  const seeded = await graphPlan(roots, workspace, { select: ["instructions/AGENTS.md"] });
  const legacyKey = stateKeyFor(adapter.name, { installationType: "local", targetFingerprint: seeded.targetFingerprint });
  const legacyLock = legacyLockPath(workspace, seeded.targetFingerprint);
  await seedPlan(seeded, legacyKey, legacyLock);
  const source = await readV2({ target }, legacyKey); const entry = source.entries[0]!;
  const file = join(target, entry.path); const block = await readFile(file, "utf8");
  const prefix = "# Existing local guidance\r\n\r\nKeep every prefix byte.\r\n\n";
  const suffix = "\nKeep every suffix byte.\r\n";
  await writeFile(file, prefix + block + suffix); await chmod(file, 0o640);
  await writeConfig(parent, { schemaVersion: 3, fleetId: "delivery", packages: [fleetPackage()] });
  await writeConfig(home, { schemaVersion: 3, fleets: { delivery: { root: parent, requiredPackages: ["core"] } } });
  await writeFile(join(pack, "instructions/AGENTS.md"), "A newer source body, evaluated separately.\n");
  const desired = await graphPlan(roots, workspace, { select: ["instructions/AGENTS.md"], freshGraphOnly: true, deferForeignStateCheck: true });
  const request: AdoptLegacyOwnershipRequest = { targetRoot: target, adapter: adapter.name, installationType: "local", sourceStateKey: legacyKey, destinationStateKey: desired.plan.stateKey!, fromWorkspaceRoot: workspace, workspaceRoot: workspace, globalRoot: home, destinationGraphLockPath: desired.graphLockPath, desiredCoverage: desiredCoverageFromPlan(desired.plan) };
  return { ...roots, request, file, block, prefix, suffix, entry, legacyLock, manifest: installManifestPath(target, adapter.name, scope(legacyKey)), selector: managedInstructionSelector(entry.logicalSelector, entry.artifactType, entry.artifactName) };
}

function sha(text: string): string { return createHash("sha256").update(text).digest("hex"); }
