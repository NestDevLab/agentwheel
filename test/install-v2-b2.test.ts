import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConfig } from "../src/model/adapter.js";
import type { ArtifactType, FileKind } from "../src/model/artifact.js";
import type { InstallManifestV1Entry, InstallManifestV2 } from "../src/model/manifest.js";
import {
  applyCombinedInstallPlan,
  createCombinedInstallPlan,
  createOwnershipUninstallPlan,
  readInstallManifest,
  recoverPendingApply,
  uninstall,
  writeInstallManifest,
  type DesiredArtifact,
} from "../src/install/index.js";
import { acquireApplyLock, applyJournalPath, applyLockPath } from "../src/install/transaction.js";
import { installManifestPath } from "../src/install/paths.js";
import { localTransport } from "../src/transport/index.js";
import type { TargetTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

const adapter: AdapterConfig = {
  name: "test",
  targets: {
    rules: { enabled: true, dest: ".runtime/rules" },
    mcp: { enabled: true, dest: ".runtime/mcp", merge: "json-deep" },
  },
};

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

describe("install manifest v2", () => {
  it("roundtrips v2 manifests with sorted owners and reads v1 manifests as legacy", async () => {
    const target = await tempRoot();
    const source = await tempRoot();
    const artifact = await writeArtifact(source, "rules/a.md", "A\n");

    await writeInstallManifest({
      version: 2,
      adapter: adapter.name,
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
    const plan = await createCombinedInstallPlan([a, b], adapter, target, manifest);
    expect(plan.migrationReport).toEqual({ adopted: 2, dropped: [".runtime/rules/orphan.md"] });
    expect(plan.operations.some((operation) => operation.relativeDestPath === ".runtime/rules/orphan.md")).toBe(false);

    await applyCombinedInstallPlan(plan);
    await expect(stat(join(target, ".runtime", "rules", "orphan.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".runtime", "rules", "renamed.md"))).rejects.toThrow();
    const next = await readInstallManifest(target, adapter.name);
    expect(next?.version).toBe(2);
    expect(next?.entries.map((entry) => entry.path).sort()).toEqual([".runtime/rules/a.md", ".runtime/rules/b.md"]);
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
});

describe("ownership uninstall and merge target guard", () => {
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

    await expect(createCombinedInstallPlan([artifact], adapter, await tempRoot())).rejects.toThrow(/Transitive mcp artifacts cannot be installed/);
  });
});

function emptyManifest(targetRoot: string): InstallManifestV2 {
  return {
    version: 2,
    adapter: adapter.name,
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
