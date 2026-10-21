import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFleetNormalization, planFleetNormalization, recoverFleetNormalization } from "../src/lifecycle/fleet-normalize.js";
import { workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";
import { computeTargetFingerprint } from "../src/model/graph-lock.js";
import { stateKeyFor } from "../src/install/paths.js";
import { GovernedMutation } from "../src/mutation/coordinator.js";
import { createMutationReceipt } from "../src/mutation/receipts.js";
import { hashPath } from "../src/utils/fs.js";
import type { RunAsIdentity } from "../src/transport/run-as-identity.js";
import type { RunAsRequest } from "../src/transport/run-as-worker.js";

// Real confined helper subprocesses can contend with the full parallel CLI suite.
vi.setConfig({ testTimeout: 120_000 });

const fake = vi.hoisted(() => ({ identities: new Map<string, RunAsIdentity>(), requests: [] as RunAsRequest[], uidDelta: 0 }));
vi.mock("../src/transport/run-as-identity.js", async (original) => ({
  ...await original<typeof import("../src/transport/run-as-identity.js")>(),
  resolveRunAsIdentity: (_user: string, root: string) => {
    const identity = fake.identities.get(root); if (!identity) throw new Error("Unknown fixture identity");
    return { ...identity, uid: identity.uid + fake.uidDelta };
  },
}));
vi.mock("../src/transport/index.js", async (original) => {
  const actual = await original<typeof import("../src/transport/index.js")>();
  const { createRunAsTransport } = await import("../src/transport/run-as.js");
  const { executeRequest } = await import("../src/transport/run-as-worker.js");
  return { ...actual, createRunAsTransport: (identity: RunAsIdentity) => createRunAsTransport(identity, async (_command, _args, input) => {
    if (!input) return { stdout: `${identity.uid}\n` };
    const request = JSON.parse(input) as RunAsRequest; fake.requests.push(request);
    try { return { stdout: JSON.stringify({ version: 1, result: await executeRequest(identity.root, process.getuid!(), process.getgid!(), request) }) }; }
    catch (error) { return { stdout: JSON.stringify({ version: 1, error: { message: String(error), code: (error as NodeJS.ErrnoException).code } }) }; }
  }, undefined, "/usr/bin/python3") };
});
const roots: string[] = [], mutations: GovernedMutation[] = [];
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  for (const mutation of mutations.splice(0)) await mutation.fail(new Error("Fixture done")).catch(() => {});
  if (originalStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalStateRoot;
  fake.identities.clear(); fake.requests.length = 0; fake.uidDelta = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function json(path: string, data: unknown) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, `${JSON.stringify(data, null, 2)}\n`); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-runas-normalize-")); roots.push(root); await chmod(root, 0o700);
  const home = join(root, "caller"), fleet = join(root, "fleet"), runtime = join(root, "service");
  for (const path of [home, fleet, runtime]) await mkdir(path, { mode: 0o700 });
  const identity: RunAsIdentity = { user: "nobody", uid: 65534, gid: 65534, home: runtime, root: runtime };
  fake.identities.set(runtime, identity);
  const pkg = { name: "core", source: "/packages/core", driver: "local", adapter: "codex", mode: "pinned", select: ["skills/core"] };
  await json(join(home, ".agentwheel/config.json"), { schemaVersion: 4, packages: [], fleets: { delivery: { root: fleet, requiredPackages: ["core"] } } });
  await json(join(fleet, ".agentwheel/config.json"), { schemaVersion: 4, fleetId: "delivery", packages: [pkg], agents: { runtime: { adapter: "codex", root: runtime, transport: "local-run-as", runAs: "nobody" } } });
  const runtimeFile = join(runtime, "AGENTS.md"); await writeFile(runtimeFile, "legacy runtime bytes\n");
  const fingerprint = computeTargetFingerprint({ adapter: "codex", installationType: "local", agentName: "runtime", targetRoot: runtime, transport: "local-run-as", runAs: identity });
  const stateKey = stateKeyFor("codex", { installationType: "local", targetFingerprint: fingerprint });
  const manifest = join(runtime, ".agentwheel", `${stateKey}.install-manifest.json`);
  const graph = {
    version: 1, canonical: {
      targetFingerprint: fingerprint,
      roots: [{ rootId: "core", source: "/packages/core", normalizedSource: "local:/packages/core", graphNodeId: "node-core", mode: "pinned", selected: ["skills/core"] }],
      nodes: [{ id: "node-core", name: "core", version: "1.0.0", source: "/packages/core", normalizedSource: "local:/packages/core", driver: "local", sourceHash: "0123456789abcdef", mode: "pinned", requiredBy: ["core"], selected: ["skills/core"] }],
      edges: [], includeEdges: [], artifacts: [{ graphNodeId: "node-core", dependencyRole: "root", type: "instructions", name: "AGENTS.md", installName: "AGENTS.md", logicalSelector: "instructions/AGENTS.md", owners: ["core"], relativePath: "AGENTS.md", kind: "file", hash: "0123456789abcdef", channel: "managed" }],
      namespacing: [], overrides: [], plainNameIncumbents: [],
    },
  };
  const graphPath = join(fleet, ".agentwheel/locks/runtime/codex", `${fingerprint}.graph-lock.json`);
  await json(graphPath, graph);
  await json(manifest, { version: 2, adapter: "codex", installationType: "local", stateKey, targetRoot: runtime, generatedAt: "2026-01-01T00:00:00.000Z", revision: "0123456789abcdef", entries: [{
    path: "AGENTS.md", artifactType: "instructions", artifactName: "AGENTS.md", installName: "AGENTS.md", logicalSelector: "instructions/AGENTS.md", graphNodeId: "node-core", dependencyRole: "root", owners: ["core"], refCount: 1,
    workspaceOwner: workspaceOwnerForRoot(fleet), kind: "file", hash: await hashPath(runtimeFile), sourceHash: "0123456789abcdef", updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed", packageName: "core",
  }] });
  const request = { destinationFleet: "delivery", from: "fleet:delivery" as const, packages: ["core"], agent: "runtime", globalRoot: home };
  return { root, home, fleet, runtime, runtimeFile, manifest, graphPath, request, identity };
}
async function govern(f: Awaited<ReturnType<typeof fixture>>) {
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(f.home, "mutations");
  const receipt = await createMutationReceipt({ operationId: "normalization-fixture", commandName: "agentwheel fleet normalize", reason: "Normalize reviewed service ownership", noCommit: false, workspaceRoot: f.fleet, repositoryRoot: null, expectedHead: null, expectedManifestDigest: null, revisionMode: "off", provider: null, preexistingPaths: [], paths: [], runtimeJournals: [], status: "prepared" });
  mutations.push(GovernedMutation.activateExisting(receipt, undefined, { path: "fixture", release: async () => {} }));
}

describe.skipIf(process.getuid?.() === 0)("confined run-as fleet normalization", () => {
  it("plans deterministic identity and runtime guards and transfers only metadata", async () => {
    const f = await fixture(); const before = await readFile(f.runtimeFile);
    const plan = await planFleetNormalization(f.request);
    expect(plan.runAsIdentities).toEqual([f.identity]);
    expect(plan.runtimeGuards).toEqual([expect.objectContaining({ path: f.runtimeFile, kind: "file" })]);
    expect((await planFleetNormalization(f.request)).planDigest).toBe(plan.planDigest);
    await govern(f); await applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest });
    expect(await readFile(f.runtimeFile)).toEqual(before);
    expect(await readFile(plan.installedState.transfers[0]!.destinationManifestPath, "utf8")).toContain(workspaceOwnerForRoot(f.fleet, "delivery"));
    expect(fake.requests.some((request) => request.operation === "ownershipObservation")).toBe(true);
  });

  it("rejects stale runtime modes and requires an active caller receipt before locks", async () => {
    const f = await fixture(); const plan = await planFleetNormalization(f.request);
    const count = fake.requests.length;
    await expect(applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest })).rejects.toThrow(/durable mutation receipt/);
    expect(fake.requests).toHaveLength(count);
    await govern(f); await chmod(f.runtimeFile, 0o600);
    await expect(applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest })).rejects.toThrow(/stale|changed/);
  });

  it("rejects a service-writable caller graph descendant before target locks despite a private journal ancestor", async () => {
    const f = await fixture(); const plan = await planFleetNormalization(f.request); await govern(f);
    await chmod(join(f.fleet, ".agentwheel/locks"), 0o777);
    await expect(applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest })).rejects.toThrow(/Caller write destination/);
    expect(fake.requests.some(request => request.operation === "mkdirExclusive")).toBe(false);
    expect(await readFile(f.runtimeFile, "utf8")).toBe("legacy runtime bytes\n");
  });

  it("pins ignored bytes in directory snapshots even when the ordinary artifact hash is unchanged", async () => {
    const f = await fixture();
    const directory = join(f.runtime, "skills/core"); await mkdir(join(directory, "__pycache__"), { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "stable skill\n");
    const cache = join(directory, "__pycache__/cache.pyc"); await writeFile(cache, "before");
    const graph = JSON.parse(await readFile(f.graphPath, "utf8"));
    Object.assign(graph.canonical.artifacts[0], { type: "skills", name: "core", installName: "core", logicalSelector: "skills/core", relativePath: "skills/core", kind: "dir" });
    await json(f.graphPath, graph);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
    Object.assign(manifest.entries[0], { path: "skills/core", artifactType: "skills", artifactName: "core", installName: "core", logicalSelector: "skills/core", kind: "dir", hash: await hashPath(directory) });
    await json(f.manifest, manifest);
    const plan = await planFleetNormalization(f.request);
    await writeFile(cache, "after");
    const current = await planFleetNormalization(f.request);
    expect(current.runtimeGuards![0]!.hash).toBe(plan.runtimeGuards![0]!.hash);
    expect(current.runtimeGuards![0]!.snapshotDigest).not.toBe(plan.runtimeGuards![0]!.snapshotDigest);
    expect(current.planDigest).not.toBe(plan.planDigest);
    await govern(f);
    await expect(applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest })).rejects.toThrow(/stale|changed/);
  });

  it("refuses adapter modules before loading their code", async () => {
    const f = await fixture();
    const configPath = join(f.fleet, ".agentwheel/config.json"); const config = JSON.parse(await readFile(configPath, "utf8"));
    config.agents.runtime.adapterModule = join(f.root, "must-not-load.mjs"); await json(configPath, config);
    await expect(planFleetNormalization(f.request)).rejects.toThrow(/programmatic adapters before loading/);
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects service-controlled manifest root escapes before lock writes", async () => {
    const f = await fixture(); const value = JSON.parse(await readFile(f.manifest, "utf8")); value.targetRoot = join(f.root, "outside");
    await json(f.manifest, value); await govern(f);
    await expect(planFleetNormalization(f.request)).rejects.toThrow(/canonical|target root/);
    expect(fake.requests.some((request) => request.operation === "mkdirExclusive")).toBe(false);
    await expect(stat(join(f.root, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a private caller journal after a crash and guards identity and runtime before recovery", async () => {
    const f = await fixture(); const plan = await planFleetNormalization(f.request); await govern(f);
    await expect(applyFleetNormalization({ ...f.request, apply: true, planDigest: plan.planDigest }, { afterDestinationTransfer: () => { throw new Error("Injected normalization crash"); } })).rejects.toThrow(/Injected/);
    const journal = join(f.fleet, ".agentwheel/fleet-normalize-delivery.journal.json");
    expect((await stat(journal)).mode & 0o777).toBe(0o600);
    fake.uidDelta = 1; const before = fake.requests.filter((request) => request.operation === "mkdirExclusive").length;
    await expect(recoverFleetNormalization(f.request)).rejects.toThrow(/identity changed/);
    expect(fake.requests.filter((request) => request.operation === "mkdirExclusive")).toHaveLength(before);
    fake.uidDelta = 0; await writeFile(f.runtimeFile, "external runtime change\n");
    await expect(recoverFleetNormalization(f.request)).rejects.toThrow(/runtime CAS/);
    await writeFile(f.runtimeFile, "legacy runtime bytes\n");
    await expect(recoverFleetNormalization(f.request)).resolves.toMatchObject({ recovered: true });
    await expect(stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects user and cross-endpoint handoff before service writes", async () => {
    const f = await fixture();
    await expect(planFleetNormalization({ ...f.request, from: "user", agent: undefined })).rejects.toThrow(/same-fleet/);
    const other = join(f.root, "other-service"); await mkdir(other); fake.identities.set(other, { ...f.identity, root: other, home: other });
    const configPath = join(f.fleet, ".agentwheel/config.json"); const config = JSON.parse(await readFile(configPath, "utf8")); config.agents.other = { ...config.agents.runtime, root: other }; await json(configPath, config);
    await expect(planFleetNormalization(f.request)).rejects.toThrow(/one service endpoint/);
    expect(fake.requests.some((request) => request.operation === "mkdirExclusive")).toBe(false);
  });
});
