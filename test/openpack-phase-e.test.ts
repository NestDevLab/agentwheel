import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { formatGraphPlan } from "../src/cli/format.js";
import { applyCombinedInstallPlan } from "../src/install/index.js";
import type { InstallPlan } from "../src/install/plan.js";
import { createGraphSourcePlan, createSourcePlan, writeGraphSourceLock } from "../src/lifecycle/source-plan.js";
import { forgetTrustedSources, readTrustedSources } from "../src/lifecycle/trust.js";
import { stringifyGraphLock } from "../src/model/graph-lock.js";
import { writeWorkspaceConfig } from "../src/model/workspace.js";
import { RegistryClient } from "../src/registry/client.js";
import { SkillKitSourceDriver } from "../src/source/skillkit.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-phase-e-"): Promise<string> {
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
    ...manifest,
  });
}

describe("OpenPack phase E", () => {
  it("uses trust allow patterns without prompting for new transitive sources", async () => {
    const workspace = await tempRoot();
    const { root, dep } = await dependencyFixture(workspace, "allow");
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { allow: [`local:${dep}`] },
      packages: [],
      profiles: {},
      agents: {},
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-allow",
      promptTrust: async () => {
        throw new Error("prompt should not be called");
      },
    });

    expect(result.newTransitiveSources).toEqual([]);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("blocks denied dependency artifact types even when root-selected", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep-hooks");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "hooks", "guard.sh"), "echo guard\n");
    await writeOpenPack(dep, { name: "phase-e/hooks", provides: [{ type: "hooks", path: "hooks" }] });
    await writeOpenPack(root, {
      name: "phase-e/root-hooks",
      requires: { hooks: { source: "../dep-hooks", select: ["hooks/guard.sh"] } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { allow: ["local:*"], denyArtifactTypes: ["hooks"] },
      packages: [],
      profiles: {},
      agents: {},
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-deny-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-deny",
    })).rejects.toThrow(/trust\.denyArtifactTypes.*phase-e\/hooks.*hooks\/guard\.sh/s);
  });

  it("blocks denied artifact types for root-selected artifacts too", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root-deny-root");
    await writeText(join(root, "hooks", "guard.sh"), "echo guard\n");
    await writeOpenPack(root, { name: "phase-e/root-denied-hook", provides: [{ type: "hooks", path: "hooks" }] });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { denyArtifactTypes: ["hooks"] },
      packages: [],
      profiles: {},
      agents: {},
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-root-deny-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "root-deny",
    })).rejects.toThrow(/trust\.denyArtifactTypes.*phase-e\/root-denied-hook.*hooks\/guard\.sh/s);
  });

  it("allows transitive sources when review is disabled by policy", async () => {
    const workspace = await tempRoot();
    const { root } = await dependencyFixture(workspace, "review-off");
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { requireReviewForTransitive: false },
      packages: [],
      profiles: {},
      agents: {},
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-review-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-review-off",
      promptTrust: async () => {
        throw new Error("prompt should not be called");
      },
    });

    expect(result.newTransitiveSources).toEqual([]);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("persists accepted trust and can forget it by pattern", async () => {
    const workspace = await tempRoot();
    const trustStore = join(workspace, "user-trust.json");
    const { root, dep } = await dependencyFixture(workspace, "persist");
    let prompts = 0;

    const first = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-persist-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-persist",
      trustStorePath: trustStore,
      promptTrust: async () => {
        prompts += 1;
        return true;
      },
    });
    await rm(first.bundle.root, { recursive: true, force: true });

    expect(await readTrustedSources(workspace, trustStore)).toContain(`local:${dep}`);

    const second = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-persist-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-persist",
      trustStorePath: trustStore,
      promptTrust: async () => {
        throw new Error("persisted trust should skip prompt");
      },
    });
    await rm(second.bundle.root, { recursive: true, force: true });

    expect(prompts).toBe(1);
    expect(await forgetTrustedSources(workspace, `local:${dep}`, trustStore)).toEqual([`local:${dep}`]);
    expect(await readTrustedSources(workspace, trustStore)).toEqual([]);
  });

  it("does not trust project-local acceptedSources on first use", async () => {
    const workspace = await tempRoot();
    const trustStore = join(workspace, "user-trust.json");
    const { root, dep } = await dependencyFixture(workspace, "poison");
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { acceptedSources: [`local:${dep}`] },
      packages: [],
      profiles: {},
      agents: {},
    });
    let prompts = 0;

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-poison-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "trust-poison",
      trustStorePath: trustStore,
      promptTrust: async () => {
        prompts += 1;
        return true;
      },
    });

    expect(prompts).toBe(1);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("enforces merged global trust policy during graph planning", async () => {
    const workspace = await tempRoot();
    const globalRoot = await tempRoot("agentwheel-phase-e-global-");
    const { root } = await dependencyFixture(workspace, "global-deny");
    await writeWorkspaceConfig(globalRoot, {
      schemaVersion: 1,
      registry: {},
      trust: { denyArtifactTypes: ["rules"] },
      packages: [],
      profiles: {},
      agents: {},
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-e-global-target-"),
      workspaceRoot: workspace,
      globalRoot,
      adapter: openClawAdapter,
      targetKey: "global-deny",
      yes: true,
    })).rejects.toThrow(/trust\.denyArtifactTypes.*rules\/root\.md/s);
  });

  it("resolves offline from a warm lock and reports missing locked sources", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-e-offline-target-");
    const { root, dep } = await dependencyFixture(workspace, "offline");

    const warm = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "offline",
      yes: true,
      trustStorePath: join(workspace, "offline-trust.json"),
    });
    await writeGraphSourceLock(warm);
    await rm(warm.bundle.root, { recursive: true, force: true });

    const offline = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "offline",
      offline: true,
      trustStorePath: join(workspace, "offline-trust.json"),
    });
    expect(offline.graphDiff).toEqual([]);
    await rm(offline.bundle.root, { recursive: true, force: true });

    await rm(dep, { recursive: true, force: true });
    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "offline",
      offline: true,
    })).rejects.toThrow(/Offline cache missing or stale.*phase-e\/offline-dep/s);
  });

  it("keeps offline source planning from refreshing registry or provider paths", async () => {
    const workspace = await tempRoot();
    await expect(createSourcePlan({
      source: "missing-registry-entry",
      targetRoot: await tempRoot("agentwheel-phase-e-source-offline-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      offline: true,
    })).rejects.toThrow(/Offline cannot refresh registry indexes/);

    let cloned = false;
    const driver = new SkillKitSourceDriver({
      detectProvider: () => ({
        clone: async () => {
          cloned = true;
          return { success: true, path: await tempRoot("agentwheel-phase-e-skillkit-clone-") };
        },
      }),
      discoverSkills: () => [],
      translateSkill: () => ({}),
    });
    const resolved = await driver.resolve("skillkit:github:example/remote-skill", {
      cacheRoot: join(workspace, "cache"),
      frozenLock: true,
    });

    await expect(driver.fetch(resolved)).rejects.toThrow(/Frozen lock requires cached SkillKit source/);
    expect(cloned).toBe(false);
  });

  it("rejects unsafe install names at plan and apply time", async () => {
    const workspace = await tempRoot();
    const { root } = await dependencyFixture(workspace, "unsafe-alias");

    await expect(createGraphSourcePlan({
      roots: [{
        rootId: "root",
        source: root,
        aliases: { "phase-e/unsafe-alias-dep:rules/dep.md": "../outside.md" },
      }],
      targetRoot: await tempRoot("agentwheel-phase-e-unsafe-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "unsafe-alias",
      yes: true,
      trustStorePath: join(workspace, "unsafe-trust.json"),
    })).rejects.toThrow(/Invalid install name.*path separators/);

    const target = await tempRoot("agentwheel-phase-e-apply-containment-");
    const sourceFile = join(workspace, "source.md");
    await writeText(sourceFile, "x\n");
    const plan: InstallPlan = {
      adapter: "openclaw",
      targetRoot: target,
      operations: [{
        action: "create",
        artifactType: "rules",
        artifactName: "escape.md",
        kind: "file",
        sourcePath: sourceFile,
        destPath: join(target, "..", "escape.md"),
        relativeDestPath: "../escape.md",
        desiredHash: "0".repeat(64),
        reason: "test",
        channel: "managed",
      }],
      hasBlockingChanges: false,
      baseRevision: null,
    };
    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/outside target root/);
  });

  it("scopes aliases to the declaring root dependency graph", async () => {
    const workspace = await tempRoot();
    const rootA = join(workspace, "root-a");
    const rootB = join(workspace, "root-b");
    await writeText(join(rootA, "rules", "a.md"), "# A\n");
    await writeText(join(rootB, "rules", "b.md"), "# B\n");
    await writeOpenPack(rootA, { name: "phase-e/root-a", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(rootB, { name: "phase-e/root-b", provides: [{ type: "rules", path: "rules" }] });

    await expect(createGraphSourcePlan({
      roots: [
        {
          rootId: "root-a",
          source: rootA,
          aliases: { "phase-e/root-b:rules/b.md": "stolen.md" },
        },
        { rootId: "root-b", source: rootB },
      ],
      targetRoot: await tempRoot("agentwheel-phase-e-alias-scope-target-"),
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "alias-scope",
      yes: true,
    })).rejects.toThrow(/cannot rename artifacts outside that root/);
  });

  it("prints graph diff lines for added, removed, and version-moved nodes", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-e-diff-target-");
    const root = join(workspace, "root");
    const depA = join(workspace, "dep-a");
    const depB = join(workspace, "dep-b");
    await writeText(join(root, "rules", "root.md"), "# Root v1\n");
    await writeText(join(depA, "rules", "a.md"), "# A\n");
    await writeText(join(depB, "rules", "b.md"), "# B\n");
    await writeOpenPack(depA, { name: "phase-e/dep-a", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(depB, { name: "phase-e/dep-b", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(root, {
      name: "phase-e/root-diff",
      version: "1.0.0",
      requires: { a: { source: "../dep-a", select: ["rules/a.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });

    const initial = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "graph-diff",
      yes: true,
      trustStorePath: join(workspace, "diff-trust.json"),
    });
    await writeGraphSourceLock(initial);
    await rm(initial.bundle.root, { recursive: true, force: true });

    await writeText(join(root, "rules", "root.md"), "# Root v2\n");
    await writeOpenPack(root, {
      name: "phase-e/root-diff",
      version: "2.0.0",
      requires: { b: { source: "../dep-b", select: ["rules/b.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });

    const updated = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "graph-diff",
      yes: true,
      trustStorePath: join(workspace, "diff-trust.json"),
    });

    expect(updated.graphDiff.some((line) => /MOVED node .*phase-e\/root-diff.*version 1\.0\.0 -> 2\.0\.0/.test(line))).toBe(true);
    expect(updated.graphDiff.some((line) => /ADDED node .*phase-e\/dep-b/.test(line))).toBe(true);
    expect(updated.graphDiff.some((line) => /REMOVED node .*phase-e\/dep-a/.test(line))).toBe(true);
    expect(formatGraphPlan(updated)).toContain("Graph diff:");
    await rm(updated.bundle.root, { recursive: true, force: true });
  });

  it("serializes byte-identical graph locks for identical graphs", async () => {
    const workspace = await tempRoot();
    const { root } = await dependencyFixture(workspace, "stable-lock");
    const target = await tempRoot("agentwheel-phase-e-stable-lock-target-");
    const first = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "stable-lock",
      yes: true,
      trustStorePath: join(workspace, "stable-lock-trust.json"),
    });
    const second = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "stable-lock",
      yes: true,
      trustStorePath: join(workspace, "stable-lock-trust.json"),
    });

    expect(stringifyGraphLock(first.bundle.graphLock)).toBe(stringifyGraphLock(second.bundle.graphLock));
    expect(stringifyGraphLock(first.bundle.graphLock)).not.toContain("generatedAt");
    await rm(first.bundle.root, { recursive: true, force: true });
    await rm(second.bundle.root, { recursive: true, force: true });
  });

  it("warns for registry entries declaring newer OpenPack schema metadata", async () => {
    const workspace = await tempRoot();
    const registry = join(workspace, "registry.json");
    await writeJson(registry, [{
      name: "future-pack",
      source: "./future",
      description: "future schema",
      openpack: { schemaVersion: 99, specVersion: "future" },
    }]);
    const warnings: string[] = [];
    const client = new RegistryClient({
      workspaceRoot: workspace,
      sources: [registry],
      cachePath: join(workspace, "registry-cache.json"),
      warn: (message) => warnings.push(message),
    });

    expect((await client.getIndex()).entries[0]?.openpack?.schemaVersion).toBe(99);
    expect(warnings.join("\n")).toMatch(/future-pack.*schemaVersion 99.*supported 2/);
  });
});

async function dependencyFixture(workspace: string, label: string): Promise<{ root: string; dep: string }> {
  const root = join(workspace, `${label}-root`);
  const dep = join(workspace, `${label}-dep`);
  await writeText(join(root, "rules", "root.md"), "# Root\n");
  await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
  await writeOpenPack(dep, {
    name: `phase-e/${label}-dep`,
    provides: [{ type: "rules", path: "rules" }],
  });
  await writeOpenPack(root, {
    name: `phase-e/${label}-root`,
    requires: { dep: { source: `../${label}-dep`, select: ["rules/dep.md"] } },
    provides: [{ type: "rules", path: "rules" }],
  });
  return { root, dep };
}
