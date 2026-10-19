import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyReleaseOwnership, planReleaseOwnership, type ReleaseOwnershipRequest } from "../src/lifecycle/ownership-release.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { recoverPendingApply } from "../src/install/apply.js";
import { installManifestPath, sourceLockPath } from "../src/install/paths.js";
import { abortApplyJournal, applyJournalPath, ownershipRuntimeSnapshot } from "../src/install/transaction.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../src/model/manifest.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";
import { recoverMutationRuntime } from "../src/mutation/coordinator.js";

const execute = promisify(execFile);
const roots: string[] = [];
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  if (originalStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalStateRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("ownership claim release", () => {
  it("retires only the selected claim, preserving all runtime bytes, five unknown claims, config and lock", async () => {
    const f = await fixture(5);
    const before = await ownershipRuntimeSnapshot(join(f.target, ".runtime"));
    const configBefore = await readFile(f.config);
    const stateBefore = await source(f);
    const lockBefore = await readFile(f.lock);
    const selectedMtime = (await stat(join(f.target, selected))).mtimeMs;
    const p = await planReleaseOwnership(f.request);
    expect(p.recordedHash).not.toBe(p.runtimeHash);
    expect(p.source.entry.hash).toBe(stateBefore.entries[0]!.hash);
    const result = await applyReleaseOwnership(reviewed(f.request, p));
    expect(result.retainedEntries).toBe(5);
    expect((await source(f)).entries).toEqual(stateBefore.entries.slice(1));
    expect(await ownershipRuntimeSnapshot(join(f.target, ".runtime"))).toBe(before);
    expect((await stat(join(f.target, selected))).mtimeMs).toBe(selectedMtime);
    expect(await readFile(f.config)).toEqual(configBefore);
    expect(await readFile(f.lock)).toEqual(lockBefore);
    const audit = JSON.parse(await readFile(result.auditPath, "utf8"));
    expect(audit).toMatchObject({ event: "ownership-release-intent", reviewedPlanDigest: p.planDigest, plan: p });
    expect(audit.plan.recordedHash).not.toBe(audit.plan.runtimeHash);
    await expect(stat(journalPath(f))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an empty source manifest and source lock rather than removing package state", async () => {
    const f = await fixture();
    const lockBefore = await readFile(f.lock);
    await applyReleaseOwnership(reviewed(f.request, await planReleaseOwnership(f.request)));
    expect((await source(f)).entries).toEqual([]);
    expect(await readFile(f.lock)).toEqual(lockBefore);
  });

  it("planning is pure and repeatable", async () => {
    const f = await fixture(5);
    const before = await treeFiles(f.root);
    const one = await planReleaseOwnership(f.request);
    expect(await planReleaseOwnership(f.request)).toEqual(one);
    expect(await treeFiles(f.root)).toEqual(before);
  });

  it.each(["runtime", "ignored-runtime", "source", "inventory"])("rejects stale %s before audit/manifest writes", async (change) => {
    const f = await fixture();
    const p = await planReleaseOwnership(f.request);
    if (change === "runtime") await writeFile(join(f.target, selected, "SKILL.md"), "changed\n");
    if (change === "ignored-runtime") {
      await mkdir(join(f.target, selected, "__pycache__"));
      await writeFile(join(f.target, selected, "__pycache__", "cache.pyc"), "ignored by ordinary artifact hash");
    }
    if (change === "source") await writeInstallManifest({ ...await source(f), generatedAt: "2026-01-02T00:00:00.000Z" });
    if (change === "inventory") await writeInstallManifest({ ...await source(f), adapter: "other", stateKey: "other.local", entries: [] });
    const stateBefore = await readFile(f.manifest);
    await expect(applyReleaseOwnership(reviewed(f.request, p))).rejects.toThrow(/stale|replan/i);
    expect(await readFile(f.manifest)).toEqual(stateBefore);
    await expect(stat(f.auditDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(journalPath(f))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["owner", "target", "selector", "escape", "merge", "shared", "cross-adapter"])("refuses %s claims", async (kind) => {
    const f = await fixture();
    const request = { ...f.request };
    if (kind === "owner") request.fromWorkspaceRoot = join(f.root, "other-owner");
    if (kind === "selector") request.selector = "skills/other";
    if (kind === "escape") request.path = "../escape";
    if (kind === "target") await writeInstallManifest({ ...await source(f), targetRoot: join(f.root, "wrong") });
    if (kind === "target") {
      const raw = JSON.parse(await readFile(f.manifest, "utf8"));
      raw.targetRoot = join(f.root, "wrong");
      await writeFile(f.manifest, JSON.stringify(raw));
    }
    if (kind === "merge") {
      const current = await source(f);
      await writeInstallManifest({ ...current, entries: [{ ...current.entries[0]!, mergeStrategy: "json-deep" }] });
    }
    if (kind === "shared") {
      const current = await source(f);
      await writeInstallManifest({ ...current, entries: [current.entries[0]!, { ...current.entries[0]!, artifactName: "other", logicalSelector: "skills/other" }] });
    }
    if (kind === "cross-adapter") await writeInstallManifest({ ...await source(f), adapter: "other", stateKey: "other.local" });
    await expect(planReleaseOwnership(request)).rejects.toThrow();
  });

  it.each(["ancestor", "descendant", "audit-directory"])("rejects %s symlinks", async (kind) => {
    const f = await fixture();
    if (kind === "ancestor") {
      const runtime = join(f.target, ".runtime");
      const moved = join(f.root, "moved-runtime");
      const { rename } = await import("node:fs/promises");
      await rename(runtime, moved);
      await symlink(moved, runtime);
    } else if (kind === "descendant") await symlink(f.config, join(f.target, selected, "linked-file"));
    else await symlink(join(f.root, "outside"), f.auditDirectory);
    if (kind === "audit-directory") {
      const p = await planReleaseOwnership(f.request);
      await expect(applyReleaseOwnership(reviewed(f.request, p))).rejects.toThrow(/symlink/i);
    } else await expect(planReleaseOwnership(f.request)).rejects.toThrow(/symlink|unsupported/i);
  });

  it.each(["before-state", "after-state"])("records partial %s failure and recovers idempotently without runtime writes", async (phase) => {
    const f = await fixture(5);
    const before = await ownershipRuntimeSnapshot(join(f.target, ".runtime"));
    const p = await planReleaseOwnership(f.request);
    let injected = false;
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, data) => {
      if (path === f.manifest && !injected && phase === "before-state") {
        injected = true; throw new Error("injected before state");
      }
      await localTransport.writeJsonAtomic(path, data);
      if (path === f.manifest && !injected && phase === "after-state") {
        injected = true; throw new Error("injected after state");
      }
    } };
    await expect(applyReleaseOwnership({ ...reviewed(f.request, p), transport })).rejects.toThrow(/injected/);
    expect(await readdir(f.auditDirectory)).toEqual(["fixture-release.json"]);
    await expect(stat(journalPath(f))).resolves.toBeTruthy();
    await expect(abortApplyJournal(f.target, "fixture", localTransport, scope)).rejects.toThrow(/must be recovered/);
    const recovered = await recoverPendingApply(f.target, "fixture", localTransport, scope);
    expect(recovered?.entries).toEqual((await source(f)).entries);
    expect(recovered?.entries).toHaveLength(5);
    expect(await ownershipRuntimeSnapshot(join(f.target, ".runtime"))).toBe(before);
    expect(await recoverPendingApply(f.target, "fixture", localTransport, scope)).toBeUndefined();
  });

  it.each(["runtime", "inventory", "audit", "manifest"])("preserves concurrent %s changes during partial recovery", async (kind) => {
    const f = await fixture();
    const p = await planReleaseOwnership(f.request);
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      if (path === f.manifest) throw new Error("stop before state write");
      await localTransport.writeJsonAtomic(path, value);
    } };
    await expect(applyReleaseOwnership({ ...reviewed(f.request, p), transport })).rejects.toThrow(/stop before/);
    if (kind === "runtime") await writeFile(join(f.target, selected, "SKILL.md"), "concurrent runtime\n");
    if (kind === "audit") await writeFile(join(f.auditDirectory, "fixture-release.json"), "concurrent audit\n");
    if (kind === "manifest") await writeInstallManifest({ ...await source(f), generatedAt: "2026-01-03T00:00:00.000Z" });
    if (kind === "inventory") await writeInstallManifest({ ...await source(f), adapter: "other", stateKey: "other.local", entries: [] });
    const before = await treeFiles(f.root);
    await expect(recoverPendingApply(f.target, "fixture", localTransport, scope)).rejects.toThrow(/CAS|inventory|changed/);
    expect(await treeFiles(f.root)).toEqual(before);
  });

  it("commits exactly the declared source audit through the ordinary Git provider", async () => {
    const f = await fixture();
    await govern(f);
    const configBefore = await readFile(f.config);
    const result = await applyReleaseOwnership(reviewed(f.request, await planReleaseOwnership(f.request)));
    expect((await git(f.workspace, ["show", "--format=", "--name-only", "HEAD"])).trim())
      .toBe(".agentwheel/ownership-releases/fixture-release.json");
    expect(await readFile(f.config)).toEqual(configBefore);
    expect((await git(f.workspace, ["status", "--porcelain"])).trim()).toBe("");
    expect(result.auditPath).toBe(join(f.auditDirectory, "fixture-release.json"));
  });

  it("recovers a linked partial release and commits the exact audit without rerunning the handler", async () => {
    const f = await fixture(5);
    await govern(f);
    let injected = false;
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      await localTransport.writeJsonAtomic(path, value);
      if (path === f.manifest && !injected) { injected = true; throw new Error("interrupted release"); }
    } };
    await expect(applyReleaseOwnership({ ...reviewed(f.request, await planReleaseOwnership(f.request)), transport }))
      .rejects.toThrow(/interrupted/);
    const receipt = await recoverMutationRuntime("fixture-release");
    expect(receipt.status).toBe("succeeded");
    expect(receipt.paths.map((path) => path.path)).toEqual([".agentwheel/ownership-releases/fixture-release.json"]);
    expect((await source(f)).entries).toHaveLength(5);
  });

  it("supports required journaling with revisioning off", async () => {
    const f = await fixture();
    await writeFile(f.config, JSON.stringify({ schemaVersion: 4, packages: [], mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "off" } } }));
    const configBefore = await readFile(f.config);
    await applyReleaseOwnership(reviewed(f.request, await planReleaseOwnership(f.request)));
    expect((await source(f)).entries).toEqual([]);
    expect(await readFile(f.config)).toEqual(configBefore);
  });

  it("immutable linked journal content cannot be substituted during recovery", async () => {
    const f = await fixture();
    await govern(f);
    const transport: TargetTransport = { ...localTransport, writeJsonAtomic: async (path, value) => {
      if (path === f.manifest) throw new Error("interrupt before state");
      await localTransport.writeJsonAtomic(path, value);
    } };
    await expect(applyReleaseOwnership({ ...reviewed(f.request, await planReleaseOwnership(f.request)), transport })).rejects.toThrow(/interrupt/);
    const raw = JSON.parse(await readFile(journalPath(f), "utf8"));
    raw.metadataAudit.auditFiles[0].content += "substitution";
    await writeFile(journalPath(f), JSON.stringify(raw));
    const before = await treeFiles(f.target);
    await expect(recoverMutationRuntime("fixture-release")).rejects.toThrow(/identity|digest/i);
    expect(await treeFiles(f.target)).toEqual(before);
  });

  it("provider rejection has zero runtime, install-state, config or audit effects", async () => {
    const f = await fixture();
    await govern(f, true);
    const before = await treeFiles(f.target);
    const configBefore = await readFile(f.config);
    await expect(applyReleaseOwnership(reviewed(f.request, await planReleaseOwnership(f.request))))
      .rejects.toThrow(/rejection/);
    expect(await treeFiles(f.target)).toEqual(before);
    expect(await readFile(f.config)).toEqual(configBefore);
    await expect(stat(f.auditDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Git-ignored audit before touching runtime ownership", async () => {
    const f = await fixture();
    await govern(f);
    await writeFile(join(f.workspace, ".gitignore"), ".agentwheel/ownership-releases/\n");
    await git(f.workspace, ["add", ".gitignore"]); await git(f.workspace, ["commit", "-m", "declare ignored path"]);
    const before = await readFile(f.manifest);
    await expect(applyReleaseOwnership(reviewed(f.request, await planReleaseOwnership(f.request))))
      .rejects.toThrow(/Git-ignored/);
    expect(await readFile(f.manifest)).toEqual(before);
  });

  it("CLI release permits ordinary skill update --adopt and a subsequent install without drift", async () => {
    const f = await fixture();
    const cli = join(process.cwd(), "dist", "index.js");
    await ensureCliBuild(cli);
    const pack = join(f.root, "pack");
    await mkdir(join(pack, "skills", "alpha"), { recursive: true });
    await writeFile(join(pack, "openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/release", version: "1.0.0", provides: [{ type: "skills", path: "skills" }] }));
    await writeFile(join(pack, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Generic release fixture.\n---\nNew skill body.\n");
    await writeFile(f.config, JSON.stringify({ schemaVersion: 4, agents: { demo: { adapter: "claude", root: f.target, transport: "local" } }, packages: [{ name: "demo-pack", source: pack, driver: "local", mode: "pinned", select: ["skills/alpha"] }] }));
    const run = async (args: string[]) => execute(process.execPath, [cli, "--no-update-check", ...args], {
      cwd: f.workspace, env: { ...process.env, HOME: f.home, AGENTWHEEL_TEST_HOME: "", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache"), XDG_STATE_HOME: join(f.home, ".local/state") },
      maxBuffer: 8 * 1024 * 1024,
    });
    await run(["install", "--agent", "demo"]);
    const metadata = join(f.target, ".agentwheel");
    const stateName = (await readdir(metadata)).find((name) => name.startsWith("claude.") && name.endsWith(".install-manifest.json"))!;
    const statePath = join(metadata, stateName);
    const installed = JSON.parse(await readFile(statePath, "utf8"));
    installed.entries[0].hash = "e".repeat(64);
    await writeFile(statePath, JSON.stringify(installed));
    const configBefore = await readFile(f.config);
    const args = ["ownership", "release-claim", "skills/alpha", "--agent", "demo", "--installation-type", "local", "--state-key", installed.stateKey, "--path", installed.entries[0].path, "--from-workspace-root", f.workspace, "--reason", "Retire the reviewed stale claim", "--json"];
    const planned = JSON.parse((await run(args)).stdout);
    await run([...args, "--apply", "--plan-digest", planned.planDigest, "--expected-source-revision", planned.source.revision, "--expected-inventory-revision", planned.manifestInventoryRevision]);
    await run(["skill", "update", "alpha", "--agent", "demo", "--adopt"]);
    const ordinary = JSON.parse((await run(["install", "--agent", "demo", "--dry-run", "--format", "json"])).stdout);
    expect(ordinary.targets.every((target: { hasBlockingChanges: boolean }) => !target.hasBlockingChanges)).toBe(true);
    expect(ordinary.targets.flatMap((target: { operations: Array<{ action: string }> }) => target.operations).map((operation: { action: string }) => operation.action))
      .toEqual(["skip"]);
    expect(await readFile(f.config)).toEqual(configBefore);
  }, 60_000);
});

const selected = ".runtime/skills/alpha";
const scope = { installationType: "local", stateKey: "fixture.local" };
async function fixture(siblings = 0) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-release-")); roots.push(root);
  const workspace = join(root, "workspace"); const target = join(root, "target"); const home = join(root, "home");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true }); await mkdir(home);
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(root, "mutation-state");
  const config = join(workspace, ".agentwheel/config.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 4, packages: [] }));
  const entries: InstallManifestEntry[] = [];
  for (let index = 0; index <= siblings; index++) {
    const path = index === 0 ? selected : `.runtime/skills/unknown-${index}`;
    await mkdir(join(target, path), { recursive: true });
    await writeFile(join(target, path, "SKILL.md"), `Preserved bytes ${index}\n`);
    entries.push({ path, artifactType: "skills", artifactName: index === 0 ? "alpha" : `unknown-${index}`, kind: "dir", hash: "a".repeat(64), sourceHash: "b".repeat(64), updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed", installName: index === 0 ? "alpha" : `unknown-${index}`, dependencyRole: "root", owners: ["fixture/pkg"], refCount: 1, workspaceOwner: index === 0 ? workspaceOwnerForRoot(workspace) : "workspace:unknown" });
  }
  await writeInstallManifest({ version: 2, adapter: "fixture", installationType: "local", stateKey: scope.stateKey, targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z", revision: "pending-source-revision", legacy: false, entries });
  const manifest = installManifestPath(target, "fixture", scope);
  const lock = sourceLockPath(target, "fixture", scope); await writeFile(lock, "preserved opaque source lock\n");
  const request: ReleaseOwnershipRequest = { workspaceRoot: workspace, fromWorkspaceRoot: workspace, targetRoot: target, adapter: "fixture", installationType: "local", stateKey: scope.stateKey, selector: "skills/alpha", path: selected, reason: "Release the explicitly reviewed obsolete claim", globalRoot: home, operationId: "fixture-release" };
  return { root, workspace, target, home, config, manifest, lock, request, auditDirectory: join(workspace, ".agentwheel/ownership-releases") };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function source(f: Fixture): Promise<InstallManifestV2> {
  const manifest = await readInstallManifest(f.target, "fixture", localTransport, scope);
  if (!manifest || manifest.version !== 2) throw new Error("fixture source missing"); return manifest;
}
function journalPath(f: Fixture) { return applyJournalPath(f.target, "fixture", scope); }
function reviewed(request: ReleaseOwnershipRequest, plan: Awaited<ReturnType<typeof planReleaseOwnership>>) {
  return { ...request, planDigest: plan.planDigest, expectedSourceRevision: plan.source.revision, expectedInventoryRevision: plan.manifestInventoryRevision };
}
async function treeFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      const child = join(path, item.name);
      if (item.isDirectory()) await visit(child);
      else if (item.isFile()) result[child] = (await readFile(child)).toString("base64");
    }
  }
  await visit(root); return result;
}
async function git(root: string, args: string[]) { return (await execute("git", ["-C", root, ...args])).stdout; }
async function govern(f: Fixture, rejecting = false) {
  await git(f.workspace, ["init", "-b", "main"]); await git(f.workspace, ["config", "user.name", "Fixture Maintainer"]); await git(f.workspace, ["config", "user.email", "fixture@example.test"]);
  let provider: unknown = { kind: "git", protocolVersion: 1 };
  if (rejecting) {
    const script = join(f.root, "provider.mjs");
    await writeFile(script, `let input='';for await (const chunk of process.stdin) input+=chunk;const q=JSON.parse(input);process.stdout.write(JSON.stringify({protocolVersion:1,providerId:'fixture',action:q.action,operationId:q.operationId,ok:false,status:'rejected',error:{code:'blocked',message:'blocked by fixture'}}));`);
    provider = { kind: "command", id: "fixture", protocolVersion: 1, command: [process.execPath, script], trustBoundary: "entrypoint", executableSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") };
  }
  await writeFile(f.config, JSON.stringify({ schemaVersion: 4, packages: [], mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "commit-after-verify", allowNoCommitOverride: false, reasonInCommit: "full", provider } } }));
  await git(f.workspace, ["add", ".agentwheel/config.json"]); await git(f.workspace, ["commit", "-m", "Declare governed fixture"]);
}
