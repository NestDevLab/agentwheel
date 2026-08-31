import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConfig } from "../src/model/adapter.js";
import type { ArtifactType, FileKind } from "../src/model/artifact.js";
import type { GraphLock } from "../src/model/graph-lock.js";
import type { InstallManifestV1Entry, InstallManifestV2 } from "../src/model/manifest.js";
import {
  abortApplyJournal,
  applyCombinedInstallPlan,
  createCombinedInstallPlan,
  createOwnershipUninstallPlan,
  readInstallManifest,
  recoverPendingApply,
  uninstall,
  writeInstallManifest,
  type DesiredArtifact,
} from "../src/install/index.js";
import { acquireApplyLock, applyBackupDir, applyJournalPath, applyLockPath } from "../src/install/transaction.js";
import { assertNoForeignWorkspaceStateForPlan, createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import { workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";
import { installManifestPath } from "../src/install/paths.js";
import type { InstallOperation, InstallPlan } from "../src/install/plan.js";
import { localTransport } from "../src/transport/index.js";
import type { TargetTransport } from "../src/transport/index.js";
import { hashPath, pathExists } from "../src/utils/fs.js";

const tempRoots: string[] = [];

const adapter: AdapterConfig = {
  name: "test",
  targets: {
    rules: { local: { enabled: true, dest: ".runtime/rules" } },
    mcp: { local: { enabled: true, dest: ".runtime/mcp", merge: "json-deep" } },
  },
};

function testGraphLock(): GraphLock {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    canonical: {
      targetFingerprint: "test",
      roots: [],
      nodes: [],
      edges: [],
      includeEdges: [],
      artifacts: [],
      namespacing: [],
      overrides: [],
      plainNameIncumbents: [],
    },
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-b2-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeArtifact(root: string, relativePath: string, content: string): Promise<DesiredArtifact> {
  const sourcePath = join(root, relativePath);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content, "utf8");
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return desiredArtifact({
    type: "rules",
    name,
    sourcePath,
    relativePath,
    hash: await hashPath(sourcePath),
    owners: ["root"],
  });
}

function desiredArtifact(options: {
  type: ArtifactType;
  name: string;
  sourcePath: string;
  relativePath: string;
  hash: string;
  owners: string[];
  role?: DesiredArtifact["meta"]["dependencyRole"];
  kind?: FileKind;
}): DesiredArtifact {
  return {
    type: options.type,
    name: options.name,
    sourcePath: options.sourcePath,
    stagedPath: options.sourcePath,
    relativePath: options.relativePath,
    kind: options.kind ?? "file",
    hash: options.hash,
    channel: "managed",
    meta: {
      logicalSelector: `${options.type}/${options.name}`,
      dependencyRole: options.role ?? "root",
      owners: options.owners,
    },
  };
}

async function writeV1Manifest(targetRoot: string, entries: InstallManifestV1Entry[]): Promise<void> {
  await localTransport.writeJsonAtomic(installManifestPath(targetRoot, adapter.name), {
    version: 1,
    adapter: adapter.name,
    targetRoot,
    generatedAt: new Date().toISOString(),
    entries,
  });
}

async function writeRawV2Manifest(targetRoot: string, entries: unknown[]): Promise<void> {
  await localTransport.writeJsonAtomic(installManifestPath(targetRoot, adapter.name), {
    version: 2,
    adapter: adapter.name,
    targetRoot,
    generatedAt: new Date().toISOString(),
    revision: "legacy-revision-1",
    entries,
  });
}

describe("install manifest v2", () => {
  it("keeps a same-root legacy workspace owner foreign until an explicit handoff", async () => {
    const workspace = await tempRoot("agentwheel-owner-workspace-");
    const foreignWorkspace = await tempRoot("agentwheel-owner-foreign-");
    const target = await tempRoot("agentwheel-owner-target-");
    const source = await tempRoot("agentwheel-owner-source-");
    const artifact = await writeArtifact(source, "rules/fleet.md", "fleet\n");
    const legacyOwner = workspaceOwnerForRoot(workspace);
    const fleetOwner = workspaceOwnerForRoot(workspace, "delivery");

    await applyCombinedInstallPlan(await createCombinedInstallPlan(
      [artifact],
      adapter,
      target,
      undefined,
      localTransport,
      { workspaceOwner: legacyOwner },
    ));
    const legacyManifest = await readInstallManifest(target, adapter.name);
    if (!legacyManifest) throw new Error("expected legacy-owned manifest");

    const fleetPlan = await createCombinedInstallPlan(
      [artifact],
      adapter,
      target,
      legacyManifest,
      localTransport,
      { workspaceOwner: fleetOwner },
    );
    expect(fleetPlan.operations).toMatchObject([{
      action: "keep",
      preserveInManifest: true,
      workspaceOwner: legacyOwner,
    }]);
    await applyCombinedInstallPlan(fleetPlan);
    const preserved = await readInstallManifest(target, adapter.name);
    expect(preserved?.entries[0]).toMatchObject({ workspaceOwner: legacyOwner });

    const foreign = await createCombinedInstallPlan(
      [artifact],
      adapter,
      target,
      preserved,
      localTransport,
      { workspaceOwner: workspaceOwnerForRoot(foreignWorkspace, "other") },
    );
    expect(foreign.operations).toMatchObject([{
      action: "keep",
      preserveInManifest: true,
      workspaceOwner: legacyOwner,
    }]);
  });

  it("roundtrips v2 manifests with sorted owners and reads v1 manifests as legacy", async () => {
    const target = await tempRoot();
    const source = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");

    await writeInstallManifest({
      version: 2,
      adapter: adapter.name,
      installationType: "local",
      targetRoot: target,
      generatedAt: new Date().toISOString(),
      revision: "pending-revision",
      legacy: false,
      entries: [{
        path: ".runtime/rules/a.md",
        artifactType: "rules",
        artifactName: "a.md",
        installName: "a.md",
        logicalSelector: "rules/a.md",
        dependencyRole: "direct",
        owners: ["z-owner", "a-owner", "z-owner"],
        refCount: 99,
        workspaceOwner: "workspace:test",
        kind: "file",
        hash: artifact.hash,
        sourceHash: artifact.hash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
      }],
    }, localTransport);

    const v2 = await readInstallManifest(target, adapter.name);
    expect(v2?.version).toBe(2);
    if (v2?.version !== 2) throw new Error("expected v2 manifest");
    expect(v2?.legacy).toBe(false);
    expect(v2?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(v2?.entries[0]?.owners).toEqual(["a-owner", "z-owner"]);
    expect(v2?.entries[0]?.refCount).toBe(2);

    const legacyTarget = await tempRoot();
    await writeV1Manifest(legacyTarget, [{
      path: ".runtime/rules/a.md",
      artifactType: "rules",
      artifactName: "a.md",
      kind: "file",
      hash: artifact.hash,
      sourceHash: artifact.hash,
      updatedAt: new Date().toISOString(),
      channel: "managed",
      packageName: "legacy/pkg",
    }]);
    const v1 = await readInstallManifest(legacyTarget, adapter.name);
    expect(v1?.version).toBe(1);
    expect(v1?.legacy).toBe(true);
    expect(v1?.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("workspace-scoped reconcile", () => {
  it("keeps artifacts owned by another workspace sharing the same target root", async () => {
    const sourceA = await tempRoot();
    const sourceB = await tempRoot();
    const target = await tempRoot();
    const a = await writeArtifact(sourceA, "rules/a.md", "A\n");
    const b = await writeArtifact(sourceB, "rules/b.md", "B\n");

    await applyCombinedInstallPlan(await createCombinedInstallPlan([a], adapter, target, undefined, localTransport, {
      workspaceOwner: "workspace:A",
    }));

    const planB = await createCombinedInstallPlan([b], adapter, target, await readInstallManifest(target, adapter.name), localTransport, {
      workspaceOwner: "workspace:B",
    });

    expect(planB.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/a.md")?.action).toBe("keep");
    expect(planB.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/a.md")?.reason).toContain("foreign artifact owned by workspace:A");
    expect(planB.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/b.md")?.action).toBe("create");
    expect(planB.operations.filter((operation) => operation.action === "remove")).toHaveLength(0);

    await applyCombinedInstallPlan(planB);
    await expect(stat(join(target, ".runtime", "rules", "a.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".runtime", "rules", "b.md"))).resolves.toBeTruthy();
    const manifest = await readInstallManifest(target, adapter.name);
    if (manifest?.version !== 2) throw new Error("expected v2 manifest");
    expect(manifest.entries.map((entry) => ({ path: entry.path, workspaceOwner: entry.workspaceOwner }))).toEqual([
      { path: ".runtime/rules/a.md", workspaceOwner: "workspace:A" },
      { path: ".runtime/rules/b.md", workspaceOwner: "workspace:B" },
    ]);
  });

  it("adopts matching legacy-unowned entries and keeps unmatched legacy-unowned entries", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const a = await writeArtifact(source, "rules/a.md", "A\n");
    const orphanPath = join(target, ".runtime", "rules", "orphan.md");
    await mkdir(dirname(orphanPath), { recursive: true });
    await writeFile(join(target, ".runtime", "rules", "a.md"), "A\n", "utf8");
    await writeFile(orphanPath, "orphan\n", "utf8");
    const orphanHash = await hashPath(orphanPath);

    await writeRawV2Manifest(target, [
      {
        path: ".runtime/rules/a.md",
        artifactType: "rules",
        artifactName: "a.md",
        installName: "a.md",
        logicalSelector: "rules/a.md",
        dependencyRole: "root",
        owners: ["root"],
        refCount: 1,
        kind: "file",
        hash: a.hash,
        sourceHash: a.hash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
      },
      {
        path: ".runtime/rules/orphan.md",
        artifactType: "rules",
        artifactName: "orphan.md",
        installName: "orphan.md",
        logicalSelector: "rules/orphan.md",
        dependencyRole: "root",
        owners: ["old-root"],
        refCount: 1,
        kind: "file",
        hash: orphanHash,
        sourceHash: orphanHash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
      },
    ]);

    const plan = await createCombinedInstallPlan([a], adapter, target, await readInstallManifest(target, adapter.name), localTransport, {
      workspaceOwner: "workspace:new",
    });

    expect(plan.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/a.md")?.action).toBe("skip");
    const orphan = plan.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/orphan.md");
    expect(orphan?.action).toBe("keep");
    expect(orphan?.reason).toContain("foreign artifact owned by legacy:unowned");
    expect(plan.operations.filter((operation) => operation.action === "remove")).toHaveLength(0);

    await applyCombinedInstallPlan(plan);
    const manifest = await readInstallManifest(target, adapter.name);
    if (manifest?.version !== 2) throw new Error("expected v2 manifest");
    expect(manifest.entries.map((entry) => ({ path: entry.path, workspaceOwner: entry.workspaceOwner }))).toEqual([
      { path: ".runtime/rules/a.md", workspaceOwner: "workspace:new" },
      { path: ".runtime/rules/orphan.md", workspaceOwner: "legacy:unowned" },
    ]);
  });

  it("adopts legacy-unowned entries when path and content match despite source identity drift", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/agent-tmux.md", "agent tmux\n");
    await mkdir(join(target, ".runtime", "rules"), { recursive: true });
    await writeFile(join(target, ".runtime", "rules", "agent-tmux.md"), "agent tmux\n", "utf8");

    await writeRawV2Manifest(target, [{
      path: ".runtime/rules/agent-tmux.md",
      artifactType: "rules",
      artifactName: "agent-tmux.md",
      installName: "agent-tmux.md",
      logicalSelector: "nestdev-mesh@0.9.0+old:rules/agent-tmux.md",
      graphNodeId: "nestdev-mesh@0.9.0+old",
      dependencyRole: "root",
      owners: ["workspace:agent-mesh"],
      refCount: 1,
      kind: "file",
      hash: artifact.hash,
      sourceHash: artifact.hash,
      updatedAt: new Date().toISOString(),
      channel: "managed",
      packageName: "nestdev-mesh",
    }]);

    const desired = {
      ...artifact,
      packageName: "agent-mesh",
      meta: {
        ...artifact.meta,
        graphNodeId: "agent-mesh@0.9.0+new",
        logicalSelector: "agent-mesh@0.9.0+new:rules/agent-tmux.md",
        owners: ["workspace:agent-mesh"],
      },
    };
    const plan = await createCombinedInstallPlan([desired], adapter, target, await readInstallManifest(target, adapter.name), localTransport, {
      workspaceOwner: "workspace:new",
    });

    const operation = plan.operations.find((item) => item.relativeDestPath === ".runtime/rules/agent-tmux.md");
    expect(operation?.action).toBe("skip");
    expect(operation?.reason).toBe("already up to date");
    expect(operation?.workspaceOwner).toBe("workspace:new");
    expect(plan.operations.filter((item) => item.action === "keep")).toHaveLength(0);
  });
});

describe("one-shot v1 to v2 migration", () => {
  it("adopts by path and packageName, drops unmatched entries, and leaves dropped files untouched", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const a = await writeArtifact(source, "rules/a.md", "A\n");
    const bSource = join(source, "rules", "b.md");
    await writeFile(bSource, "B\n", "utf8");
    const b = desiredArtifact({
      type: "rules",
      name: "b.md",
      sourcePath: bSource,
      relativePath: "rules/b.md",
      hash: await hashPath(bSource),
      owners: ["pkg-b"],
    });

    await mkdir(join(target, ".runtime", "rules"), { recursive: true });
    await writeFile(join(target, ".runtime", "rules", "a.md"), "A\n", "utf8");
    await writeFile(join(target, ".runtime", "rules", "renamed.md"), "old B\n", "utf8");
    await writeFile(join(target, ".runtime", "rules", "orphan.md"), "orphan\n", "utf8");
    const renamedHash = await hashPath(join(target, ".runtime", "rules", "renamed.md"));
    const orphanHash = await hashPath(join(target, ".runtime", "rules", "orphan.md"));

    await writeV1Manifest(target, [
      {
        path: ".runtime/rules/a.md",
        artifactType: "rules",
        artifactName: "a.md",
        kind: "file",
        hash: a.hash,
        sourceHash: a.hash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
        packageName: "legacy-a",
      },
      {
        path: ".runtime/rules/renamed.md",
        artifactType: "rules",
        artifactName: "b.md",
        kind: "file",
        hash: renamedHash,
        sourceHash: renamedHash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
        packageName: "pkg-b",
      },
      {
        path: ".runtime/rules/orphan.md",
        artifactType: "rules",
        artifactName: "orphan.md",
        kind: "file",
        hash: orphanHash,
        sourceHash: orphanHash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
        packageName: "old/pkg",
      },
    ]);

    const manifest = await readInstallManifest(target, adapter.name);
    const adoptableA = { ...a, packageName: "legacy-a", meta: { ...a.meta, owners: ["legacy-a"] } };
    const plan = await createCombinedInstallPlan([adoptableA, b], adapter, target, manifest);
    expect(plan.migrationReport).toEqual({ adopted: 1, dropped: [".runtime/rules/renamed.md", ".runtime/rules/orphan.md"] });
    expect(plan.operations.some((operation) => operation.relativeDestPath === ".runtime/rules/orphan.md")).toBe(false);

    await applyCombinedInstallPlan(plan);
    await expect(stat(join(target, ".runtime", "rules", "orphan.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".runtime", "rules", "renamed.md"))).resolves.toBeTruthy();
    const next = await readInstallManifest(target, adapter.name);
    expect(next?.version).toBe(2);
    expect(next?.entries.map((entry) => entry.path).sort()).toEqual([".runtime/rules/a.md", ".runtime/rules/b.md"]);
  });

  it("drops same-path legacy entries with mismatched package identity so desired artifacts conflict", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const desired = { ...artifact, packageName: "new/pkg", meta: { ...artifact.meta, owners: ["new/pkg"] } };

    await mkdir(join(target, ".runtime", "rules"), { recursive: true });
    await writeFile(join(target, ".runtime", "rules", "a.md"), "A\n", "utf8");
    await writeV1Manifest(target, [{
      path: ".runtime/rules/a.md",
      artifactType: "rules",
      artifactName: "a.md",
      kind: "file",
      hash: artifact.hash,
      sourceHash: artifact.hash,
      updatedAt: new Date().toISOString(),
      channel: "managed",
      packageName: "old/pkg",
    }]);

    const plan = await createCombinedInstallPlan([desired], adapter, target, await readInstallManifest(target, adapter.name));

    expect(plan.migrationReport).toEqual({ adopted: 0, dropped: [".runtime/rules/a.md"] });
    expect(plan.operations.find((operation) => operation.relativeDestPath === ".runtime/rules/a.md")?.action).toBe("conflict");
  });
});

describe("transactional apply", () => {
  it("acquires local locks exclusively until release", async () => {
    const target = await tempRoot();
    const first = await acquireApplyLock(target, adapter.name);

    await expect(acquireApplyLock(target, adapter.name)).rejects.toThrow(/Apply lock already exists/);

    await first.release();
    const second = await acquireApplyLock(target, adapter.name);
    await second.release();
  });

  it("serializes different state keys that share one adapter runtime", async () => {
    const target = await tempRoot();
    const first = await acquireApplyLock(target, adapter.name, undefined, {}, {
      installationType: "local",
      stateKey: "fleet-alpha",
    });

    await expect(acquireApplyLock(target, adapter.name, undefined, {}, {
      installationType: "local",
      stateKey: "fleet-beta",
    })).rejects.toThrow(/Apply lock already exists/);

    await first.release();
  });

  it("rejects adapter names that could collide after path sanitization", async () => {
    const target = await tempRoot();
    expect(() => applyLockPath(target, "foo/bar", { installationType: "user" })).toThrow(/path-safe identifier/);
    expect(() => applyLockPath(target, "foo-bar", { installationType: "user" })).not.toThrow();
  });

  it("persists the locked runtime hash after a disjoint merge change", async () => {
    const target = await tempRoot();
    const relativePath = ".runtime/config.json";
    const destPath = join(target, relativePath);
    await writeText(destPath, `${JSON.stringify({ mcpServers: { current: { command: "current" } } })}\n`);
    const contentHash = await hashPath(destPath);
    const plan: InstallPlan = {
      adapter: adapter.name,
      installationType: "local",
      stateKey: "merge-revalidation",
      targetRoot: target,
      baseRevision: null,
      operations: [{
        action: "skip",
        artifactType: "mcp",
        artifactName: "current.json",
        kind: "file",
        destPath,
        relativeDestPath: relativePath,
        currentHash: contentHash,
        desiredHash: contentHash,
        reason: "already merged",
        channel: "managed",
        mergeStrategy: "json-deep",
        mergeRemoval: { mcpServers: { current: { command: "current" } } },
      }],
      hasBlockingChanges: false,
    };
    await writeText(destPath, `${JSON.stringify({
      mcpServers: {
        current: { command: "current" },
        concurrent: { command: "concurrent" },
      },
    })}\n`);
    const lockedHash = await hashPath(destPath);

    await applyCombinedInstallPlan(plan);
    const manifest = await readInstallManifest(target, adapter.name, localTransport, { stateKey: "merge-revalidation" });
    expect(manifest?.entries[0]?.hash).toBe(lockedHash);
  });

  it("uses ssh-shaped exclusive mkdir instead of check-then-act lock probing", async () => {
    const target = await tempRoot();
    const lockPath = applyLockPath(target, adapter.name);
    const mkdirCalls: string[] = [];
    const transport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
      async pathExists(path) {
        if (path === lockPath) {
          throw new Error("lock pathExists should not be called");
        }
        return localTransport.pathExists(path);
      },
      async mkdirExclusive(path) {
        mkdirCalls.push(path);
        await mkdir(dirname(path), { recursive: true });
        await mkdir(path);
      },
    };

    const first = await acquireApplyLock(target, adapter.name, transport);
    expect(mkdirCalls).toEqual([lockPath]);
    await expect(acquireApplyLock(target, adapter.name, transport)).rejects.toThrow(/Apply lock already exists/);
    expect(mkdirCalls).toEqual([lockPath, lockPath]);
    await first.release();
  });

  it("rejects a second apply while the target lock is held", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const plan = await createCombinedInstallPlan([artifact], adapter, target);

    await mkdir(applyLockPath(target, adapter.name), { recursive: true });
    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/Apply lock already exists/);
  });

  it("aborts when the manifest revision changed after planning", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const plan = await createCombinedInstallPlan([artifact], adapter, target);
    await writeInstallManifest(emptyManifest(target), localTransport);

    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/replan needed/);
  });

  it("recovers a failed apply by completing remaining operations when staged sources still exist", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const first = await writeArtifact(source, "rules/a.md", "A\n");
    const second = await writeArtifact(source, "rules/b.md", "B\n");
    const plan = await createCombinedInstallPlan([first, second], adapter, target);
    const failingTransport = failOnCopy(2);

    await expect(applyCombinedInstallPlan(plan, { transport: failingTransport })).rejects.toThrow(/injected copy failure/);
    expect(await localTransport.pathExists(applyJournalPath(target, adapter.name))).toBe(true);

    const manifest = await recoverPendingApply(target, adapter.name);
    expect(manifest?.entries.map((entry) => entry.path)).toEqual([".runtime/rules/a.md", ".runtime/rules/b.md"]);
    await expect(stat(join(target, ".runtime", "rules", "a.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".runtime", "rules", "b.md"))).resolves.toBeTruthy();
    expect(await localTransport.pathExists(applyJournalPath(target, adapter.name))).toBe(false);
  });

  it("blocks apply and recovery across state keys while any runtime journal is pending", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const first = await writeArtifact(source, "rules/a.md", "A\n");
    const second = await writeArtifact(source, "rules/b.md", "B\n");
    const independent = await writeArtifact(source, "rules/c.md", "C\n");
    const alpha = await createCombinedInstallPlan([first, second], adapter, target, undefined, localTransport, { stateKey: "alpha" });
    await expect(applyCombinedInstallPlan(alpha, { transport: failOnCopy(2) })).rejects.toThrow(/injected copy failure/);

    const beta = await createCombinedInstallPlan([independent], adapter, target, undefined, localTransport, { stateKey: "beta" });
    await expect(applyCombinedInstallPlan(beta)).rejects.toThrow(/runtime apply journal.*pending/i);
    await expect(recoverPendingApply(target, adapter.name, localTransport, { stateKey: "beta" }))
      .rejects.toThrow(/runtime apply journal.*pending/i);

    await expect(recoverPendingApply(target, adapter.name, localTransport, { stateKey: "alpha" })).resolves.toBeDefined();
  });

  it("rejects a plan when another state manifest appears before the shared lock", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const plan = await createCombinedInstallPlan([artifact], adapter, target, undefined, localTransport, { stateKey: "beta" });
    await writeOwnedManifest(target, "alpha", workspaceOwnerForRoot(await tempRoot()), [".runtime/rules/foreign.md"]);

    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/manifest inventory changed.*replan/i);
  });

  it("rolls back completed operations when recovery no longer has staged sources", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const first = await writeArtifact(source, "rules/a.md", "A\n");
    const second = await writeArtifact(source, "rules/b.md", "B\n");
    const plan = await createCombinedInstallPlan([first, second], adapter, target);

    await expect(applyCombinedInstallPlan(plan, { transport: failOnCopy(2) })).rejects.toThrow(/injected copy failure/);
    await rm(source, { recursive: true, force: true });

    const recovered = await recoverPendingApply(target, adapter.name);
    expect(recovered).toBeUndefined();
    await expect(stat(join(target, ".runtime", "rules", "a.md"))).rejects.toThrow();
    expect(await readInstallManifest(target, adapter.name)).toBeUndefined();
    expect(await localTransport.pathExists(applyJournalPath(target, adapter.name))).toBe(false);
  });

  it("aborts on hash verification failure and can recover from the pending journal", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const corruptingTransport: TargetTransport = {
      ...localTransport,
      async atomicCopy(sourcePath, destPath, kind) {
        await localTransport.atomicCopy(sourcePath, destPath, kind);
        await writeFile(destPath, "corrupt\n", "utf8");
      },
    };
    const plan = await createCombinedInstallPlan([artifact], adapter, target);

    await expect(applyCombinedInstallPlan(plan, { transport: corruptingTransport })).rejects.toThrow(/Hash verification failed/);
    const recovered = await recoverPendingApply(target, adapter.name);
    expect(recovered?.entries).toHaveLength(1);
    expect(await readFile(join(target, ".runtime", "rules", "a.md"), "utf8")).toBe("A\n");
  });

  it("recovers when a copy landed before journal completion was persisted", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const crashingTransport: TargetTransport = {
      ...localTransport,
      async atomicCopy(sourcePath, destPath, kind) {
        await localTransport.atomicCopy(sourcePath, destPath, kind);
        throw new Error("injected post-copy crash");
      },
    };
    const plan = await createCombinedInstallPlan([artifact], adapter, target);

    await expect(applyCombinedInstallPlan(plan, { transport: crashingTransport })).rejects.toThrow(/post-copy crash/);
    const recovered = await recoverPendingApply(target, adapter.name);

    expect(recovered?.entries.map((entry) => entry.path)).toEqual([".runtime/rules/a.md"]);
    expect(await readFile(join(target, ".runtime", "rules", "a.md"), "utf8")).toBe("A\n");
  });

  it("recovers a graph-lock write failure after the manifest was written", async () => {
    const source = await tempRoot();
    const workspace = await tempRoot();
    const target = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");
    const plan = await createCombinedInstallPlan([artifact], adapter, target);
    const graphLockPath = join(workspace, ".agentwheel", "locks", "blocked", "test.graph-lock.json");
    const blocker = dirname(graphLockPath);
    await mkdir(dirname(blocker), { recursive: true });
    await writeFile(blocker, "not a directory", "utf8");

    await expect(applyCombinedInstallPlan(plan, {
      graphLockDigest: "digest",
      graphLock: { path: graphLockPath, lock: testGraphLock() },
    })).rejects.toThrow();
    expect(await readInstallManifest(target, adapter.name)).toBeDefined();
    expect(await pathExists(applyJournalPath(target, adapter.name))).toBe(true);

    await rm(blocker, { force: true });
    await recoverPendingApply(target, adapter.name);

    expect(await pathExists(graphLockPath)).toBe(true);
    expect(await pathExists(applyJournalPath(target, adapter.name))).toBe(false);
  });

  it("fails explicitly when ssh recovery would need rollback without remote backups", async () => {
    const target = await tempRoot();
    const destPath = join(target, ".runtime", "rules", "a.md");
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, "old\n", "utf8");
    const operation: InstallOperation = {
      action: "update",
      artifactType: "rules",
      artifactName: "a.md",
      kind: "file",
      sourcePath: join(target, "missing-source.md"),
      destPath,
      relativeDestPath: ".runtime/rules/a.md",
      desiredHash: "b".repeat(64),
      reason: "test update",
      channel: "managed",
    };
    await localTransport.writeJsonAtomic(applyJournalPath(target, adapter.name), {
      version: 1,
      adapter: adapter.name,
      targetRoot: target,
      baseRevision: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      operations: [operation],
      completed: [{
        index: 0,
        destPath,
        kind: "file",
        hadExisting: true,
      }],
      manifest: emptyManifest(target),
    });
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh",
    };

    await expect(recoverPendingApply(target, adapter.name, sshTransport)).rejects.toThrow(/Cannot automatically roll back fake ssh/);
  });

  it("archives and clears a pending apply journal without touching runtime files", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const scope = { installationType: "local", stateKey: "test.local.abort" };
    const journalPath = applyJournalPath(target, adapter.name, scope);
    const backupDir = applyBackupDir(target, adapter.name, scope);
    await localTransport.writeJsonAtomic(journalPath, {
      version: 1,
      adapter: adapter.name,
      installationType: scope.installationType,
      stateKey: scope.stateKey,
      targetRoot: target,
      baseRevision: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      operations: [],
      completed: [],
      manifest: emptyManifest(target),
    });
    await mkdir(join(backupDir, "0"), { recursive: true });
    await writeFile(join(backupDir, "0", "backup.txt"), "backup\n", "utf8");

    const aborted = await abortApplyJournal(target, adapter.name, localTransport, scope);

    expect(aborted?.archivePath).toMatch(/\.agentwheel\/archive\/test\.local\.abort\.apply-journal\.failed-\d{8}T\d{6}Z\.json$/);
    expect(await pathExists(journalPath)).toBe(false);
    expect(await pathExists(backupDir)).toBe(false);
    expect(await pathExists(aborted!.archivePath)).toBe(true);
    const archived = JSON.parse(await readFile(aborted!.archivePath, "utf8"));
    expect(archived.stateKey).toBe(scope.stateKey);

    const artifact = await writeArtifact(source, "rules/after-abort.md", "after\n");
    const manifest = await applyCombinedInstallPlan(await createCombinedInstallPlan([artifact], adapter, target));
    expect(manifest.entries.map((entry) => entry.path)).toEqual([".runtime/rules/after-abort.md"]);
  });
});

describe("ownership uninstall and merge target guard", () => {
  it("reports blocked desired composed changes on drifted files", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const original = await writeArtifact(source, "rules/composed.md", "old\n");
    const withCompose = {
      ...original,
      composedFrom: [{ selector: "fragments/risk.md", hash: "a".repeat(64) }],
      meta: {
        ...original.meta,
        composedFrom: [{ selector: "fragments/risk.md", hash: "a".repeat(64) }],
      },
    };
    await applyCombinedInstallPlan(await createCombinedInstallPlan([withCompose], adapter, target));
    await writeFile(join(target, ".runtime", "rules", "composed.md"), "local edit\n", "utf8");

    const updatedPath = join(source, "rules", "composed-updated.md");
    await writeFile(updatedPath, "new\n", "utf8");
    const updated = {
      ...withCompose,
      sourcePath: updatedPath,
      stagedPath: updatedPath,
      hash: await hashPath(updatedPath),
      composedFrom: [{ selector: "fragments/risk.md", hash: "b".repeat(64) }],
      meta: {
        ...withCompose.meta,
        composedFrom: [{ selector: "fragments/risk.md", hash: "b".repeat(64) }],
      },
    };
    const plan = await createCombinedInstallPlan([updated], adapter, target, await readInstallManifest(target, adapter.name));
    const drift = plan.operations.find((operation) => operation.action === "drift");

    expect(drift?.blockedDesiredHash).toBe(updated.hash);
    expect(drift?.blockedReason).toMatch(/drift blocks update: included fragment changed fragments\/risk\.md/);
    expect(drift?.composedFromDiff).toEqual(["fragments/risk.md"]);
  });

  it("blocks all unresolved install-path collisions before create/update operations are emitted", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const root = await writeArtifact(source, "root/shared.md", "root\n");
    const direct = await writeArtifact(source, "direct/shared.md", "direct\n");
    const transitive = await writeArtifact(source, "transitive/shared.md", "transitive\n");
    const colliding = [
      { ...root, name: "shared.md", meta: { ...root.meta, dependencyRole: "root" as const, owners: ["root"] } },
      { ...direct, name: "shared.md", meta: { ...direct.meta, dependencyRole: "direct" as const, owners: ["direct"] } },
      { ...transitive, name: "shared.md", meta: { ...transitive.meta, dependencyRole: "transitive" as const, owners: ["transitive"] } },
    ];

    const plan = await createCombinedInstallPlan(colliding, adapter, target);

    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations.every((operation) => operation.action === "conflict")).toBe(true);
    expect(plan.operations.some((operation) => operation.action === "create" || operation.action === "update")).toBe(false);
  });

  it("keeps still-owned entries and removes entries whose owner set becomes empty", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const shared = await writeArtifact(source, "rules/shared.md", "shared\n");
    const solo = await writeArtifact(source, "rules/solo.md", "solo\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([
      { ...shared, meta: { ...shared.meta, owners: ["root-a", "root-b"] } },
      { ...solo, meta: { ...solo.meta, owners: ["root-a"] } },
    ], adapter, target));

    const manifest = await readInstallManifest(target, adapter.name);
    const remainingShared = { ...shared, meta: { ...shared.meta, owners: ["root-b"] } };
    const plan = await createOwnershipUninstallPlan(manifest!, [remainingShared], adapter);

    expect(plan.operations.find((operation) => operation.artifactName === "shared.md")?.action).toBe("keep");
    expect(plan.operations.find((operation) => operation.artifactName === "shared.md")?.reason).toBe("still required by root-b");
    expect(plan.operations.find((operation) => operation.artifactName === "solo.md")?.action).toBe("remove");

    await uninstall(plan);
    await expect(stat(join(target, ".runtime", "rules", "solo.md"))).rejects.toThrow();
    await expect(stat(join(target, ".runtime", "rules", "shared.md"))).resolves.toBeTruthy();
    const next = await readInstallManifest(target, adapter.name);
    if (next?.version !== 2) throw new Error("expected v2 manifest");
    expect(next?.entries.map((entry) => ({ path: entry.path, owners: entry.owners }))).toEqual([
      { path: ".runtime/rules/shared.md", owners: ["root-b"] },
    ]);
  });

  it("rejects keep-files with force at the uninstall API boundary", async () => {
    const target = await tempRoot();
    await expect(uninstall({
      adapter: adapter.name,
      installationType: "local",
      targetRoot: target,
      operations: [],
      hasBlockingChanges: false,
      baseRevision: null,
    }, { keepFiles: true, force: true })).rejects.toThrow("--keep-files cannot be combined with --force.");
  });

  it("keep-files makes drifted entries with no remaining owners unmanaged", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const shared = await writeArtifact(source, "rules/shared.md", "shared\n");
    const solo = await writeArtifact(source, "rules/solo.md", "solo\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([
      { ...shared, meta: { ...shared.meta, owners: ["root-a", "root-b"] } },
      { ...solo, meta: { ...solo.meta, owners: ["root-a"] } },
    ], adapter, target));
    await writeFile(join(target, ".runtime", "rules", "solo.md"), "locally changed\n", "utf8");

    const manifest = await readInstallManifest(target, adapter.name);
    const remainingShared = { ...shared, meta: { ...shared.meta, owners: ["root-b"] } };
    const plan = await createOwnershipUninstallPlan(manifest!, [remainingShared], adapter);

    expect(plan.operations.find((operation) => operation.artifactName === "solo.md")?.action).toBe("keep");
    await uninstall(plan, { keepFiles: true });

    await expect(stat(join(target, ".runtime", "rules", "solo.md"))).resolves.toBeTruthy();
    const next = await readInstallManifest(target, adapter.name);
    if (next?.version !== 2) throw new Error("expected v2 manifest");
    expect(next.entries.map((entry) => ({ path: entry.path, owners: entry.owners }))).toEqual([
      { path: ".runtime/rules/shared.md", owners: ["root-b"] },
    ]);
  });

  it("force keeps still-owned entries while removing drifted entries with no remaining owners", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const shared = await writeArtifact(source, "rules/shared.md", "shared\n");
    const solo = await writeArtifact(source, "rules/solo.md", "solo\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([
      { ...shared, meta: { ...shared.meta, owners: ["root-a", "root-b"] } },
      { ...solo, meta: { ...solo.meta, owners: ["root-a"] } },
    ], adapter, target));
    await writeFile(join(target, ".runtime", "rules", "solo.md"), "locally changed\n", "utf8");

    const manifest = await readInstallManifest(target, adapter.name);
    const remainingShared = { ...shared, meta: { ...shared.meta, owners: ["root-b"] } };
    const plan = await createOwnershipUninstallPlan(manifest!, [remainingShared], adapter);

    await uninstall(plan, { force: true });

    await expect(stat(join(target, ".runtime", "rules", "shared.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".runtime", "rules", "solo.md"))).rejects.toThrow();
    const next = await readInstallManifest(target, adapter.name);
    if (next?.version !== 2) throw new Error("expected v2 manifest");
    expect(next.entries.map((entry) => ({ path: entry.path, owners: entry.owners }))).toEqual([
      { path: ".runtime/rules/shared.md", owners: ["root-b"] },
    ]);
  });

  it("rejects transitive merge-target artifacts at plan time", async () => {
    const source = await tempRoot();
    const mcpPath = join(source, "mcp", "server.json");
    await mkdir(dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { demo: { command: "demo" } } }), "utf8");
    const artifact = desiredArtifact({
      type: "mcp",
      name: "server.json",
      sourcePath: mcpPath,
      relativePath: "mcp/server.json",
      hash: await hashPath(mcpPath),
      owners: ["dep"],
      role: "transitive",
    });

    await expect(createCombinedInstallPlan([artifact], adapter, await tempRoot())).rejects.toThrow(/Dependency-provided mcp artifacts cannot be installed/);
  });

  it("rejects direct dependency merge-target artifacts at plan time", async () => {
    const source = await tempRoot();
    const mcpPath = join(source, "mcp", "server.json");
    await mkdir(dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { demo: { command: "demo" } } }), "utf8");
    const artifact = desiredArtifact({
      type: "mcp",
      name: "server.json",
      sourcePath: mcpPath,
      relativePath: "mcp/server.json",
      hash: await hashPath(mcpPath),
      owners: ["dep"],
      role: "direct",
    });

    await expect(createCombinedInstallPlan([artifact], adapter, await tempRoot())).rejects.toThrow(/Dependency-provided mcp artifacts cannot be installed/);
  });
});

function emptyManifest(targetRoot: string): InstallManifestV2 {
  return {
    version: 2,
    adapter: adapter.name,
    installationType: "local",
    targetRoot,
    generatedAt: new Date().toISOString(),
    revision: "pending-empty-000",
    legacy: false,
    entries: [],
  };
}

function failOnCopy(failAt: number): TargetTransport {
  let copies = 0;
  return {
    ...localTransport,
    async atomicCopy(sourcePath, destPath, kind) {
      copies++;
      if (copies === failAt) throw new Error("injected copy failure");
      await localTransport.atomicCopy(sourcePath, destPath, kind);
    },
  };
}

// Install state is keyed by target fingerprint, so one runtime root holds several manifests under
// the same adapter and installation type that cannot read each other. These fixtures build that
// situation from scratch: two synthetic workspace roots, one target root, and manifests that differ
// only by state key and workspaceOwner.
const foreignStateAdapter: AdapterConfig = {
  name: "test",
  targets: {
    skills: { local: { enabled: true, dest: ".runtime/skills" } },
  },
};

const alphaStateKey = `test.local.${"1".repeat(64)}`;
const betaStateKey = `test.local.${"2".repeat(64)}`;

describe("foreign workspace state at a shared target root", () => {
  it("allows verified disjoint MCP merge contributions across workspace owners and rejects overlapping servers", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const relativePath = ".runtime/config.json";
    const content = `${JSON.stringify({
      mcpServers: {
        alpha: { command: "alpha-mcp" },
        beta: { command: "beta-mcp" },
      },
    }, null, 2)}\n`;
    await writeText(join(target, relativePath), content);
    const runtimeHash = await hashPath(join(target, relativePath));
    await localTransport.writeJsonAtomic(installManifestPath(target, foreignStateAdapter.name, { stateKey: alphaStateKey }), {
      version: 2,
      adapter: foreignStateAdapter.name,
      installationType: "local",
      stateKey: alphaStateKey,
      targetRoot: target,
      generatedAt: new Date().toISOString(),
      revision: "fixture-revision-0000",
      entries: [{
        path: relativePath,
        artifactType: "mcp",
        artifactName: "alpha.json",
        installName: "alpha.json",
        logicalSelector: "mcp/alpha.json",
        kind: "file",
        hash: runtimeHash,
        sourceHash: runtimeHash,
        updatedAt: new Date().toISOString(),
        channel: "managed",
        packageName: "fixture/alpha",
        dependencyRole: "root",
        owners: ["fixture/alpha"],
        refCount: 1,
        workspaceOwner: workspaceOwnerForRoot(fleetAlpha),
        mergeStrategy: "json-deep",
        mergeRemoval: { mcpServers: { alpha: { command: "alpha-mcp" } } },
      }],
    });
    const operation: InstallOperation = {
      action: "update",
      artifactType: "mcp",
      artifactName: "beta.json",
      kind: "file",
      destPath: join(target, relativePath),
      relativeDestPath: relativePath,
      currentHash: runtimeHash,
      desiredHash: runtimeHash,
      reason: "merge source changed",
      channel: "managed",
      mergeStrategy: "json-deep",
      mergeRemoval: { mcpServers: { beta: { command: "beta-mcp" } } },
    };
    const plan: InstallPlan = {
      adapter: foreignStateAdapter.name,
      installationType: "local",
      stateKey: betaStateKey,
      targetRoot: target,
      baseRevision: null,
      operations: [operation],
      hasBlockingChanges: false,
    };
    const options = {
      workspaceRoot: projectBeta,
      workspaceOwner: workspaceOwnerForRoot(projectBeta),
      globalRoot: await tempRoot("agentwheel-b2-home-"),
    };

    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).resolves.toBeUndefined();
    plan.operations[0] = {
      ...operation,
      mergeRemoval: { mcpServers: { alpha: { command: "different-alpha" } } },
    };
    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).rejects.toThrow(
      /already carries Agentwheel state owned by another workspace/,
    );
  });

  it("requires explicit normalization even when the current workspace claim is exact", async () => {
    const foreign = await tempRoot("agentwheel-b2-foreign-");
    const current = await tempRoot("agentwheel-b2-current-");
    const target = await tempRoot("agentwheel-b2-target-");
    const relativePath = ".runtime/skills/shared-skill";
    await writeText(join(target, relativePath, "SKILL.md"), "current\n");
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(foreign), [relativePath]);
    const runtimeHash = await hashPath(join(target, relativePath));
    const plan: InstallPlan = {
      adapter: foreignStateAdapter.name,
      installationType: "local",
      stateKey: betaStateKey,
      targetRoot: target,
      baseRevision: null,
      operations: [{
        action: "skip",
        artifactType: "skills",
        artifactName: "shared-skill",
        kind: "dir",
        destPath: join(target, relativePath),
        relativeDestPath: relativePath,
        currentHash: runtimeHash,
        manifestHash: runtimeHash,
        desiredHash: runtimeHash,
        reason: "already up to date",
        channel: "managed",
      }],
      hasBlockingChanges: false,
    };
    const options = {
      workspaceRoot: current,
      workspaceOwner: workspaceOwnerForRoot(current),
      globalRoot: await tempRoot("agentwheel-b2-home-"),
    };

    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).rejects.toThrow(/another workspace/);
    plan.operations[0] = { ...plan.operations[0]!, manifestHash: "f".repeat(64) };
    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).rejects.toThrow(/another workspace/);
  });

  it("requires explicit normalization for an inert claim from an empty workspace", async () => {
    const foreign = await tempRoot("agentwheel-b2-foreign-");
    const current = await tempRoot("agentwheel-b2-current-");
    const target = await tempRoot("agentwheel-b2-target-");
    const relativePath = ".runtime/config.json";
    await writeText(join(target, relativePath), "{}\n");
    await writeText(join(foreign, ".agentwheel", "config.json"), `${JSON.stringify({ schemaVersion: 1, packages: [] })}\n`);
    await localTransport.writeJsonAtomic(installManifestPath(target, foreignStateAdapter.name, { stateKey: alphaStateKey }), {
      version: 2,
      adapter: foreignStateAdapter.name,
      installationType: "local",
      stateKey: alphaStateKey,
      targetRoot: target,
      generatedAt: new Date().toISOString(),
      revision: "fixture-revision-0000",
      entries: [{
        path: relativePath,
        artifactType: "mcp",
        artifactName: "retired.json",
        installName: "retired.json",
        logicalSelector: "mcp/retired.json",
        kind: "file",
        hash: "0".repeat(64),
        sourceHash: "0".repeat(64),
        updatedAt: new Date().toISOString(),
        channel: "managed",
        packageName: "fixture/retired",
        dependencyRole: "root",
        owners: ["fixture/retired"],
        refCount: 1,
        workspaceOwner: workspaceOwnerForRoot(foreign),
        mergeStrategy: "json-deep",
        mergeRemoval: { mcpServers: {} },
      }],
    });
    const plan: InstallPlan = {
      adapter: foreignStateAdapter.name,
      installationType: "local",
      stateKey: betaStateKey,
      targetRoot: target,
      baseRevision: null,
      operations: [{
        action: "update",
        artifactType: "mcp",
        artifactName: "current.json",
        kind: "file",
        destPath: join(target, relativePath),
        relativeDestPath: relativePath,
        desiredHash: "1".repeat(64),
        reason: "merge source changed",
        channel: "managed",
        mergeStrategy: "json-deep",
        mergeRemoval: { mcpServers: { current: { command: "current" } } },
      }],
      hasBlockingChanges: false,
    };
    const options = {
      workspaceRoot: current,
      workspaceOwner: workspaceOwnerForRoot(current),
      globalRoot: await tempRoot("agentwheel-b2-home-"),
    };

    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).rejects.toThrow(/another workspace/);
    await writeText(join(foreign, ".agentwheel", "config.json"), `${JSON.stringify({
      schemaVersion: 1,
      packages: [{ name: "active", source: "/active", adapter: "test", mode: "pinned" }],
    })}\n`);
    await expect(assertNoForeignWorkspaceStateForPlan(plan, options)).rejects.toThrow(/another workspace/);
  });

  it("partitions an explicit runtime state key by fleet and requires an explicit force for a same-path cross-fleet install", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const fleetBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const alphaSource = await skillSource(fleetAlpha, "shared-skill");
    const betaSource = await skillSource(fleetBeta, "shared-skill");

    const alpha = await graphPlan(alphaSource, target, fleetAlpha, {
      fleetId: "alpha",
      stateKey: "shared-runtime",
    });
    expect(alpha.plan.stateKey).not.toBe("shared-runtime");
    await applyCombinedInstallPlan(alpha.plan);

    const betaError = await graphPlan(betaSource, target, fleetBeta, {
      fleetId: "beta",
      stateKey: "shared-runtime",
    }).catch((cause: unknown) => cause);
    const message = betaError instanceof Error ? betaError.message : String(betaError);
    expect(message).toContain("already carries Agentwheel state owned by another workspace");
    expect(message).toContain(workspaceOwnerForRoot(fleetAlpha, "alpha"));
    expect(message).toContain(".runtime/skills/shared-skill");
    expect(message).toContain("fleet normalize");

    const forced = await graphPlan(betaSource, target, fleetBeta, {
      fleetId: "beta",
      stateKey: "shared-runtime",
      forceForeignState: true,
    });
    expect(forced.plan.operations.map((operation) => operation.action)).toEqual(["conflict"]);
    expect(forced.plan.hasBlockingChanges).toBe(true);
  });

  it("blocks planning when an exact current claim is shadowed by foreign ownership", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(projectBeta, "shared-skill");

    // A single-owner root must still plan cleanly, so the guard cannot be firing on coexistence alone.
    const first = await graphPlan(source, target, projectBeta);
    expect(first.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
    await applyCombinedInstallPlan(first.plan);

    // Alpha had installed into the same runtime root under its own state key, claiming the same path.
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(fleetAlpha), [
      ".runtime/skills/shared-skill",
      ".runtime/skills/alpha-only-skill",
    ]);

    await expect(graphPlan(source, target, projectBeta)).rejects.toThrow(/another workspace/);
  });

  it("names the foreign owner, its manifest, entry count, colliding path and the ways out", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(projectBeta, "shared-skill");

    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(fleetAlpha), [
      ".runtime/skills/shared-skill",
      ".runtime/skills/alpha-only-skill",
    ]);

    const error = await graphPlan(source, target, projectBeta).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain(workspaceOwnerForRoot(fleetAlpha));
    expect(message).toContain(`${alphaStateKey}.install-manifest.json`);
    expect(message).toContain("2 entries");
    expect(message).toContain(".runtime/skills/shared-skill");
    expect(message).not.toContain(".runtime/skills/alpha-only-skill");
    expect(message).toContain(projectBeta);
    expect(message).toContain("--force-foreign-state");
  });

  it("allows a foreign owner that shares the root but no path", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(projectBeta, "beta-skill");

    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(fleetAlpha), [
      ".runtime/skills/alpha-only-skill",
    ]);

    const result = await graphPlan(source, target, projectBeta);
    expect(result.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
  });

  it("allows the same workspace owning the path under a different fingerprint", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(fleetAlpha, "shared-skill");

    // One workspace reaches a runtime root under several fingerprints -- per-agent and per-profile
    // runs -- so its own state must never look foreign to it, colliding paths included.
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(fleetAlpha), [
      ".runtime/skills/shared-skill",
    ]);

    const result = await graphPlan(source, target, fleetAlpha);
    expect(result.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
  });

  it("allows sub-workspaces of the resolving workspace even when the path collides", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(fleetAlpha, "shared-skill");

    // Per-profile and per-rollout roots checked out beneath a control plane belong to it.
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(join(fleetAlpha, "profiles", "pack-one")), [
      ".runtime/skills/shared-skill",
    ]);
    await writeOwnedManifest(target, betaStateKey, workspaceOwnerForRoot(join(fleetAlpha, "var", "rollouts", "pack-two")), [
      ".runtime/skills/shared-skill",
    ]);

    const result = await graphPlan(source, target, fleetAlpha);
    expect(result.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
  });

  it("requires normalization for a nested legacy owner once the current owner is Fleet-qualified", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(fleetAlpha, "shared-skill");
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(join(fleetAlpha, "var", "rollouts", "legacy")), [
      ".runtime/skills/shared-skill",
    ]);

    await expect(graphPlan(source, target, fleetAlpha, { fleetId: "alpha" }))
      .rejects.toThrow(/fleet normalize|another workspace/i);
  });

  it("refuses nested owners when the resolving root is the global config directory", async () => {
    const globalHome = await tempRoot("agentwheel-b2-globalhome-");
    const controlPlane = join(globalHome, "workspace", "control-plane");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(globalHome, "shared-skill");

    // Every control plane on the machine sits beneath the global config directory, so containment
    // there would exempt the case this guards.
    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(controlPlane), [
      ".runtime/skills/shared-skill",
    ]);

    await expect(graphPlan(source, target, globalHome, { globalRoot: globalHome })).rejects.toThrow(
      /already carries Agentwheel state owned by another workspace/,
    );
  });

  it("ignores legacy and unknown owner labels that predate workspace-root ownership", async () => {
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(projectBeta, "shared-skill");

    await writeOwnedManifest(target, alphaStateKey, "legacy:unowned", [".runtime/skills/shared-skill"]);
    await writeOwnedManifest(target, betaStateKey, "workspace:unknown", [".runtime/skills/shared-skill"]);

    const result = await graphPlan(source, target, projectBeta);
    expect(result.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
  });

  it("proceeds against foreign state when the caller forces it", async () => {
    const fleetAlpha = await tempRoot("agentwheel-b2-alpha-");
    const projectBeta = await tempRoot("agentwheel-b2-beta-");
    const target = await tempRoot("agentwheel-b2-target-");
    const source = await skillSource(projectBeta, "shared-skill");

    await writeOwnedManifest(target, alphaStateKey, workspaceOwnerForRoot(fleetAlpha), [".runtime/skills/shared-skill"]);

    const result = await graphPlan(source, target, projectBeta, { forceForeignState: true });
    expect(result.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
  });
});

// Keeps the plan path off the developer's real home: without these the resolver would read
// ~/.agentwheel/config.json and ~/.agentwheel/trust.json.
async function graphPlan(
  source: string,
  targetRoot: string,
  workspaceRoot: string,
  options: { forceForeignState?: boolean; globalRoot?: string; fleetId?: string; stateKey?: string } = {},
) {
  const isolatedHome = options.globalRoot ?? await tempRoot("agentwheel-b2-home-");
  return createGraphSourcePlan({
    roots: [{ rootId: "root", source }],
    targetRoot,
    workspaceRoot,
    adapter: foreignStateAdapter,
    installationType: "local",
    targetKey: "foreign-state",
    fleetId: options.fleetId,
    stateKey: options.stateKey,
    globalRoot: isolatedHome,
    trustStorePath: join(isolatedHome, ".agentwheel", "trust.json"),
    readOnly: true,
    isTTY: false,
    forceForeignState: options.forceForeignState,
  });
}

async function skillSource(workspaceRoot: string, skillName: string): Promise<string> {
  const root = join(workspaceRoot, "source");
  await writeText(join(root, "skills", skillName, "SKILL.md"), [
    "---",
    `name: ${skillName}`,
    "description: Fixture skill for foreign-state guard tests.",
    "---",
    "",
    `# ${skillName}`,
    "",
  ].join("\n"));
  await writeText(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture/foreign-state",
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`);
  return root;
}

async function writeOwnedManifest(
  targetRoot: string,
  stateKey: string,
  workspaceOwner: string,
  paths: string[],
): Promise<void> {
  await localTransport.writeJsonAtomic(installManifestPath(targetRoot, foreignStateAdapter.name, { stateKey }), {
    version: 2,
    adapter: foreignStateAdapter.name,
    installationType: "local",
    stateKey,
    targetRoot,
    generatedAt: new Date().toISOString(),
    revision: "fixture-revision-0000",
    entries: paths.map((path) => ({
      path,
      artifactType: "skills",
      artifactName: path.split("/").at(-1),
      installName: path.split("/").at(-1),
      logicalSelector: `skills/${path.split("/").at(-1)}`,
      kind: "dir",
      hash: "0".repeat(64),
      sourceHash: "0".repeat(64),
      updatedAt: new Date().toISOString(),
      channel: "managed",
      packageName: "fixture/other-pack",
      dependencyRole: "root",
      owners: ["fixture/other-pack"],
      refCount: 1,
      workspaceOwner,
    })),
  });
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
