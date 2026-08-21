import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFleetNormalization,
  planFleetNormalization,
  recoverFleetNormalization,
} from "../src/lifecycle/fleet-normalize.js";
import { workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";
import { computeTargetFingerprint } from "../src/model/graph-lock.js";
import { stateKeyFor } from "../src/install/paths.js";
import { hashPath } from "../src/utils/fs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fleet normalization", () => {
  it("plans identical duplicate declarations deterministically without writing", async () => {
    const { home, destination } = await fixture();
    const before = await readFile(join(home, ".agentwheel", "config.json"), "utf8");
    const first = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: home });
    const second = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: home });
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.planDigest).toBe(first.planDigest);
    expect(first.packages.map((entry) => entry.name)).toEqual(["core"]);
    expect(await readFile(join(home, ".agentwheel", "config.json"), "utf8")).toBe(before);
    expect(first.destination.root).toBe(destination);
  });

  it("fails closed on divergent or partially selected duplicates", async () => {
    const { home, destination } = await fixture();
    const configPath = join(destination, ".agentwheel", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.packages[0].select = ["skills/different"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: home })).rejects.toThrow(/diverg/i);

    await writeFile(configPath, `${JSON.stringify({ ...config, packages: [] }, null, 2)}\n`, "utf8");
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", packages: ["core"], globalRoot: home })).rejects.toThrow(/required package|duplicate|destination/i);
  });

  it("requires apply plus the exact digest and rejects a stale source", async () => {
    const { home } = await fixture();
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: home });
    await expect(applyFleetNormalization({ ...plan.request, apply: true })).rejects.toThrow(/plan.?digest/i);
    await expect(applyFleetNormalization({ ...plan.request, apply: false, planDigest: plan.planDigest })).rejects.toThrow(/--apply/i);

    const homePath = join(home, ".agentwheel", "config.json");
    const changed = JSON.parse(await readFile(homePath, "utf8"));
    changed.packages.push(pkg("race"));
    await writeFile(homePath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
    await expect(applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest })).rejects.toThrow(/stale|changed|digest/i);
    expect((JSON.parse(await readFile(homePath, "utf8"))).packages.map((entry: { name: string }) => entry.name)).toContain("core");
  });

  it("applies config transfer without rewriting runtime bytes", async () => {
    const { home, destination, runtimeFile } = await fixture();
    const runtimeBefore = await readFile(runtimeFile);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: home });
    const result = await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    expect(result.applied).toBe(true);
    expect((await readConfig(home)).packages).toEqual([]);
    expect((await readConfig(destination)).packages.map((entry: { name: string }) => entry.name)).toEqual(["core"]);
    expect(await readFile(runtimeFile)).toEqual(runtimeBefore);
  });

  it("requires graph-lock coverage for manifest-only installed state", async () => {
    const state = await installedFixture({ graphLocks: false });
    const sourceBefore = await readFile(join(state.home, ".agentwheel", "config.json"), "utf8");
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .rejects.toThrow(/manifest.*graph lock|graph lock.*manifest/i);
    expect(await readFile(join(state.home, ".agentwheel", "config.json"), "utf8")).toBe(sourceBefore);
  });

  it("derives a destination owner handoff for an equivalent different runtime path", async () => {
    const state = await installedFixture({ destinationRuntime: "different", destinationState: "absent" });
    const sourceBefore = await readFile(state.runtimeFile);
    const destinationBefore = await readFile(state.destinationRuntimeFile);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState).toMatchObject({ sourceManifestCount: 1, destinationManifestCount: 0, renderedPathCount: 1 });

    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });

    const destinationManifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    expect(destinationManifest.entries).toHaveLength(1);
    expect(destinationManifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
    await expect(stat(state.destinationGraphLock!)).resolves.toBeTruthy();
    expect(await readFile(state.runtimeFile)).toEqual(sourceBefore);
    expect(await readFile(state.destinationRuntimeFile)).toEqual(destinationBefore);
  });

  it("rejects foreign same-path ownership even when all runtime bytes match", async () => {
    const state = await installedFixture({ foreignSamePath: true });
    const before = await readFile(state.runtimeFile);
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .rejects.toThrow(/foreign.*same.*path|explicit handoff/i);
    expect(await readFile(state.runtimeFile)).toEqual(before);
  });

  it("plans and applies fully covered manifest ownership without rewriting runtime bytes", async () => {
    const state = await installedFixture();
    const runtimeBefore = await readFile(state.runtimeFile);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState).toMatchObject({ sourceManifestCount: 1, destinationManifestCount: 1, renderedPathCount: 1 });
    const result = await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    expect(result.applied).toBe(true);
    expect((await readConfig(state.home)).packages).toEqual([]);
    const sourceManifest = JSON.parse(await readFile(state.sourceManifest, "utf8"));
    expect(sourceManifest.entries).toEqual([]);
    await expect(stat(state.sourceGraphLock!)).rejects.toThrow();
    expect(await readFile(state.runtimeFile)).toEqual(runtimeBefore);
  });

  it("creates destination manifest and graph ownership before releasing the source owner", async () => {
    const state = await installedFixture({ destinationState: "absent" });
    const runtimeBefore = await readFile(state.runtimeFile);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState).toMatchObject({ sourceManifestCount: 1, destinationManifestCount: 0, renderedPathCount: 1 });
    await expect(stat(state.destinationManifest)).rejects.toThrow();
    await expect(stat(state.destinationGraphLock!)).rejects.toThrow();

    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });

    const destinationManifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    expect(destinationManifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
    const destinationLock = JSON.parse(await readFile(state.destinationGraphLock!, "utf8"));
    expect(destinationLock.canonical.targetFingerprint).toBe(destinationFingerprint(state.destinationRuntime));
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toEqual([]);
    await expect(stat(state.sourceGraphLock!)).rejects.toThrow();
    expect(await readFile(state.runtimeFile)).toEqual(runtimeBefore);
  });

  it("rejects a derived handoff when destination runtime bytes are missing", async () => {
    const state = await installedFixture({ destinationRuntime: "different", destinationState: "absent" });
    await rm(state.destinationRuntimeFile);
    const sourceBefore = await readFile(join(state.home, ".agentwheel", "config.json"), "utf8");
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .rejects.toThrow(/destination runtime|bytes are not equivalent|missing/i);
    expect(await readFile(join(state.home, ".agentwheel", "config.json"), "utf8")).toBe(sourceBefore);
  });

  it("binds manifest revisions into the digest and leaves source intact on a race", async () => {
    const state = await installedFixture();
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    const manifest = JSON.parse(await readFile(state.sourceManifest, "utf8"));
    manifest.entries[0].updatedAt = "2026-08-20T00:00:01.000Z";
    await writeFile(state.sourceManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest }))
      .rejects.toThrow(/stale|manifest.*changed|digest/i);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toContain("core");
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toHaveLength(1);
    await expect(stat(state.sourceGraphLock!)).resolves.toBeTruthy();
  });

  it("binds destination manifest revisions into the digest", async () => {
    const state = await installedFixture();
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    manifest.entries[0].updatedAt = "2026-08-20T00:00:02.000Z";
    await writeFile(state.destinationManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest }))
      .rejects.toThrow(/stale|changed|digest/i);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toContain("core");
  });

  it("rejects runtime-byte races after planning without changing source state", async () => {
    const state = await installedFixture();
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    await writeFile(state.runtimeFile, "raced runtime bytes\n", "utf8");
    await expect(applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest }))
      .rejects.toThrow(/runtime content drift|bytes are not equivalent/i);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toContain("core");
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toHaveLength(1);
  });

  it("rejects divergent graph versions and rendered identities", async () => {
    const state = await installedFixture();
    const lock = JSON.parse(await readFile(state.destinationGraphLock!, "utf8"));
    lock.canonical.nodes[0].version = "2.0.0";
    await writeFile(state.destinationGraphLock!, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .rejects.toThrow(/graph.*diverge|versions.*diverge/i);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toContain("core");
  });

  it("rolls back destination state created before source release and exposes recoverable journal cleanup", async () => {
    const state = await installedFixture({ destinationState: "absent" });
    const runtimeBefore = await readFile(state.runtimeFile);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    await expect(applyFleetNormalization(
      { ...plan.request, apply: true, planDigest: plan.planDigest },
      {
        afterDestinationTransfer: async () => {
          const destinationManifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
          expect(destinationManifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
          await expect(stat(state.destinationGraphLock!)).resolves.toBeTruthy();
          expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toHaveLength(1);
          await expect(stat(state.sourceGraphLock!)).resolves.toBeTruthy();
          throw new Error("fixture interruption");
        },
      },
    )).rejects.toThrow(/fixture interruption/);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toContain("core");
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toHaveLength(1);
    await expect(stat(state.sourceGraphLock!)).resolves.toBeTruthy();
    await expect(stat(state.destinationManifest)).rejects.toThrow();
    await expect(stat(state.destinationGraphLock!)).rejects.toThrow();
    expect(await readFile(state.runtimeFile)).toEqual(runtimeBefore);
    await expect(recoverFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .resolves.toMatchObject({ recovered: true, sourceRestored: true });
  });

  it("preserves a concurrent source config edit detected after manifest transfer", async () => {
    const state = await installedFixture({ destinationState: "absent" });
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    await expect(applyFleetNormalization(
      { ...plan.request, apply: true, planDigest: plan.planDigest },
      {
        afterManifestTransfer: async () => {
          const config = await readConfig(state.home);
          config.packages.push(pkg("concurrent"));
          await writeConfig(state.home, config);
        },
      },
    )).rejects.toThrow(/source config changed|concurrent|compare-and-swap/i);
    expect((await readConfig(state.home)).packages.map((entry: { name: string }) => entry.name)).toEqual(["core", "concurrent"]);
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toHaveLength(1);
    await expect(stat(state.sourceGraphLock!)).resolves.toBeTruthy();
    await expect(stat(state.destinationManifest)).rejects.toThrow();
  });

  it("normalizes an ordinary direct local adapter target without a named agent", async () => {
    const state = await directInstalledFixture();
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState.transfers).toHaveLength(1);
    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
    expect((await readConfig(state.home)).packages).toEqual([]);
  });

  it("normalizes an ordinary direct user adapter target without a named agent", async () => {
    const runtimeHome = await tempRoot("agentwheel-normalize-direct-user-runtime-");
    const previousTestHome = process.env.AGENTWHEEL_TEST_HOME;
    process.env.AGENTWHEEL_TEST_HOME = runtimeHome;
    try {
      const state = await directInstalledFixture("user", runtimeHome);
      const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
      expect(plan.installedState.transfers).toHaveLength(1);
      await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
      const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
      expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
      expect((await readConfig(state.home)).packages).toEqual([]);
    } finally {
      if (previousTestHome === undefined) delete process.env.AGENTWHEEL_TEST_HOME;
      else process.env.AGENTWHEEL_TEST_HOME = previousTestHome;
    }
  });

  it("hands ownership to fleet-scoped state when source and destination share runtime and configured state key", async () => {
    const state = await installedFixture({ sameStateKey: true, destinationState: "absent" });
    expect(state.sourceManifest).not.toBe(state.destinationManifest);
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState.transfers[0]).toMatchObject({
      sourceManifestPath: state.sourceManifest,
      destinationManifestPath: state.destinationManifest,
    });
    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.destination, "delivery"));
    expect((JSON.parse(await readFile(state.sourceManifest, "utf8"))).entries).toEqual([]);
  });

  it("preserves destination-only graph roots during ownership transfer", async () => {
    const state = await installedFixture();
    const lock = JSON.parse(await readFile(state.destinationGraphLock!, "utf8"));
    lock.canonical.roots.push({
      rootId: "destination-only",
      source: "/packages/destination-only",
      normalizedSource: "local:/packages/destination-only",
      graphNodeId: "node-destination-only",
      mode: "pinned",
      selected: ["skills/destination-only"],
    });
    lock.canonical.nodes.push({
      id: "node-destination-only",
      name: "destination-only",
      version: "1.0.0",
      source: "/packages/destination-only",
      normalizedSource: "local:/packages/destination-only",
      driver: "local",
      sourceHash: "fedcba9876543210",
      mode: "pinned",
      requiredBy: ["destination-only"],
      selected: ["skills/destination-only"],
    });
    await writeFile(state.destinationGraphLock!, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    const destinationConfig = await readConfig(state.destination);
    destinationConfig.packages.push(pkg("destination-only"));
    await writeConfig(state.destination, destinationConfig);

    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", packages: ["core"], globalRoot: state.home });
    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    const after = JSON.parse(await readFile(state.destinationGraphLock!, "utf8"));
    expect(after.canonical.roots.map((root: { rootId: string }) => root.rootId)).toEqual(["core", "destination-only"]);
  });

  it("rejects removing a package required by the source fleet registration", async () => {
    const home = await tempRoot("agentwheel-normalize-registry-");
    const source = await tempRoot("agentwheel-normalize-source-fleet-");
    const destination = await tempRoot("agentwheel-normalize-destination-fleet-");
    await writeConfig(source, { schemaVersion: 3, fleetId: "source", packages: [pkg("core")] });
    await writeConfig(destination, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
    await writeConfig(home, {
      schemaVersion: 3,
      packages: [],
      fleets: {
        source: { root: source, requiredPackages: ["core"] },
        delivery: { root: destination, requiredPackages: ["core"] },
      },
    });
    await expect(planFleetNormalization({ destinationFleet: "delivery", from: "fleet:source", globalRoot: home }))
      .rejects.toThrow(/source fleet|required package|postcondition/i);
    expect((await readConfig(source)).packages.map((entry: { name: string }) => entry.name)).toEqual(["core"]);
  });

  it("normalizes multiple valid destination target graphs", async () => {
    const state = await installedFixture({ secondTarget: true });
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    expect(plan.installedState.graphTransfers).toHaveLength(2);
    expect(plan.installedState.transfers).toHaveLength(2);
    await applyFleetNormalization({ ...plan.request, apply: true, planDigest: plan.planDigest });
    expect((await readConfig(state.home)).packages).toEqual([]);
  });

  it("blocks recovery when the destination config changed outside the transaction", async () => {
    const state = await installedFixture({ destinationState: "absent" });
    const plan = await planFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home });
    await expect(applyFleetNormalization(
      { ...plan.request, apply: true, planDigest: plan.planDigest },
      { afterDestinationTransfer: () => { throw new Error("fixture interruption"); } },
    )).rejects.toThrow(/fixture interruption/);
    const destinationConfig = await readConfig(state.destination);
    destinationConfig.packages.push(pkg("external"));
    await writeConfig(state.destination, destinationConfig);
    await expect(recoverFleetNormalization({ destinationFleet: "delivery", from: "user", globalRoot: state.home }))
      .rejects.toThrow(/destination config changed outside/i);
    expect((await readConfig(state.destination)).packages.map((entry: { name: string }) => entry.name)).toContain("external");
  });

  it("self-normalizes legacy same-root ownership without changing package declarations or runtime bytes", async () => {
    const state = await legacySelfFixture();
    const configBefore = await readFile(join(state.fleet, ".agentwheel", "config.json"));
    const runtimeBefore = await readFile(state.runtimeFile);
    const graphBefore = await readFile(state.graphLock);
    const request = { destinationFleet: "delivery", from: "fleet:delivery" as const, globalRoot: state.home };

    const plan = await planFleetNormalization(request);
    expect(plan.source.root).toBe(state.fleet);
    expect(plan.destination.root).toBe(state.fleet);
    expect(plan.installedState.transfers).toMatchObject([{
      sourceManifestPath: state.manifest,
      destinationManifestPath: state.destinationManifest,
    }]);
    expect(plan.installedState.graphTransfers).toMatchObject([{
      sourceGraphLockPath: state.graphLock,
      destinationGraphLockPath: state.destinationGraphLock,
    }]);
    expect(state.destinationManifest).not.toBe(state.manifest);
    expect(state.destinationGraphLock).not.toBe(state.graphLock);

    await applyFleetNormalization({ ...request, apply: true, planDigest: plan.planDigest });

    expect(await readFile(join(state.fleet, ".agentwheel", "config.json"))).toEqual(configBefore);
    expect(await readFile(state.runtimeFile)).toEqual(runtimeBefore);
    await expect(stat(state.graphLock)).rejects.toThrow();
    await expect(stat(state.manifest)).rejects.toThrow();
    const destinationGraph = JSON.parse(await readFile(state.destinationGraphLock, "utf8"));
    expect(destinationGraph.canonical.targetFingerprint).toBe(state.destinationFingerprint);
    expect(await readFile(state.destinationGraphLock)).not.toEqual(graphBefore);
    const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.fleet, "delivery"));
    expect(manifest.stateKey).toBe(state.destinationStateKey);
    await expect(planFleetNormalization(request)).rejects.toThrow(/already.*normalized|fleet-qualified/i);
  });

  it("self-normalizes only live legacy target state when composite profiles and stale locks coexist", async () => {
    const state = await legacySelfFixture();
    const config = await readConfig(state.fleet);
    config.profiles = {
      remote: {
        members: [{
          id: "retired",
          workspace: "/unavailable/retired",
          profile: "all",
          transport: "ssh",
          host: "retired.invalid",
        }],
      },
    };
    await writeConfig(state.fleet, config);
    const manifest = JSON.parse(await readFile(state.manifest, "utf8"));
    manifest.entries[0].owners = ["node-core"];
    manifest.entries[0].packageName = "example/core";
    await writeFile(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const graph = JSON.parse(await readFile(state.graphLock, "utf8"));
    graph.canonical.artifacts[0].owners = ["node-core"];
    await writeFile(state.graphLock, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    const staleFingerprint = "stale-current-lock";
    const staleGraphLock = await writeGraphLock(state.fleet, staleFingerprint);
    const staleGraph = JSON.parse(await readFile(staleGraphLock, "utf8"));
    staleGraph.canonical.artifacts[0].owners = ["node-core", "foreign-node"];
    await writeFile(staleGraphLock, `${JSON.stringify(staleGraph, null, 2)}\n`, "utf8");
    await writeGraphLock(state.fleet, "stale-legacy-lock", "retired");

    const plan = await planFleetNormalization({
      destinationFleet: "delivery",
      from: "fleet:delivery",
      globalRoot: state.home,
    });

    expect(plan.installedState.transfers).toHaveLength(1);
    expect(plan.installedState.transfers[0]).toMatchObject({
      sourceManifestPath: state.manifest,
      destinationManifestPath: state.destinationManifest,
    });
    expect(plan.installedState.sourceGraphLockPaths).toEqual([state.graphLock]);

    await applyFleetNormalization({
      destinationFleet: "delivery",
      from: "fleet:delivery",
      globalRoot: state.home,
      apply: true,
      planDigest: plan.planDigest,
    });
    expect(await readFile(staleGraphLock, "utf8")).toEqual(`${JSON.stringify(staleGraph, null, 2)}\n`);
    await expect(stat(state.destinationManifest)).resolves.toBeDefined();
  });

  it("rejects a live nested-workspace foreign owner without writing state", async () => {
    const state = await legacySelfFixture();
    const manifestBefore = await readFile(state.manifest, "utf8");
    const manifest = JSON.parse(manifestBefore);
    manifest.entries.push({
      ...manifest.entries[0],
      workspaceOwner: workspaceOwnerForRoot(join(state.fleet, "profiles", "live")),
    });
    await writeFile(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(planFleetNormalization({
      destinationFleet: "delivery",
      from: "fleet:delivery",
      globalRoot: state.home,
    })).rejects.toThrow(/owner mismatch|foreign/i);
    expect(await readFile(state.manifest, "utf8")).toContain(workspaceOwnerForRoot(join(state.fleet, "profiles", "live")));
    await expect(stat(state.destinationManifest)).rejects.toThrow();
  });

  it("rejects a partial self-normalization of a legacy multi-root graph without writing state", async () => {
    const state = await legacySelfMultiRootFixture();
    const configBefore = await readFile(join(state.fleet, ".agentwheel", "config.json"));
    const manifestBefore = await readFile(state.manifest);
    const graphBefore = await readFile(state.graphLock);

    await expect(planFleetNormalization({
      destinationFleet: "delivery",
      from: "fleet:delivery",
      packages: ["core"],
      globalRoot: state.home,
    })).rejects.toThrow(/partially selected|partial.*graph|all.*roots/i);

    expect(await readFile(join(state.fleet, ".agentwheel", "config.json"))).toEqual(configBefore);
    expect(await readFile(state.manifest)).toEqual(manifestBefore);
    expect(await readFile(state.graphLock)).toEqual(graphBefore);
    await expect(stat(state.destinationManifest)).rejects.toThrow();
    await expect(stat(state.destinationGraphLock)).rejects.toThrow();
  });

  it("rejects self-normalization when ownership is already fleet-qualified", async () => {
    const state = await legacySelfFixture();
    const manifest = JSON.parse(await readFile(state.manifest, "utf8"));
    manifest.entries[0].workspaceOwner = workspaceOwnerForRoot(state.fleet, "delivery");
    await writeFile(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(planFleetNormalization({
      destinationFleet: "delivery",
      from: "fleet:delivery",
      globalRoot: state.home,
    })).rejects.toThrow(/already.*normalized|fleet-qualified/i);
    expect((JSON.parse(await readFile(state.manifest, "utf8"))).entries[0].workspaceOwner).toBe(manifest.entries[0].workspaceOwner);
  });

  it("rolls self-normalization back to legacy ownership after destination transfer failure", async () => {
    const state = await legacySelfFixture();
    const configBefore = await readFile(join(state.fleet, ".agentwheel", "config.json"));
    const graphBefore = await readFile(state.graphLock);
    const request = { destinationFleet: "delivery", from: "fleet:delivery" as const, globalRoot: state.home };
    const plan = await planFleetNormalization(request);

    await expect(applyFleetNormalization(
      { ...request, apply: true, planDigest: plan.planDigest },
      {
        afterDestinationTransfer: async () => {
          const manifest = JSON.parse(await readFile(state.destinationManifest, "utf8"));
          expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.fleet, "delivery"));
          await expect(stat(state.manifest)).resolves.toBeTruthy();
          await expect(stat(state.graphLock)).resolves.toBeTruthy();
          throw new Error("self-normalization interruption");
        },
      },
    )).rejects.toThrow(/self-normalization interruption/);

    expect(await readFile(join(state.fleet, ".agentwheel", "config.json"))).toEqual(configBefore);
    expect(await readFile(state.graphLock)).toEqual(graphBefore);
    await expect(stat(state.destinationGraphLock)).rejects.toThrow();
    await expect(stat(state.destinationManifest)).rejects.toThrow();
    const restored = JSON.parse(await readFile(state.manifest, "utf8"));
    expect(restored.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(state.fleet));
    await expect(recoverFleetNormalization(request)).resolves.toMatchObject({ recovered: true, sourceRestored: true });
    expect(await readFile(join(state.fleet, ".agentwheel", "config.json"))).toEqual(configBefore);
  });
});

async function fixture() {
  const home = await tempRoot("agentwheel-normalize-home-");
  const destination = await tempRoot("agentwheel-normalize-dest-");
  const runtimeFile = join(destination, "runtime.bin");
  await writeFile(runtimeFile, Buffer.from([0, 1, 2, 3]));
  await writeConfig(destination, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
  await writeConfig(home, {
    schemaVersion: 3,
    packages: [pkg("core")],
    fleets: { delivery: { root: destination, requiredPackages: ["core"] } },
  });
  return { home, destination, runtimeFile };
}

async function legacySelfFixture() {
  const home = await tempRoot("agentwheel-normalize-self-home-");
  const fleet = await tempRoot("agentwheel-normalize-self-fleet-");
  const runtime = await tempRoot("agentwheel-normalize-self-runtime-");
  const runtimeFile = join(runtime, "AGENTS.md");
  await writeFile(runtimeFile, "legacy runtime bytes\n", "utf8");
  const runtimeHash = await hashPath(runtimeFile);
  await writeConfig(fleet, {
    schemaVersion: 3,
    fleetId: "delivery",
    packages: [pkg("core")],
    agents: { runtime: { adapter: "codex", root: runtime } },
  });
  await writeConfig(home, {
    schemaVersion: 3,
    packages: [],
    fleets: { delivery: { root: fleet, requiredPackages: ["core"] } },
  });
  const legacyFingerprint = targetFingerprint(runtime);
  const legacyStateKey = stateKeyFor("codex", { installationType: "local", targetFingerprint: legacyFingerprint });
  const destinationFingerprint = targetFingerprint(runtime, undefined, "runtime", "delivery");
  const destinationStateKey = stateKeyFor("codex", {
    installationType: "local",
    targetFingerprint: destinationFingerprint,
    fleetId: "delivery",
  });
  const graphLock = await writeGraphLock(fleet, legacyFingerprint);
  const manifest = await writeManifest(runtime, legacyStateKey, workspaceOwnerForRoot(fleet), runtimeHash);
  return {
    home,
    fleet,
    runtime,
    runtimeFile,
    graphLock,
    manifest,
    destinationFingerprint,
    destinationStateKey,
    destinationGraphLock: graphLockPath(fleet, destinationFingerprint),
    destinationManifest: join(runtime, ".agentwheel", `${destinationStateKey}.install-manifest.json`),
  };
}

async function legacySelfMultiRootFixture() {
  const state = await legacySelfFixture();
  const extraRuntimeFile = join(state.runtime, "EXTRA.md");
  await writeFile(extraRuntimeFile, "legacy extra runtime bytes\n", "utf8");
  const extraHash = await hashPath(extraRuntimeFile);

  const config = await readConfig(state.fleet);
  config.packages.push(pkg("extra"));
  await writeConfig(state.fleet, config);

  const graph = JSON.parse(await readFile(state.graphLock, "utf8"));
  graph.canonical.roots.push({
    rootId: "extra",
    source: "/packages/extra",
    normalizedSource: "local:/packages/extra",
    graphNodeId: "node-extra",
    mode: "pinned",
    selected: ["instructions/EXTRA.md"],
  });
  graph.canonical.nodes.push({
    id: "node-extra",
    name: "extra",
    version: "1.0.0",
    source: "/packages/extra",
    normalizedSource: "local:/packages/extra",
    driver: "local",
    sourceHash: "fedcba9876543210",
    mode: "pinned",
    requiredBy: ["extra"],
    selected: ["instructions/EXTRA.md"],
  });
  graph.canonical.artifacts.push({
    graphNodeId: "node-extra",
    dependencyRole: "root",
    type: "instructions",
    name: "EXTRA.md",
    installName: "EXTRA.md",
    logicalSelector: "instructions/EXTRA.md",
    owners: ["extra"],
    relativePath: "EXTRA.md",
    kind: "file",
    hash: "fedcba9876543210",
    channel: "managed",
  });
  await writeFile(state.graphLock, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  const manifest = JSON.parse(await readFile(state.manifest, "utf8"));
  manifest.entries.push({
    ...manifest.entries[0],
    path: "EXTRA.md",
    artifactName: "EXTRA.md",
    installName: "EXTRA.md",
    logicalSelector: "instructions/EXTRA.md",
    graphNodeId: "node-extra",
    owners: ["extra"],
    hash: extraHash,
    sourceHash: "fedcba9876543210",
    packageName: "extra",
  });
  await writeFile(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...state, extraRuntimeFile };
}

async function installedFixture(options: {
  graphLocks?: boolean;
  destinationRuntime?: "same" | "different";
  destinationState?: "present" | "absent";
  foreignSamePath?: boolean;
  sameStateKey?: boolean;
  secondTarget?: boolean;
} = {}) {
  const base = await fixture();
  const sourceRuntime = await tempRoot("agentwheel-normalize-runtime-source-");
  const destinationRuntime = options.destinationRuntime === "different"
    ? await tempRoot("agentwheel-normalize-runtime-destination-")
    : sourceRuntime;
  const runtimeFile = join(sourceRuntime, "AGENTS.md");
  const destinationRuntimeFile = join(destinationRuntime, "AGENTS.md");
  await writeFile(runtimeFile, "identical runtime bytes\n", "utf8");
  if (destinationRuntime !== sourceRuntime) await writeFile(destinationRuntimeFile, "identical runtime bytes\n", "utf8");
  const runtimeHash = await hashPath(runtimeFile);

  const sourceStateKey = options.sameStateKey ? "codex.local.shared" : "codex.local.source";
  const destinationConfiguredStateKey = options.sameStateKey ? sourceStateKey : "codex.local.destination";
  const destinationFingerprintValue = targetFingerprint(destinationRuntime, destinationConfiguredStateKey, "runtime", "delivery");
  const destinationStateKey = stateKeyFor("codex", {
    installationType: "local",
    stateKey: destinationConfiguredStateKey,
    targetFingerprint: destinationFingerprintValue,
    fleetId: "delivery",
  });
  await writeConfig(base.home, {
    ...(await readConfig(base.home)),
    agents: { runtime: { adapter: "codex", root: sourceRuntime, stateKey: sourceStateKey } },
  });
  await writeConfig(base.destination, {
    ...(await readConfig(base.destination)),
    agents: { runtime: { adapter: "codex", root: destinationRuntime, stateKey: destinationConfiguredStateKey } },
  });

  const sourceGraphLock = options.graphLocks === false
    ? undefined
    : await writeGraphLock(base.home, sourceFingerprint(sourceRuntime, sourceStateKey));
  const destinationGraphLockPath = graphLockPath(base.destination, destinationFingerprintValue);
  const destinationGraphLock = options.graphLocks === false
    ? undefined
    : options.destinationState === "absent"
      ? destinationGraphLockPath
      : await writeGraphLock(base.destination, destinationFingerprintValue);
  const sourceManifest = await writeManifest(
    sourceRuntime,
    sourceStateKey,
    workspaceOwnerForRoot(base.home),
    runtimeHash,
  );
  const destinationManifest = join(destinationRuntime, ".agentwheel", `${destinationStateKey}.install-manifest.json`);
  if (options.destinationState !== "absent" && destinationManifest !== sourceManifest) {
    await writeManifest(
      destinationRuntime,
      destinationStateKey,
      workspaceOwnerForRoot(base.destination, "delivery"),
      runtimeHash,
    );
  }
  if (options.foreignSamePath) {
    await writeManifest(sourceRuntime, "codex.local.foreign", "workspace-root:/foreign", runtimeHash);
  }
  if (options.secondTarget) {
    const sourceRuntime2 = await tempRoot("agentwheel-normalize-runtime-source-2-");
    const destinationRuntime2 = await tempRoot("agentwheel-normalize-runtime-destination-2-");
    const sourceStateKey2 = "codex.local.source-2";
    const destinationConfiguredStateKey2 = "codex.local.destination-2";
    const destinationFingerprint2 = targetFingerprint(destinationRuntime2, destinationConfiguredStateKey2, "runtime2", "delivery");
    const destinationStateKey2 = stateKeyFor("codex", {
      installationType: "local",
      stateKey: destinationConfiguredStateKey2,
      targetFingerprint: destinationFingerprint2,
      fleetId: "delivery",
    });
    await writeFile(join(sourceRuntime2, "AGENTS.md"), "identical runtime bytes\n", "utf8");
    await writeFile(join(destinationRuntime2, "AGENTS.md"), "identical runtime bytes\n", "utf8");
    const sourceConfig = await readConfig(base.home);
    sourceConfig.agents.runtime2 = { adapter: "codex", root: sourceRuntime2, stateKey: sourceStateKey2 };
    await writeConfig(base.home, sourceConfig);
    const destinationConfig = await readConfig(base.destination);
    destinationConfig.agents.runtime2 = { adapter: "codex", root: destinationRuntime2, stateKey: destinationConfiguredStateKey2 };
    await writeConfig(base.destination, destinationConfig);
    await writeGraphLock(base.home, sourceFingerprint(sourceRuntime2, sourceStateKey2, "runtime2"), "runtime2");
    await writeGraphLock(base.destination, destinationFingerprint2, "runtime2");
    await writeManifest(sourceRuntime2, sourceStateKey2, workspaceOwnerForRoot(base.home), runtimeHash);
    await writeManifest(destinationRuntime2, destinationStateKey2, workspaceOwnerForRoot(base.destination, "delivery"), runtimeHash);
  }
  return { ...base, sourceRuntime, destinationRuntime, runtimeFile, destinationRuntimeFile, sourceManifest, destinationManifest, sourceGraphLock, destinationGraphLock };
}

async function directInstalledFixture(installationType = "local", installRoot?: string) {
  const base = await fixture();
  if (installationType !== "local") {
    const sourceConfig = await readConfig(base.home);
    sourceConfig.packages[0].installationType = installationType;
    await writeConfig(base.home, sourceConfig);
    const destinationConfig = await readConfig(base.destination);
    destinationConfig.packages[0].installationType = installationType;
    await writeConfig(base.destination, destinationConfig);
  }
  const sourceFingerprintValue = directFingerprint(base.home, installationType);
  const destinationFingerprintValue = directFingerprint(base.destination, installationType, "delivery");
  const sourceStateKey = stateKeyFor("codex", { installationType, targetFingerprint: sourceFingerprintValue });
  const destinationStateKey = stateKeyFor("codex", {
    installationType,
    targetFingerprint: destinationFingerprintValue,
    fleetId: "delivery",
  });
  const runtimeRoot = installRoot ?? base.home;
  const destinationRuntimeRoot = installRoot ?? base.destination;
  const sourceRuntimeFile = join(runtimeRoot, "AGENTS.md");
  const destinationRuntimeFile = join(destinationRuntimeRoot, "AGENTS.md");
  await writeFile(sourceRuntimeFile, "identical runtime bytes\n", "utf8");
  if (destinationRuntimeFile !== sourceRuntimeFile) await writeFile(destinationRuntimeFile, "identical runtime bytes\n", "utf8");
  const runtimeHash = await hashPath(sourceRuntimeFile);
  await writeGraphLock(base.home, sourceFingerprintValue, "codex");
  await writeGraphLock(base.destination, destinationFingerprintValue, "codex");
  await writeManifest(runtimeRoot, sourceStateKey, workspaceOwnerForRoot(base.home), runtimeHash, installationType);
  const destinationManifest = await writeManifest(destinationRuntimeRoot, destinationStateKey, workspaceOwnerForRoot(base.destination, "delivery"), runtimeHash, installationType);
  return { ...base, destinationManifest };
}

async function writeGraphLock(workspace: string, fingerprint: string, targetKey = "runtime"): Promise<string> {
  const keyedPath = join(workspace, ".agentwheel", "locks", targetKey, "codex", `${fingerprint}.graph-lock.json`);
  await mkdir(join(workspace, ".agentwheel", "locks", targetKey, "codex"), { recursive: true });
  await writeFile(keyedPath, `${JSON.stringify({
    version: 1,
    canonical: {
      targetFingerprint: fingerprint,
      roots: [{
        rootId: "core",
        source: "/packages/core",
        normalizedSource: "local:/packages/core",
        graphNodeId: "node-core",
        mode: "pinned",
        selected: ["skills/core"],
      }],
      nodes: [{
        id: "node-core",
        name: "core",
        version: "1.0.0",
        source: "/packages/core",
        normalizedSource: "local:/packages/core",
        driver: "local",
        sourceHash: "0123456789abcdef",
        mode: "pinned",
        requiredBy: ["core"],
        selected: ["skills/core"],
      }],
      edges: [],
      includeEdges: [],
      artifacts: [{
        graphNodeId: "node-core",
        dependencyRole: "root",
        type: "instructions",
        name: "AGENTS.md",
        installName: "AGENTS.md",
        logicalSelector: "instructions/AGENTS.md",
        owners: ["core"],
        relativePath: "AGENTS.md",
        kind: "file",
        hash: "0123456789abcdef",
        channel: "managed",
      }],
      namespacing: [],
      overrides: [],
      plainNameIncumbents: [],
    },
  }, null, 2)}\n`, "utf8");
  return keyedPath;
}

function graphLockPath(workspace: string, fingerprint: string): string {
  return join(workspace, ".agentwheel", "locks", "runtime", "codex", `${fingerprint}.graph-lock.json`);
}

function sourceFingerprint(runtimeRoot: string, stateKey: string, agentName = "runtime"): string {
  return targetFingerprint(runtimeRoot, stateKey, agentName);
}

function targetFingerprint(runtimeRoot: string, stateKey?: string, agentName = "runtime", fleetId?: string): string {
  return computeTargetFingerprint({
    adapter: "codex",
    fleetId,
    installationType: "local",
    agentName,
    targetRoot: runtimeRoot,
    transport: "local",
    stateKey,
  });
}

function destinationFingerprint(runtimeRoot: string): string {
  return targetFingerprint(runtimeRoot, "codex.local.destination", "runtime", "delivery");
}

function directFingerprint(runtimeRoot: string, installationType = "local", fleetId?: string): string {
  return computeTargetFingerprint({
    adapter: "codex",
    fleetId,
    installationType,
    targetRoot: runtimeRoot,
    transport: "local",
  });
}

async function writeManifest(
  runtimeRoot: string,
  stateKey: string,
  workspaceOwner: string,
  hash: string,
  installationType = "local",
): Promise<string> {
  const path = join(runtimeRoot, ".agentwheel", `${stateKey}.install-manifest.json`);
  await mkdir(join(runtimeRoot, ".agentwheel"), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 2,
    adapter: "codex",
    installationType,
    stateKey,
    targetRoot: runtimeRoot,
    generatedAt: "2026-08-20T00:00:00.000Z",
    revision: "0123456789abcdef",
    entries: [{
      path: "AGENTS.md",
      artifactType: "instructions",
      artifactName: "AGENTS.md",
      installName: "AGENTS.md",
      logicalSelector: "instructions/AGENTS.md",
      graphNodeId: "node-core",
      dependencyRole: "root",
      owners: ["core"],
      refCount: 1,
      workspaceOwner,
      kind: "file",
      hash,
      sourceHash: "0123456789abcdef",
      updatedAt: "2026-08-20T00:00:00.000Z",
      channel: "managed",
      packageName: "core",
    }],
  }, null, 2)}\n`, "utf8");
  return path;
}

function pkg(name: string) {
  return { name, source: `/packages/${name}`, driver: "local", adapter: "codex", mode: "pinned", select: ["skills/core"] };
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeConfig(root: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, ".agentwheel"), { recursive: true });
  await writeFile(join(root, ".agentwheel", "config.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readConfig(root: string) {
  return JSON.parse(await readFile(join(root, ".agentwheel", "config.json"), "utf8"));
}
