import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyArtifactOwnershipHandoff, planArtifactOwnershipHandoff, workspaceOwnerForRoot, type OwnershipHandoffRequest } from "../src/lifecycle/ownership.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { applyJournalPath, ownershipRuntimeSnapshot } from "../src/install/transaction.js";
import { recoverMutationRuntime, resumeMutation } from "../src/mutation/coordinator.js";
import { listMutationReceipts } from "../src/mutation/receipts.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

const execute = promisify(execFile), roots: string[] = [];
const original = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  if (original === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT; else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = original;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope = { installationType: "local", stateKey: "claude.local.legacy" };
const secret = "private-value-not-for-audit";
describe.sequential("native audited ownership handoff", () => {
  it("commits exactly one safe audit for a complete merge, without modifying runtime/config or other claims", async () => {
    const f = await fixture();
    const runtime = await ownershipRuntimeSnapshot(f.runtime), config = await readFile(f.config), before = await source(f);
    const p = await planArtifactOwnershipHandoff(f.request);
    await applyArtifactOwnershipHandoff(f.request);
    expect(await ownershipRuntimeSnapshot(f.runtime)).toBe(runtime);
    expect(await readFile(f.config)).toEqual(config);
    const after = await source(f);
    expect(after.entries[0]).toEqual({ ...before.entries[0], workspaceOwner: workspaceOwnerForRoot(f.workspace) });
    expect(after.entries[1]).toEqual(before.entries[1]);
    expect((await git(f.workspace, ["show", "--pretty=", "--name-only", "HEAD"])).trim()).toBe(".agentwheel/ownership-handoffs/fixture-handoff.json");
    const audit = await readFile(f.audit, "utf8");
    expect(JSON.parse(audit)).toMatchObject({ event: "ownership-handoff-intent", operationId: "fixture-handoff", plan: p });
    expect(audit).not.toMatch(/mergeRemoval|entries|hooks|private-value-not-for-audit/);
    const receipt = (await listMutationReceipts())[0]!;
    expect(receipt.status).toBe("succeeded");
    expect(receipt.paths.map((path) => path.path)).toEqual([".agentwheel/ownership-handoffs/fixture-handoff.json"]);
  });
  it("inherits registered Fleet policy for a legacy nested source and commits its one audit", async () => {
    const f = await fixture();
    const rootConfig = JSON.parse(await readFile(f.config, "utf8"));
    rootConfig.fleetId = "example";
    rootConfig.packages = [{ name: "example-pack", source: "./pack", driver: "local", mode: "pinned" }];
    await writeFile(f.config, JSON.stringify(rootConfig));
    await mkdir(join(f.home, ".agentwheel"));
    await writeFile(join(f.home, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 3, packages: [], fleets: {
      example: { root: f.workspace, requiredPackages: ["example-pack"] },
    } }));
    const nested = join(f.workspace, "profiles", "example");
    await mkdir(join(nested, ".agentwheel"), { recursive: true });
    await writeFile(join(nested, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 1, packages: [] }));
    await git(f.workspace, ["add", ".agentwheel/config.json", "profiles"]);
    await git(f.workspace, ["commit", "-m", "Declare nested source and Fleet contract"]);
    await applyArtifactOwnershipHandoff({ ...f.request, workspaceRoot: nested, toWorkspaceRoot: nested });
    expect((await git(f.workspace, ["show", "--pretty=", "--name-only", "HEAD"])).trim())
      .toBe("profiles/example/.agentwheel/ownership-handoffs/fixture-handoff.json");
    expect((await listMutationReceipts())[0]).toMatchObject({ status: "succeeded", workspaceRoot: nested });
  });

  it.each(["before", "after"])("recovers the same UUID after %s metadata write without replaying runtime operations", async (phase) => {
    const f = await fixture(); const runtime = await ownershipRuntimeSnapshot(f.runtime);
    let injected = false;
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      if (path === f.manifest && !injected && phase === "before") { injected = true; throw new Error("interrupted handoff"); }
      await localTransport.writeJsonAtomic(path, value);
      if (path === f.manifest && !injected && phase === "after") { injected = true; throw new Error("interrupted handoff"); }
    } };
    await expect(applyArtifactOwnershipHandoff({ ...f.request, transport })).rejects.toThrow(/interrupted/);
    expect((JSON.parse(await readFile(f.journal, "utf8"))).operations).toEqual([]);
    const recovered = await recoverMutationRuntime("fixture-handoff");
    expect(recovered.status).toBe("succeeded");
    expect((await resumeMutation("fixture-handoff", "recover")).status).toBe("succeeded");
    expect(await ownershipRuntimeSnapshot(f.runtime)).toBe(runtime);
    expect(await readdir(join(f.workspace, ".agentwheel/ownership-handoffs"))).toEqual(["fixture-handoff.json"]);
  });
  it.each(["audit", "journal", "runtime", "inventory"])("refuses %s tampering during recovery", async (kind) => {
    const f = await fixture();
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      if (path === f.manifest) throw new Error("interrupted handoff");
      await localTransport.writeJsonAtomic(path, value);
    } };
    await expect(applyArtifactOwnershipHandoff({ ...f.request, transport })).rejects.toThrow(/interrupted/);
    if (kind === "audit") await writeFile(f.audit, "tampered");
    if (kind === "journal") { const j = JSON.parse(await readFile(f.journal, "utf8")); j.metadataAudit.auditFiles[0].content += "tampered"; await writeFile(f.journal, JSON.stringify(j)); }
    if (kind === "runtime") await writeFile(f.runtime, "changed");
    if (kind === "inventory") { const m = await source(f); await writeInstallManifest({ ...m, adapter: "other", stateKey: "other.local", entries: [] }); }
    const before = await readFile(f.manifest);
    await expect(recoverMutationRuntime("fixture-handoff")).rejects.toThrow(/changed|digest|CAS|identity/i);
    expect(await readFile(f.manifest)).toEqual(before);
  });
  it.each(["revision", "hash", "ignored", "provider"])("rejects %s before ownership metadata/audit writes", async (kind) => {
    const f = await fixture(kind === "provider");
    const request = { ...f.request };
    if (kind === "revision") request.expectedRevision = "b".repeat(64);
    if (kind === "hash") request.expectedHash = "b".repeat(64);
    if (kind === "ignored") { await writeFile(join(f.workspace, ".gitignore"), ".agentwheel/ownership-handoffs/\n"); await git(f.workspace, ["add", ".gitignore"]); await git(f.workspace, ["commit", "-m", "Declare ignored path"]); }
    const before = await readFile(f.manifest), runtime = await ownershipRuntimeSnapshot(f.runtime);
    await expect(applyArtifactOwnershipHandoff(request)).rejects.toThrow(/revision|hash|ignored|rejection/i);
    expect(await readFile(f.manifest)).toEqual(before);
    expect(await ownershipRuntimeSnapshot(f.runtime)).toBe(runtime);
    await expect(readFile(f.audit)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
async function git(root: string, args: string[]) { return (await execute("git", ["-C", root, ...args])).stdout; }
async function fixture(rejecting = false) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-audited-handoff-")); roots.push(root);
  const workspace = join(root, "workspace"), target = join(root, "target"), home = join(root, "home");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true }); await mkdir(join(target, ".claude"), { recursive: true }); await mkdir(home);
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(root, "mutation-state");
  const config = join(workspace, ".agentwheel/config.json"), runtime = join(target, ".claude/settings.json");
  await writeFile(runtime, JSON.stringify({ example: { value: secret }, retained: true }));
  let provider: unknown = { kind: "git", protocolVersion: 1 };
  if (rejecting) {
    const script = join(root, "provider.mjs");
    await writeFile(script, `let s='';for await(const x of process.stdin)s+=x;const q=JSON.parse(s);process.stdout.write(JSON.stringify({protocolVersion:1,providerId:'fixture',action:q.action,operationId:q.operationId,ok:false,status:'rejected',error:{code:'blocked',message:'blocked by fixture'}}));`);
    provider = { kind: "command", id: "fixture", protocolVersion: 1, command: [process.execPath, script], trustBoundary: "entrypoint", executableSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") };
  }
  await writeFile(config, JSON.stringify({ schemaVersion: 4, packages: [], mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "commit-after-verify", allowNoCommitOverride: false, reasonInCommit: "full", provider } } }));
  await git(workspace, ["init", "-b", "main"]); await git(workspace, ["config", "user.name", "Fixture Maintainer"]); await git(workspace, ["config", "user.email", "fixture@example.test"]);
  await git(workspace, ["add", ".agentwheel/config.json"]); await git(workspace, ["commit", "-m", "Declare governed source"]);
  const entry = { path: ".claude/settings.json", artifactType: "settings" as const, artifactName: "example.json", kind: "file" as const, hash: "a".repeat(64), sourceHash: "a".repeat(64), updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed" as const, installName: "example.json", owners: ["example/pack"], refCount: 1, dependencyRole: "root" as const, workspaceOwner: workspaceOwnerForRoot(join(root, "old")), mergeStrategy: "json-deep" as const, mergeRemoval: { example: { value: secret } } };
  await writeInstallManifest({ version: 2, adapter: "claude", ...scope, targetRoot: target, generatedAt: entry.updatedAt, revision: "fixture-pending-revision", legacy: false, entries: [entry, { ...entry, path: "unrelated.txt", artifactType: "rules", artifactName: "unrelated.txt", mergeStrategy: undefined, mergeRemoval: undefined }] });
  const manifest = installManifestPath(target, "claude", scope);
  const m = await readInstallManifest(target, "claude", localTransport, scope); if (!m) throw new Error("missing fixture");
  const request: OwnershipHandoffRequest = { workspaceRoot: workspace, globalRoot: home, targetRoot: target, adapter: "claude", ...scope, artifactType: "settings", artifactName: "example.json", fromWorkspaceRoot: join(root, "old"), toWorkspaceRoot: workspace, expectedHash: entry.hash, expectedRevision: m.revision, operationId: "fixture-handoff", reason: "Transfer reviewed ownership without runtime changes" };
  return { root, workspace, target, home, config, runtime, manifest, request, audit: join(workspace, ".agentwheel/ownership-handoffs/fixture-handoff.json"), journal: applyJournalPath(target, "claude", scope) };
}
async function source(f: Awaited<ReturnType<typeof fixture>>) {
  const m = await readInstallManifest(f.target, "claude", localTransport, scope);
  if (!m || m.version !== 2) throw new Error("missing fixture"); return m;
}
