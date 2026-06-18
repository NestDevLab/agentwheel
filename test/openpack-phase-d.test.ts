import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { formatDepsWhy, formatLockDependencyTree } from "../src/cli/format.js";
import { ejectArtifact } from "../src/lifecycle/customization.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import { writeWorkspaceConfig } from "../src/model/workspace.js";
import { resolveDependencyGraph } from "../src/resolve/graph.js";
import { renderGraphForTarget } from "../src/resolve/render.js";
import { satisfiesVersionRange } from "../src/resolve/semver.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-phase-d-"): Promise<string> {
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

describe("OpenPack phase D", () => {
  it("matches supported semver ranges and keeps non-semver exact-only", () => {
    expect(satisfiesVersionRange("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfiesVersionRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesVersionRange("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesVersionRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesVersionRange("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesVersionRange("build-main", "build-main")).toBe(true);
    expect(satisfiesVersionRange("build-main", "^1.0.0")).toBe(false);
    expect(satisfiesVersionRange("build-main", "*")).toBe(true);
  });

  it("reuses the same source when version ranges are satisfiable", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "shared.md"), "# Shared\n");
    await writeOpenPack(dep, {
      name: "phase-d/shared",
      version: "1.2.3",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "phase-d/root",
      requires: {
        a: { source: "../dep", version: "^1.0.0", select: ["rules/shared.md"] },
        b: { source: "../dep", version: ">=1.2.0 <2.0.0", select: ["rules/shared.md"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    const graph = await resolveDependencyGraph([{ rootId: "root", source: root }], { workspaceRoot: workspace });

    expect(graph.nodes.filter((node) => node.name === "phase-d/shared")).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.to === graph.nodes.find((node) => node.name === "phase-d/shared")?.id)).toHaveLength(2);
  });

  it("auto-namespaces colliding transitive artifacts deterministically", async () => {
    const workspace = await tempRoot();
    const root = await transitiveDuplicateFixture(workspace);

    const first = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: await tempRoot("agentwheel-phase-d-target-"),
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-namespace",
      yes: true,
    });
    const second = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: first.plan.targetRoot,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-namespace",
      yes: true,
    });

    expect(first.bundle.graphLock.canonical.namespacing.map((item) => item.installName).sort()).toEqual([
      "phase-d-core@1--safe.md",
      "phase-d-core@2--safe.md",
    ]);
    expect(second.bundle.graphLock.canonical.namespacing).toEqual(first.bundle.graphLock.canonical.namespacing);
    expect(first.plan.operations.map((operation) => operation.relativeDestPath).filter((path) => path.includes("safe")).sort()).toEqual([
      ".claude/rules/phase-d-core@1--safe.md",
      ".claude/rules/phase-d-core@2--safe.md",
    ]);
  });

  it("keeps direct collisions blocking", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const a = join(workspace, "a");
    const b = join(workspace, "b");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(a, "rules", "safe.md"), "# A\n");
    await writeText(join(b, "rules", "safe.md"), "# B\n");
    await writeOpenPack(a, { name: "phase-d/a", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(b, { name: "phase-d/b", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(root, {
      name: "phase-d/root-direct",
      requires: {
        a: { source: "../a", select: ["rules/safe.md"] },
        b: { source: "../b", select: ["rules/safe.md"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    await expect(resolveDependencyGraph([{ rootId: "root", source: root }], { workspaceRoot: workspace }))
      .rejects.toThrow(/Direct dependency artifact collision/);
  });

  it("lets a workspace root override a colliding upstream artifact by source", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-d-source-override-target-");
    const meta = join(workspace, "meta");
    const upstream = join(workspace, "upstream");
    const fork = join(workspace, "fork");

    await writeText(join(meta, "rules", "meta.md"), "# Meta\n");
    await writeText(join(upstream, "skills", "self-improve", "SKILL.md"), "---\nname: self-improve\ndescription: Fixture skill for tests.\n---\n\nupstream\n");
    await writeText(join(fork, "skills", "self-improve", "SKILL.md"), "---\nname: self-improve\ndescription: Fixture skill for tests.\n---\n\nfork\n");
    await writeOpenPack(upstream, { name: "example-upstream/agent-toolkit", provides: [{ type: "skills", path: "skills" }] });
    await writeOpenPack(fork, { name: "example-upstream/agent-toolkit", provides: [{ type: "skills", path: "skills" }] });
    await writeOpenPack(meta, {
      name: "nestdevlab/must-have-core",
      requires: {
        toolkit: { source: "../upstream", select: ["skills/self-improve"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    await expect(createGraphSourcePlan({
      roots: [
        { rootId: "meta", source: meta },
        { rootId: "fork", source: fork, select: ["skills/self-improve"] },
      ],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-source-override-missing",
      yes: true,
    })).rejects.toThrow(/Install name collision/);

    const result = await createGraphSourcePlan({
      roots: [
        { rootId: "meta", source: meta },
        {
          rootId: "fork",
          source: fork,
          select: ["skills/self-improve"],
          overrides: [`${upstream}::skills/self-improve`],
        },
      ],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-source-override",
      yes: true,
    });

    const skills = result.bundle.artifacts.filter((artifact) => artifact.type === "skills" && artifact.name === "self-improve");
    expect(skills).toHaveLength(1);
    const stagedSelfImprove = await readFile(join(skills[0]!.stagedPath ?? "", "SKILL.md"), "utf8");
    expect(stagedSelfImprove).toContain("fork");
    expect(stagedSelfImprove).not.toContain("upstream");
    expect(result.bundle.graphLock.canonical.overrides).toMatchObject([{
      rootId: "fork",
      selector: `${upstream}::skills/self-improve`,
      type: "skills",
      name: "self-improve",
    }]);
    expect(result.bundle.graphLock.canonical.overrides[0]!.graphNodeId).toBe(skills[0]!.graphNodeId);
  });

  it("fails source overrides that do not identify exactly one losing artifact", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-d-bad-source-override-target-");
    const meta = join(workspace, "meta");
    const upstream = join(workspace, "upstream");
    const fork = join(workspace, "fork");

    await writeText(join(meta, "rules", "meta.md"), "# Meta\n");
    await writeText(join(upstream, "skills", "self-improve", "SKILL.md"), "---\nname: self-improve\ndescription: Fixture skill for tests.\n---\n\nupstream\n");
    await writeText(join(fork, "skills", "self-improve", "SKILL.md"), "---\nname: self-improve\ndescription: Fixture skill for tests.\n---\n\nfork\n");
    await writeOpenPack(upstream, { name: "phase-d/upstream", provides: [{ type: "skills", path: "skills" }] });
    await writeOpenPack(fork, { name: "phase-d/fork", provides: [{ type: "skills", path: "skills" }] });
    await writeOpenPack(meta, {
      name: "phase-d/meta",
      requires: {
        toolkit: { source: "../upstream", select: ["skills/self-improve"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    await expect(createGraphSourcePlan({
      roots: [
        { rootId: "meta", source: meta },
        {
          rootId: "fork",
          source: fork,
          select: ["skills/self-improve"],
          overrides: [`${join(workspace, "missing")}::skills/self-improve`],
        },
      ],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-bad-source-override",
      yes: true,
    })).rejects.toThrow(/did not match any rendered artifact/);
  });

  it("lets workspace aliases override namespacing and fails alias collisions", async () => {
    const workspace = await tempRoot();
    const root = await transitiveDuplicateFixture(workspace);

    const aliased = await createGraphSourcePlan({
      roots: [{
        rootId: "root",
        source: root,
        aliases: { "phase-d/core@1.0.0:rules/safe.md": "safe-v1.md" },
      }],
      targetRoot: await tempRoot("agentwheel-phase-d-alias-target-"),
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-alias",
      yes: true,
    });
    expect(aliased.bundle.graphLock.canonical.namespacing.some((item) => item.reason === "alias" && item.installName === "safe-v1.md")).toBe(true);

    await expect(createGraphSourcePlan({
      roots: [{
        rootId: "root",
        source: root,
        aliases: { "phase-d/core:rules/safe.md": "same.md" },
      }],
      targetRoot: await tempRoot("agentwheel-phase-d-alias-conflict-target-"),
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-alias-conflict",
      yes: true,
    })).rejects.toThrow(/Install name collision/);
  });

  it("formats deps tree and deps why for item-requires and include edges", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-d-why-target-");
    const root = join(workspace, "root");
    const core = join(workspace, "core");
    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n\n<!-- openpack:include core:fragments/risk.md -->\n`);
    await writeText(join(root, "rules", "helper.md"), "# Helper\n");
    await writeText(join(core, "fragments", "risk.md"), "Risk\n");
    await writeOpenPack(core, { name: "phase-d/why-core", provides: [{ type: "fragments", path: "fragments" }] });
    await writeOpenPack(root, {
      name: "phase-d/why-root",
      requires: { core: { source: "../core" } },
      provides: [
        { type: "rules", path: "rules" },
        {
          type: "skills",
          path: "skills",
          items: { app: { requires: ["rules/helper.md"] } },
        },
      ],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-why",
      yes: true,
    });
    const rootNode = result.graph.nodes.find((node) => node.name === "phase-d/why-root")!;
    const coreNode = result.graph.nodes.find((node) => node.name === "phase-d/why-core")!;

    expect(formatLockDependencyTree(result.bundle.graphLock)).toContain("Dependency graph");
    expect(formatDepsWhy(result.bundle.graphLock, undefined, `${rootNode.id}:rules/helper.md`)).toContain("SELECT  required by skills/app");
    expect(formatDepsWhy(result.bundle.graphLock, undefined, `${coreNode.id}:fragments/risk.md`)).toContain(`SELECT  included by ${rootNode.id} via core`);
  });

  it("applies versioned and exact-node overrides before package shorthand and errors on ambiguous shorthand", async () => {
    const workspace = await tempRoot();
    const pkg = join(workspace, "pkg");
    await writeText(join(pkg, "rules", "safe.md"), "Upstream\n");
    await writeOpenPack(pkg, { name: "phase-d/override", version: "1.2.3", provides: [{ type: "rules", path: "rules" }] });
    const graph = await resolveDependencyGraph([{ rootId: "pkg", source: pkg }], { workspaceRoot: workspace });
    const node = graph.nodes[0]!;

    await writeText(join(workspace, ".agentwheel", "overrides", "phase-d", "override", "rules", "safe.md"), "Package\n");
    await writeText(join(workspace, ".agentwheel", "overrides", "phase-d", "override@1.2.3", "rules", "safe.md"), "Version\n");
    await writeText(join(workspace, ".agentwheel", "overrides", ...node.id.split("/"), "rules", "safe.md"), "Exact\n");

    const rendered = await renderGraphForTarget(graph, { workspaceRoot: workspace, adapter: claudeAdapter });
    const rule = rendered.artifacts.find((artifact) => artifact.type === "rules" && artifact.name === "safe.md")!;
    expect(await readFile(rule.stagedPath ?? "", "utf8")).toBe("Exact\n");

    const dupRoot = await transitiveDuplicateFixture(workspace);
    await writeText(join(workspace, ".agentwheel", "overrides", "phase-d", "core", "rules", "safe.md"), "Ambiguous\n");
    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: dupRoot }],
      targetRoot: await tempRoot("agentwheel-phase-d-ambiguous-target-"),
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-d-ambiguous",
      yes: true,
    })).rejects.toThrow(/Ambiguous override shorthand/);
  });

  it("ejects versioned package forms into versioned local state", async () => {
    const workspace = await tempRoot();
    const pkg = join(workspace, "pkg");
    await writeText(join(pkg, "rules", "safe.md"), "Safe\n");
    await writeOpenPack(pkg, { name: "phase-d/eject", version: "1.2.3", provides: [{ type: "rules", path: "rules" }] });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      packages: [{ name: "phase-d/eject", source: pkg, driver: "local", adapter: "openclaw", mode: "pinned" }],
      profiles: {},
      agents: {},
    });
    const graph = await resolveDependencyGraph([{ rootId: "pkg", source: pkg }], { workspaceRoot: workspace });
    const nodeId = graph.nodes[0]!.id;

    const result = await ejectArtifact(workspace, "phase-d/eject@1.2.3/rules/safe.md");
    const exactResult = await ejectArtifact(workspace, `${nodeId}/rules/safe.md`);

    expect(result.ejectedPath).toBe(join(workspace, ".agentwheel", "ejected", "phase-d", "eject@1.2.3", "rules", "safe.md"));
    expect(exactResult.ejectedPath).toBe(join(workspace, ".agentwheel", "ejected", ...nodeId.split("/"), "rules", "safe.md"));
    expect(await readFile(result.ejectedPath, "utf8")).toBe("Safe\n");
    expect(await readFile(exactResult.ejectedPath, "utf8")).toBe("Safe\n");
  });

  it("rejects ambiguous eject shorthand with disambiguated commands", async () => {
    const workspace = await tempRoot();
    const v1 = join(workspace, "pkg-v1");
    const v2 = join(workspace, "pkg-v2");
    await writeText(join(v1, "rules", "safe.md"), "Safe v1\n");
    await writeText(join(v2, "rules", "safe.md"), "Safe v2\n");
    await writeOpenPack(v1, { name: "phase-d/eject-ambiguous", version: "1.0.0", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(v2, { name: "phase-d/eject-ambiguous", version: "2.0.0", provides: [{ type: "rules", path: "rules" }] });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      packages: [
        { name: "phase-d/eject-ambiguous", source: v1, driver: "local", adapter: "openclaw", mode: "pinned" },
        { name: "phase-d/eject-ambiguous", source: v2, driver: "local", adapter: "openclaw", mode: "pinned" },
      ],
      profiles: {},
      agents: {},
    });

    await expect(ejectArtifact(workspace, "phase-d/eject-ambiguous/rules/safe.md")).rejects.toThrow(
      /Ambiguous eject shorthand.*agentwheel eject phase-d\/eject-ambiguous@1\.0\.0\/rules\/safe\.md.*agentwheel eject phase-d\/eject-ambiguous@2\.0\.0\/rules\/safe\.md/s,
    );
  });
});

async function transitiveDuplicateFixture(workspace: string): Promise<string> {
  const root = join(workspace, "root");
  const depA = join(workspace, "dep-a");
  const depB = join(workspace, "dep-b");
  const coreV1 = join(workspace, "core-v1");
  const coreV2 = join(workspace, "core-v2");

  await writeText(join(root, "rules", "root.md"), "# Root\n");
  await writeText(join(depA, "rules", "a.md"), "# A\n");
  await writeText(join(depB, "rules", "b.md"), "# B\n");
  await writeText(join(coreV1, "rules", "safe.md"), "# Safe v1\n");
  await writeText(join(coreV2, "rules", "safe.md"), "# Safe v2\n");
  await writeOpenPack(coreV1, { name: "phase-d/core", version: "1.0.0", provides: [{ type: "rules", path: "rules" }] });
  await writeOpenPack(coreV2, { name: "phase-d/core", version: "2.0.0", provides: [{ type: "rules", path: "rules" }] });
  await writeOpenPack(depA, {
    name: "phase-d/dep-a",
    requires: { core: { source: "../core-v1", version: "^1.0.0", select: ["rules/safe.md"] } },
    provides: [{ type: "rules", path: "rules" }],
  });
  await writeOpenPack(depB, {
    name: "phase-d/dep-b",
    requires: { core: { source: "../core-v2", version: "^2.0.0", select: ["rules/safe.md"] } },
    provides: [{ type: "rules", path: "rules" }],
  });
  await writeOpenPack(root, {
    name: "phase-d/root",
    requires: {
      a: { source: "../dep-a", select: ["rules/a.md"] },
      b: { source: "../dep-b", select: ["rules/b.md"] },
    },
    provides: [{ type: "rules", path: "rules" }],
  });
  return root;
}
