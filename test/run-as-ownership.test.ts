import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAdoptLegacyOwnership, planAdoptLegacyOwnership, type AdoptLegacyOwnershipRequest } from "../src/lifecycle/ownership-adopt-legacy.js";
import { applyRetireStaleOwnership, planRetireStaleOwnership, type RetireStaleOwnershipRequest } from "../src/lifecycle/ownership-retire-stale.js";
import { applyReleaseOwnership, planReleaseOwnership, type ReleaseOwnershipRequest } from "../src/lifecycle/ownership-release.js";
import { applyArtifactOwnershipHandoff, planArtifactOwnershipHandoff } from "../src/lifecycle/ownership.js";
import { installManifestPath } from "../src/install/paths.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { canonicalGraphLockJson, writeGraphLock, type GraphLock } from "../src/model/graph-lock.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../src/model/manifest.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import { GovernedMutation } from "../src/mutation/coordinator.js";
import { createRunAsTransport } from "../src/transport/run-as.js";
import { executeRequest } from "../src/transport/run-as-worker.js";
import type { TargetTransport } from "../src/transport/index.js";

// Allow real helper subprocesses to finish under full-suite contention.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
const originalState = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
const selected = ".openclaw/skills/fixture", fingerprint = "a".repeat(64);
const sourceKey = `openclaw.user.${fingerprint}`, destinationKey = "openclaw.user.stable";
afterEach(async () => {
  if (originalState === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalState;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Exercise the real Node protocol and Python/openat2 helper without sudo or
// account mutations. Only the subprocess/identity boundary is injected. The
// immutable system Python binary satisfies the code-trust seam on any Linux
// Node installation; no /usr/bin/node assumption is necessary. The public
// identity is the real nobody account so caller-write checks use its real
// groups, while the injected boundary runs the helper as the test caller.
function serviceTransport(root: string): TargetTransport {
  const record = spawnSync("/usr/bin/getent", ["passwd", "nobody"], { encoding: "utf8" });
  if (record.status !== 0) throw new Error("The ownership trust fixture requires the system nobody account");
  const fields = record.stdout.trim().split(":");
  const identity = { user: "nobody", uid: Number(fields[2]), gid: Number(fields[3]), home: root, root };
  return createRunAsTransport(identity, async (_command, _args, input) => {
    if (input === undefined) return { stdout: `${identity.uid}\n` };
    try {
      return { stdout: JSON.stringify({ version: 1, result: await executeRequest(root, uid, gid, JSON.parse(input)) }) };
    } catch (error) {
      return { stdout: JSON.stringify({ version: 1, error: { message: (error as Error).message, code: (error as NodeJS.ErrnoException).code } }) };
    }
  }, "/fixture/run-as-worker.mjs", "/usr/bin/python3");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-ownership-test-")); roots.push(root);
  const target = join(root, "target"), workspace = join(root, "workspace"), scratch = join(root, "scratch"), home = join(root, "home");
  for (const path of [target, workspace, scratch, home]) await mkdir(path, { mode: 0o700 });
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(root, "mutation-state");
  const policy = { schemaVersion: 4, packages: [], mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "off" } } };
  for (const path of [workspace, scratch, home]) {
    await mkdir(join(path, ".agentwheel"));
    await writeFile(join(path, ".agentwheel/config.json"), JSON.stringify(policy));
  }
  const artifact = join(target, selected);
  await mkdir(join(artifact, "__pycache__"), { recursive: true, mode: 0o700 });
  await writeFile(join(artifact, "SKILL.md"), "Fixture bytes.\n", { mode: 0o640 });
  await writeFile(join(artifact, "__pycache__/cache.pyc"), Buffer.from([0, 255]), { mode: 0o600 });
  const transport = serviceTransport(target);
  const hash = await transport.hashPath(artifact);
  const node = "fixture/skills@1.0.0+" + "b".repeat(64), selector = `${node}:skills/fixture`;
  const lock: GraphLock = { version: 1, canonical: { targetFingerprint: fingerprint,
    roots: [], nodes: [], edges: [], includeEdges: [], namespacing: [], overrides: [], plainNameIncumbents: [],
    artifacts: [{ graphNodeId: node, dependencyRole: "root", type: "skills", name: "fixture", installName: "fixture",
      logicalSelector: selector, owners: ["fixture"], relativePath: "skills/fixture", kind: "dir", hash, channel: "managed" }] } };
  const lockPath = join(scratch, ".agentwheel/locks/service/openclaw", `${fingerprint}.graph-lock.json`);
  await mkdir(dirname(lockPath), { recursive: true }); await writeGraphLock(lockPath, lock);
  const entry: InstallManifestEntry = { path: selected, artifactType: "skills", artifactName: "fixture", installName: "fixture",
    kind: "dir", hash, sourceHash: hash, channel: "managed", updatedAt: "2026-01-01T00:00:00.000Z",
    owners: ["fixture"], refCount: 1, workspaceOwner: workspaceOwnerForRoot(scratch), graphNodeId: node,
    logicalSelector: selector, graphLockDigest: createHash("sha256").update(canonicalGraphLockJson(lock)).digest("hex"), dependencyRole: "root" };
  const manifest: InstallManifestV2 = { version: 2, adapter: "openclaw", installationType: "user", stateKey: sourceKey,
    targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z", revision: "0".repeat(64), legacy: false, entries: [entry] };
  await writeInstallManifest(manifest);
  const adopt: AdoptLegacyOwnershipRequest = { targetRoot: target, adapter: "openclaw", installationType: "user",
    sourceStateKey: sourceKey, destinationStateKey: destinationKey, fromWorkspaceRoot: scratch,
    workspaceRoot: workspace, globalRoot: home, transport,
    destinationGraphLockPath: join(workspace, ".agentwheel/locks/service/openclaw/stable.graph-lock.json"),
    desiredCoverage: [{ path: selected, artifactType: "skills", artifactName: "fixture", kind: "dir" }] };
  const release: ReleaseOwnershipRequest = { workspaceRoot: workspace, fromWorkspaceRoot: scratch,
    targetRoot: target, adapter: "openclaw", installationType: "user", stateKey: sourceKey,
    selector: "skills/fixture", path: selected, reason: "Release the reviewed synthetic claim", globalRoot: home, transport };
  return { root, target, workspace, scratch, home, artifact, transport, manifest, entry, adopt, release, lockPath };
}
async function governed<T>(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<T>): Promise<T> {
  const mutation = await GovernedMutation.begin({ workspaceRoot: f.workspace, globalRoot: f.home,
    commandName: "agentwheel ownership fixture", reason: "Apply reviewed synthetic ownership metadata" });
  try { const result = await action(); await mutation?.complete(); return result; }
  catch (error) { await mutation?.fail(error); throw error; }
}
function reviewedRelease(request: ReleaseOwnershipRequest, plan: Awaited<ReturnType<typeof planReleaseOwnership>>) {
  return { ...request, planDigest: plan.planDigest, expectedSourceRevision: plan.source.revision, expectedInventoryRevision: plan.manifestInventoryRevision };
}
function reviewedAdoption(request: AdoptLegacyOwnershipRequest, plan: Awaited<ReturnType<typeof planAdoptLegacyOwnership>>) {
  return { ...request, planDigest: plan.planDigest, expectedSourceRevision: plan.source.revision,
    expectedDestinationRevision: plan.destination.revision ?? "absent", expectedInventoryRevision: plan.manifestInventoryRevision };
}
async function retireRequest(f: Awaited<ReturnType<typeof fixture>>) {
  await writeInstallManifest({ ...f.manifest, stateKey: destinationKey,
    entries: [{ ...f.entry, workspaceOwner: workspaceOwnerForRoot(f.workspace, "fixture") }] });
  const request: RetireStaleOwnershipRequest = { targetRoot: f.target, adapter: "openclaw", installationType: "user",
    sourceStateKey: sourceKey, destinationStateKey: destinationKey, fromWorkspaceRoot: f.scratch,
    toWorkspaceRoot: f.workspace, toFleetId: "fixture", transport: f.transport };
  const p = await planRetireStaleOwnership(request);
  return { ...request, planDigest: p.planDigest, expectedSourceRevision: p.source.revision,
    expectedDestinationRevision: p.destination.revision, expectedInventoryRevision: p.manifestInventoryRevision };
}

describe.skipIf(process.platform !== "linux" || uid === 0).sequential("confined run-as ownership metadata", () => {
  it("adopts and retires metadata only with a durable caller receipt, preserving every runtime byte and mode", async () => {
    const f = await fixture(), before = await f.transport.ownershipObservation!(f.artifact), lock = await readFile(f.lockPath);
    const plan = await planAdoptLegacyOwnership(f.adopt), request = reviewedAdoption(f.adopt, plan);
    expect(plan.metadataGuards?.inventory).toHaveLength(1);
    expect(plan.selected[0]?.runtimeSnapshotDigest).toBe(before.snapshotDigest);
    expect(plan.transport?.identity).toEqual(f.transport.runAsIdentity);
    await expect(applyAdoptLegacyOwnership(request)).rejects.toThrow(/durable.*receipt/i);
    expect(await governed(f, () => applyAdoptLegacyOwnership(request))).toMatchObject({ applied: true, sourceManifestRemoved: true });
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(before);
    expect(await readFile(f.lockPath)).toEqual(lock);
    const adopted = await readInstallManifest(f.target, "openclaw", f.transport, { installationType: "user", stateKey: destinationKey });
    if (!adopted || adopted.version !== 2) throw new Error("Expected a v2 adopted manifest");
    expect(adopted.entries[0]?.workspaceOwner).toBe(workspaceOwnerForRoot(f.workspace));
  }, 30_000);

  it("retires an exactly covered stale claim without changing runtime or the destination manifest", async () => {
    const f = await fixture(), before = await f.transport.ownershipObservation!(f.artifact);
    const request = await retireRequest(f);
    const destination = await readFile(installManifestPath(f.target, "openclaw", { installationType: "user", stateKey: destinationKey }));
    await expect(applyRetireStaleOwnership(request)).rejects.toThrow(/durable.*receipt/i);
    expect(await governed(f, () => applyRetireStaleOwnership(request))).toMatchObject({ sourceManifestRemoved: true });
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(before);
    expect(await readFile(installManifestPath(f.target, "openclaw", { installationType: "user", stateKey: destinationKey }))).toEqual(destination);
  }, 30_000);

  it("releases a claim through the service and writes its audit only in the caller workspace", async () => {
    const f = await fixture(), before = await f.transport.ownershipObservation!(f.artifact);
    const result = await applyReleaseOwnership(reviewedRelease(f.release, await planReleaseOwnership(f.release)));
    expect(result.applied).toBe(true);
    expect(result.auditPath.startsWith(f.workspace + "/")).toBe(true);
    expect(JSON.parse(await readFile(result.auditPath, "utf8")).plan.transport.identity).toEqual(f.transport.runAsIdentity);
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(before);
    expect((await readInstallManifest(f.target, "openclaw", f.transport, { installationType: "user", stateKey: sourceKey }))?.entries).toEqual([]);
  }, 30_000);

  it("requires a digest-reviewed audited handoff and preserves ignored content and modes", async () => {
    const f = await fixture(), before = await f.transport.ownershipObservation!(f.artifact);
    const request = { targetRoot: f.target, workspaceRoot: f.workspace, globalRoot: f.home, adapter: "openclaw",
      installationType: "user", stateKey: sourceKey, artifactType: "skills", artifactName: "fixture",
      fromWorkspaceRoot: f.scratch, toWorkspaceRoot: f.workspace, transport: f.transport, reason: "Handoff synthetic ownership" };
    const plan = await planArtifactOwnershipHandoff(request);
    const reviewed = { ...request, expectedHash: plan.artifactHash, expectedRevision: plan.manifestRevision,
      planDigest: plan.planDigest, expectedInventoryRevision: plan.manifestInventoryRevision };
    await expect(applyArtifactOwnershipHandoff({ ...reviewed, planDigest: undefined })).rejects.toThrow(/reviewed/i);
    await applyArtifactOwnershipHandoff(reviewed);
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(before);
    const handedOff = await readInstallManifest(f.target, "openclaw", f.transport, { installationType: "user", stateKey: sourceKey });
    if (!handedOff || handedOff.version !== 2) throw new Error("Expected a v2 handoff manifest");
    expect(handedOff.entries[0]?.workspaceOwner).toBe(workspaceOwnerForRoot(f.workspace));
  }, 30_000);

  it("round-trips fleet-qualified service ownership with exact audited fromOwner and unchanged runtime and sibling claims", async () => {
    const f = await fixture();
    const sibling = { ...f.entry, path: ".openclaw/skills/retained", artifactName: "retained", installName: "retained",
      logicalSelector: "skills/retained", workspaceOwner: workspaceOwnerForRoot(f.home) };
    await writeInstallManifest({ ...f.manifest, entries: [f.entry, sibling] });
    const before = await f.transport.ownershipObservation!(f.artifact);
    const request = { targetRoot: f.target, workspaceRoot: f.workspace, globalRoot: f.home, adapter: "openclaw",
      installationType: "user", stateKey: sourceKey, artifactType: "skills", artifactName: "fixture",
      fromWorkspaceRoot: f.scratch, toWorkspaceRoot: f.scratch, toFleetId: "delivery", transport: f.transport,
      reason: "Round-trip reviewed synthetic ownership", operationId: "service-qualify" };
    const first = await planArtifactOwnershipHandoff(request);
    await applyArtifactOwnershipHandoff({ ...request, expectedHash: first.artifactHash, expectedRevision: first.manifestRevision,
      planDigest: first.planDigest, expectedInventoryRevision: first.manifestInventoryRevision });
    const qualified = await readInstallManifest(f.target, "openclaw", f.transport, { installationType: "user", stateKey: sourceKey });
    if (!qualified || qualified.version !== 2) throw new Error("Expected a v2 qualified handoff manifest");
    expect(qualified.entries[0]?.workspaceOwner).toBe(workspaceOwnerForRoot(f.scratch, "delivery"));
    expect(qualified?.entries[1]).toEqual(sibling);
    const reverse = { ...request, toFleetId: undefined, fromFleetId: "delivery", operationId: "service-unqualify" };
    const plan = await planArtifactOwnershipHandoff(reverse);
    expect(plan.fromOwner).toBe(workspaceOwnerForRoot(f.scratch, "delivery"));
    expect(plan.toOwner).toBe(workspaceOwnerForRoot(f.scratch));
    expect(plan.planDigest).not.toBe(first.planDigest);
    await applyArtifactOwnershipHandoff({ ...reverse, expectedHash: plan.artifactHash, expectedRevision: plan.manifestRevision,
      planDigest: plan.planDigest, expectedInventoryRevision: plan.manifestInventoryRevision });
    const audit = JSON.parse(await readFile(join(f.workspace, ".agentwheel/ownership-handoffs/service-unqualify.json"), "utf8"));
    expect(audit.plan.fromOwner).toBe(workspaceOwnerForRoot(f.scratch, "delivery"));
    expect(audit.plan.transport.identity).toEqual(f.transport.runAsIdentity);
    expect((await readInstallManifest(f.target, "openclaw", f.transport, { installationType: "user", stateKey: sourceKey }))?.entries)
      .toEqual([f.entry, sibling]);
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(before);
  });

  it.each(["digest", "inventory", "source-revision", "runtime-mode", "owner", "root", "hash"])("rejects a fleet-source handoff with stale or wrong %s without claim or audit writes", async kind => {
    const f = await fixture();
    await writeInstallManifest({ ...f.manifest, entries: [{ ...f.entry, workspaceOwner: workspaceOwnerForRoot(f.scratch, "delivery") }] });
    const request = { targetRoot: f.target, workspaceRoot: f.workspace, globalRoot: f.home, adapter: "openclaw",
      installationType: "user", stateKey: sourceKey, artifactType: "skills", artifactName: "fixture",
      fromWorkspaceRoot: f.scratch, fromFleetId: "delivery", toWorkspaceRoot: f.scratch, transport: f.transport,
      reason: "Reject changed synthetic source ownership", operationId: `reject-source-${kind}` };
    const plan = await planArtifactOwnershipHandoff(request);
    if (kind === "inventory") await writeInstallManifest({ ...f.manifest, adapter: "other", stateKey: "other.user.fixture", entries: [] });
    if (kind === "source-revision") await writeInstallManifest({ ...f.manifest, generatedAt: "2026-01-02T00:00:00.000Z",
      entries: [{ ...f.entry, workspaceOwner: workspaceOwnerForRoot(f.scratch, "delivery") }] });
    if (kind === "runtime-mode") await chmod(join(f.artifact, "SKILL.md"), 0o600);
    const manifestPath = installManifestPath(f.target, "openclaw", { installationType: "user", stateKey: sourceKey });
    const before = await readFile(manifestPath), runtime = await f.transport.ownershipObservation!(f.artifact);
    await expect(applyArtifactOwnershipHandoff({ ...request, expectedHash: kind === "hash" ? "0".repeat(64) : plan.artifactHash,
      expectedRevision: plan.manifestRevision, planDigest: kind === "digest" ? "f".repeat(64) : plan.planDigest,
      expectedInventoryRevision: plan.manifestInventoryRevision,
      ...(kind === "owner" ? { fromFleetId: "another" } : {}), ...(kind === "root" ? { fromWorkspaceRoot: f.workspace } : {}),
    })).rejects.toThrow(/stale|replan|precondition/i);
    expect(await readFile(manifestPath)).toEqual(before);
    expect(await f.transport.ownershipObservation!(f.artifact)).toEqual(runtime);
    await expect(readFile(join(f.workspace, ".agentwheel/ownership-handoffs", `${request.operationId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["user", "uid", "gid", "home", "root"] as const)("pins the service %s in every reviewed plan", async field => {
    const f = await fixture();
    const plans = [await planAdoptLegacyOwnership(f.adopt), await planReleaseOwnership(f.release)];
    const current = f.transport.runAsIdentity!;
    const identity = { ...current, [field]: field === "uid" || field === "gid" ? current[field] + 1 : current[field] + "-changed" };
    const transport = { ...f.transport, runAsIdentity: identity };
    if (field === "root") {
      await expect(planAdoptLegacyOwnership({ ...f.adopt, transport })).rejects.toThrow(/same-endpoint/);
      await expect(planReleaseOwnership({ ...f.release, transport })).rejects.toThrow(/same-endpoint/);
    } else {
      expect((await planAdoptLegacyOwnership({ ...f.adopt, transport })).planDigest).not.toBe(plans[0]!.planDigest);
      const changed = { ...reviewedRelease(f.release, plans[1] as Awaited<ReturnType<typeof planReleaseOwnership>>), transport };
      await expect(applyReleaseOwnership(changed)).rejects.toThrow();
    }
  }, 30_000);

  it.each(["ignored-bytes", "mode", "source-revision", "inventory", "digest"])("rejects stale %s before ownership/audit writes", async kind => {
    const f = await fixture(), plan = await planReleaseOwnership(f.release);
    if (kind === "ignored-bytes") await writeFile(join(f.artifact, "__pycache__/cache.pyc"), "changed ignored bytes");
    if (kind === "mode") await chmod(join(f.artifact, "SKILL.md"), 0o600);
    if (kind === "source-revision") await writeInstallManifest({ ...f.manifest, generatedAt: "2026-01-02T00:00:00.000Z" });
    if (kind === "inventory") await writeInstallManifest({ ...f.manifest, adapter: "other", stateKey: "other.user.fixture", entries: [] });
    const path = installManifestPath(f.target, "openclaw", { installationType: "user", stateKey: sourceKey });
    const before = await readFile(path);
    await expect(applyReleaseOwnership({ ...reviewedRelease(f.release, plan), ...(kind === "digest" ? { planDigest: "f".repeat(64) } : {}) }))
      .rejects.toThrow(/stale|replan/i);
    expect(await readFile(path)).toEqual(before);
    expect(await f.transport.pathExists(join(f.target, ".agentwheel/ownership-releases"))).toBe(false);
  }, 30_000);

  it.each(["release", "handoff"])("rejects a service-writable %s audit descendant before any target lock or write", async kind => {
    const f = await fixture();
    const mutations: string[] = [];
    const transport: TargetTransport = {
      ...f.transport,
      mkdirExclusive: async path => { mutations.push("mkdir"); await f.transport.mkdirExclusive(path); },
      writeFileAtomic: async (path, value) => { mutations.push("write"); await f.transport.writeFileAtomic(path, value); },
      writeJsonAtomic: async (path, value) => { mutations.push("write-json"); await f.transport.writeJsonAtomic(path, value); },
      rm: async path => { mutations.push("remove"); await f.transport.rm(path); },
    };
    // The receipt store remains caller-private. Only a descendant of the
    // audit tree is writable by the unrelated service account, through real
    // Unix permissions. Caller-owned ancestors remain immutable to that user.
    const auditDirectory = join(f.workspace, ".agentwheel", kind === "release" ? "ownership-releases" : "ownership-handoffs");
    await mkdir(auditDirectory);
    await chmod(f.root, 0o755);
    await chmod(f.workspace, 0o755);
    await chmod(join(f.workspace, ".agentwheel"), 0o755);
    await chmod(auditDirectory, 0o777);
    const manifest = installManifestPath(f.target, "openclaw", { installationType: "user", stateKey: sourceKey });
    const before = await readFile(manifest);
    if (kind === "release") {
      const request = { ...f.release, transport };
      await expect(applyReleaseOwnership(reviewedRelease(request, await planReleaseOwnership(request))))
        .rejects.toThrow(/caller write destination.*immutable/i);
    } else {
      const request = { targetRoot: f.target, workspaceRoot: f.workspace, globalRoot: f.home, adapter: "openclaw",
        installationType: "user", stateKey: sourceKey, artifactType: "skills", artifactName: "fixture",
        fromWorkspaceRoot: f.scratch, toWorkspaceRoot: f.workspace, transport, reason: "Reject an unsafe synthetic audit" };
      const plan = await planArtifactOwnershipHandoff(request);
      await expect(applyArtifactOwnershipHandoff({ ...request, expectedHash: plan.artifactHash,
        expectedRevision: plan.manifestRevision, planDigest: plan.planDigest,
        expectedInventoryRevision: plan.manifestInventoryRevision }))
        .rejects.toThrow(/caller write destination.*immutable/i);
    }
    expect(mutations).toEqual([]);
    expect(await readFile(manifest)).toEqual(before);
  }, 30_000);

  it("detects a mode-only SUID change while keeping ordinary copy hashes unchanged", async () => {
    const f = await fixture(), plan = await planReleaseOwnership(f.release);
    const hash = await f.transport.hashPath(f.artifact), before = await f.transport.ownershipObservation!(f.artifact);
    await chmod(join(f.artifact, "SKILL.md"), 0o4640);
    expect(await f.transport.hashPath(f.artifact)).toBe(hash);
    expect((await f.transport.ownershipObservation!(f.artifact)).snapshotDigest).not.toBe(before.snapshotDigest);
    await expect(applyReleaseOwnership(reviewedRelease(f.release, plan))).rejects.toThrow(/stale|replan/i);
  }, 30_000);

  it.each(["symlink", "hardlink", "fifo", "missing-observation", "missing-runtime"])("fails closed for %s", async kind => {
    const f = await fixture();
    if (kind === "symlink") await symlink(f.lockPath, join(f.artifact, "__pycache__/escape"));
    if (kind === "hardlink") await link(join(f.artifact, "SKILL.md"), join(f.artifact, "__pycache__/hardlink"));
    if (kind === "fifo") expect(spawnSync("/usr/bin/mkfifo", [join(f.artifact, "__pycache__/fifo")]).status).toBe(0);
    const transport = kind === "missing-observation" ? { ...f.transport, ownershipObservation: undefined } : f.transport;
    if (kind === "missing-runtime") await rm(f.artifact, { recursive: true });
    await expect(planReleaseOwnership({ ...f.release, transport })).rejects.toThrow();
    await expect(planAdoptLegacyOwnership({ ...f.adopt, transport, carryDrift: true })).rejects.toThrow();
  }, 30_000);
});
