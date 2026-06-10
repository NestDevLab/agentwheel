import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { applyCombinedInstallPlan, createOwnershipUninstallPlan, readInstallManifest, uninstall } from "../src/install/index.js";
import { createGraphSourcePlan, desiredArtifactsFromGraphBundle, writeGraphSourceLock } from "../src/lifecycle/source-plan.js";
import { pathExists } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-b3-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeOpenPack(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeJson(join(root, "openpack.json"), {
    schemaVersion: 2,
    version: "1.0.0",
    provides: [{ type: "rules", path: "rules" }],
    ...manifest,
  });
}

describe("OpenPack phase B dogfood", () => {
  it("syncs a shared dependency once and ownership uninstall keeps it until all roots are removed", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-b3-claude-");
    const shared = join(workspace, "shared");
    const rootA = join(workspace, "root-a");
    const rootB = join(workspace, "root-b");

    await writeText(join(shared, "rules", "shared.md"), "# Shared\n");
    await writeText(join(rootA, "rules", "root-a.md"), "# Root A\n");
    await writeText(join(rootB, "rules", "root-b.md"), "# Root B\n");
    await writeOpenPack(shared, { name: "dogfood/shared" });
    await writeOpenPack(rootA, {
      name: "dogfood/root-a",
      requires: { shared: { source: "../shared", select: ["rules/shared.md"] } },
    });
    await writeOpenPack(rootB, {
      name: "dogfood/root-b",
      requires: { shared: { source: "../shared", select: ["rules/shared.md"] } },
    });

    const combined = await createGraphSourcePlan({
      roots: [
        { rootId: "root-a", source: rootA },
        { rootId: "root-b", source: rootB },
      ],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "dogfood",
      yes: true,
    });
    await applyCombinedInstallPlan(combined.plan, { graphLockDigest: combined.graphLockDigest });
    await writeGraphSourceLock(combined);

    expect(await pathExists(combined.graphLockPath)).toBe(true);
    const manifest = await readInstallManifest(target, claudeAdapter.name);
    if (manifest?.version !== 2) throw new Error("expected v2 manifest");
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      ".claude/rules/root-a.md",
      ".claude/rules/root-b.md",
      ".claude/rules/shared.md",
    ]);
    const sharedEntry = manifest.entries.find((entry) => entry.artifactName === "shared.md");
    expect(sharedEntry?.owners).toHaveLength(2);
    expect(sharedEntry?.graphLockDigest).toBe(combined.graphLockDigest);

    const remainingRootB = await createGraphSourcePlan({
      roots: [{ rootId: "root-b", source: rootB }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "dogfood",
      yes: true,
    });
    const removeRootA = await createOwnershipUninstallPlan(manifest, desiredArtifactsFromGraphBundle(remainingRootB.bundle), claudeAdapter);
    expect(removeRootA.operations.find((operation) => operation.artifactName === "shared.md")?.action).toBe("keep");
    expect(removeRootA.operations.find((operation) => operation.artifactName === "root-a.md")?.action).toBe("remove");
    await uninstall(removeRootA);

    await expect(stat(join(target, ".claude", "rules", "root-a.md"))).rejects.toThrow();
    await expect(stat(join(target, ".claude", "rules", "shared.md"))).resolves.toBeTruthy();
    expect(await readFile(join(target, ".claude", "rules", "shared.md"), "utf8")).toBe("# Shared\n");
    const afterOne = await readInstallManifest(target, claudeAdapter.name);
    if (afterOne?.version !== 2) throw new Error("expected v2 manifest after first uninstall");
    expect(afterOne.entries.find((entry) => entry.artifactName === "shared.md")?.owners).toHaveLength(1);

    const removeRootB = await createOwnershipUninstallPlan(afterOne, [], claudeAdapter);
    expect(removeRootB.operations.find((operation) => operation.artifactName === "shared.md")?.action).toBe("remove");
    await uninstall(removeRootB);

    await expect(stat(join(target, ".claude", "rules", "shared.md"))).rejects.toThrow();
    expect(await readInstallManifest(target, claudeAdapter.name)).toBeUndefined();
  });

  it("enforces the phase B trust, no-deps, integrity, and frozen-lock minimums", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-b3-minimums-");
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");

    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
    await writeOpenPack(dep, { name: "minimums/dep" });
    await writeOpenPack(root, {
      name: "minimums/root",
      requires: { dep: { source: "../dep", select: ["rules/dep.md"] } },
    });

    const noDeps = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "minimums",
      noDeps: true,
      yes: true,
    });
    expect(noDeps.graph.nodes.map((node) => node.name)).toEqual(["minimums/root"]);
    expect(noDeps.warnings[0]).toMatch(/--no-deps ignored dependencies/);

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "minimums-trust",
      isTTY: false,
    })).rejects.toThrow(/New transitive sources require trust/);

    await writeOpenPack(root, {
      name: "minimums/root",
      requires: { dep: { source: "../dep", select: ["rules/dep.md"], integrity: "sha256-not-the-dep-hash" } },
    });
    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "minimums-integrity",
      yes: true,
    })).rejects.toThrow(/Integrity mismatch/);

    await writeOpenPack(root, {
      name: "minimums/root",
      requires: { dep: { source: "../dep", select: ["rules/dep.md"] } },
    });
    const locked = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "minimums-frozen",
      yes: true,
    });
    await writeGraphSourceLock(locked);

    await writeText(join(dep, "rules", "dep.md"), "# Dep changed\n");
    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "minimums-frozen",
      frozenLock: true,
      yes: true,
    })).rejects.toThrow(/Frozen lock would change graph nodes/);
  });
});
