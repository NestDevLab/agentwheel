import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { formatGraphPlan } from "../src/cli/format.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-phase-c-"): Promise<string> {
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

describe("OpenPack phase C", () => {
  it("inlines cross-package fragments with qualified provenance and locked include edges", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-target-");
    const root = join(workspace, "root");
    const core = join(workspace, "core");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n\n<!-- openpack:include core:fragments/risk.md -->\n`);
    await writeText(join(core, "fragments", "risk.md"), "Risk rubric\n");
    await writeOpenPack(core, {
      name: "phase-c/core",
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeOpenPack(root, {
      name: "phase-c/root",
      requires: { core: { source: "../core" } },
      provides: [{ type: "skills", path: "skills" }],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c",
      yes: true,
    });
    const rootNode = result.graph.nodes.find((node) => node.name === "phase-c/root");
    const coreNode = result.graph.nodes.find((node) => node.name === "phase-c/core");
    const skill = result.bundle.artifacts.find((artifact) => artifact.type === "skills" && artifact.name === "app");
    const content = await readFile(join(skill?.stagedPath ?? "", "SKILL.md"), "utf8");

    expect(rootNode).toBeTruthy();
    expect(coreNode).toBeTruthy();
    expect(content).toContain(`BEGIN openpack:include ${coreNode!.id}:fragments/risk.md sha256:`);
    expect(skill?.composedFrom?.map((entry) => entry.selector)).toEqual([`${coreNode!.id}:fragments/risk.md`]);
    expect(result.bundle.graphLock.canonical.includeEdges).toMatchObject([
      {
        fromNodeId: rootNode!.id,
        alias: "core",
        toNodeId: coreNode!.id,
        selector: "fragments/risk.md",
      },
    ]);
    expect(formatGraphPlan(result)).toContain(`INCLUDE ${rootNode!.id} <- ${coreNode!.id}:fragments/risk.md via core`);
  });

  it("keeps dependency fragments raw until a parent recursively consumes them", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-nested-target-");
    const app = join(workspace, "app");
    const overlay = join(workspace, "overlay");
    const core = join(workspace, "core");

    await writeText(join(app, "skills", "demo", "SKILL.md"), `---\nname: demo\ndescription: Fixture skill for tests.\n---\n\n<!-- openpack:include overlay:fragments/base.md -->\n`);
    await writeText(join(overlay, "fragments", "base.md"), "Overlay\n<!-- openpack:include core:fragments/base.md -->\n<!-- openpack:include fragments/local.md -->\n");
    await writeText(join(overlay, "fragments", "local.md"), "Local\n");
    await writeText(join(core, "fragments", "base.md"), "Core\n<!-- openpack:include fragments/policy.md -->\n");
    await writeText(join(core, "fragments", "policy.md"), "Policy\n");
    await writeOpenPack(core, {
      name: "phase-c/nested-core",
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeOpenPack(overlay, {
      name: "phase-c/nested-overlay",
      requires: { core: { source: "../core" } },
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeOpenPack(app, {
      name: "phase-c/nested-app",
      requires: { overlay: { source: "../overlay" } },
      provides: [{ type: "skills", path: "skills" }],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "app", source: app, select: ["skills/demo"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-nested",
      yes: true,
    });
    const skill = result.bundle.artifacts.find((artifact) => artifact.type === "skills" && artifact.name === "demo");
    const content = await readFile(join(skill?.stagedPath ?? "", "SKILL.md"), "utf8");

    expect(content).toContain("Overlay");
    expect(content).toContain("Local");
    expect(content).toContain("Core");
    expect(content).toContain("Policy");
  });

  it("does not fall back from include aliases to local names", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-shadow-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n\n<!-- openpack:include core:fragments/risk.md -->\n`);
    await writeText(join(root, "core:fragments", "risk.md"), "Not an alias\n");
    await writeOpenPack(root, {
      name: "phase-c/shadow",
      provides: [{ type: "skills", path: "skills" }],
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-shadow",
      yes: true,
    })).rejects.toThrow(/Dependency alias not found .*core/);
  });

  it("does not resolve compose aliases for runtime-ineligible artifacts", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-runtime-filter-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "instructions", "AGENTS.md"), "# OpenClaw instructions\n");
    await writeText(join(root, "skills", "app", "SKILL.md"), "---\nname: app\ndescription: Fixture skill for tests.\n---\n\n# App\n");
    await writeOpenPack(root, {
      name: "phase-c/runtime-filter",
      requires: {
        core: { source: "../unavailable-core", select: ["fragments/base.md"] },
      },
      provides: [
        {
          type: "instructions",
          path: "instructions/AGENTS.md",
          runtimes: ["openclaw"],
          items: {
            "AGENTS.md": { compose: [{ include: "core:fragments/base.md" }] },
          },
        },
        { type: "skills", path: "skills", runtimes: ["codex", "claude"] },
      ],
    });

    const codex = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: codexAdapter,
      targetKey: "phase-c-runtime-filter-codex",
      noDeps: true,
      yes: true,
    });
    expect(codex.bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/app"]);

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["instructions/AGENTS.md"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-runtime-filter-openclaw",
      noDeps: true,
      yes: true,
    })).rejects.toThrow(/Dependency alias not found .*core/);
  });

  it("reports cross-package include cycles with the full chain", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-cycle-target-");
    const a = join(workspace, "a");
    const b = join(workspace, "b");

    await writeText(join(a, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n\n<!-- openpack:include b:fragments/b.md -->\n`);
    await writeText(join(a, "fragments", "a.md"), "<!-- openpack:include b:fragments/b.md -->\n");
    await writeText(join(b, "fragments", "b.md"), "<!-- openpack:include a:fragments/a.md -->\n");
    await writeOpenPack(a, {
      name: "phase-c/a",
      requires: { b: { source: "../b" } },
      provides: [
        { type: "fragments", path: "fragments" },
        { type: "skills", path: "skills" },
      ],
    });
    await writeOpenPack(b, {
      name: "phase-c/b",
      requires: { a: { source: "../a" } },
      provides: [{ type: "fragments", path: "fragments" }],
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "a", source: a, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-cycle",
      yes: true,
    })).rejects.toThrow(/OpenPack include cycle: .*skills\/app\/SKILL\.md.*fragments\/b\.md.*fragments\/a\.md.*fragments\/b\.md/s);
  });

  it("uses dependency fragment overrides before cross-package expansion", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-override-target-");
    const root = join(workspace, "root");
    const core = join(workspace, "core");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n\n<!-- openpack:include core:fragments/risk.md -->\n`);
    await writeText(join(core, "fragments", "risk.md"), "Upstream\n");
    await writeText(join(workspace, ".agentwheel", "overrides", "phase-c", "core", "fragments", "risk.md"), "Override\n");
    await writeOpenPack(core, {
      name: "phase-c/core",
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeOpenPack(root, {
      name: "phase-c/root",
      requires: { core: { source: "../core" } },
      provides: [{ type: "skills", path: "skills" }],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-override",
      yes: true,
    });
    const skill = result.bundle.artifacts.find((artifact) => artifact.type === "skills" && artifact.name === "app");
    const content = await readFile(join(skill?.stagedPath ?? "", "SKILL.md"), "utf8");

    expect(content).toContain("Override");
    expect(content).not.toContain("Upstream");
  });

  it("selects local item requirements with dry-run reasons", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-local-req-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n`);
    await writeText(join(root, "rules", "helper.md"), "# Helper\n");
    await writeOpenPack(root, {
      name: "phase-c/local-req",
      provides: [
        { type: "rules", path: "rules" },
        {
          type: "skills",
          path: "skills",
          items: {
            app: { requires: ["rules/helper.md"] },
          },
        },
      ],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-c-local-req",
      yes: true,
    });

    expect(result.graph.roots[0]?.selected).toEqual(["rules/helper.md", "skills/app"]);
    expect(result.bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`).sort()).toEqual([
      "rules/helper.md",
      "skills/app",
    ]);
    expect(formatGraphPlan(result)).toContain("rules/helper.md (required by skills/app)");
  });

  it("pulls alias item requirements only when the parent artifact is selected", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-alias-req-target-");
    const root = join(workspace, "root");
    const core = join(workspace, "core");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n`);
    await writeText(join(root, "skills", "other", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# Other\n`);
    await writeText(join(core, "rules", "core.md"), "# Core\n");
    await writeOpenPack(core, {
      name: "phase-c/alias-core",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "phase-c/alias-root",
      requires: { core: { source: "../core" } },
      provides: [{
        type: "skills",
        path: "skills",
        items: {
          app: { requires: ["core:rules/core.md"] },
        },
      }],
    });

    const other = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/other"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-c-alias-req-other",
      yes: true,
    });
    expect(other.graph.nodes.map((node) => node.name)).toEqual(["phase-c/alias-root"]);

    const app = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-c-alias-req-app",
      yes: true,
    });
    expect(app.graph.nodes.map((node) => node.name).sort()).toEqual(["phase-c/alias-core", "phase-c/alias-root"]);
    expect(app.bundle.artifacts.map((artifact) => `${artifact.dependencyRole}:${artifact.type}/${artifact.name}`).sort()).toEqual([
      "direct:rules/core.md",
      "root:skills/app",
    ]);
  });

  it("notices optional missing item requirements without failing", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-optional-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n`);
    await writeOpenPack(root, {
      name: "phase-c/optional",
      provides: [{
        type: "skills",
        path: "skills",
        items: {
          app: { requires: [{ selector: "rules/missing.md", optional: true }] },
        },
      }],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-optional",
      yes: true,
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("optional artifact requirement skipped: rules/missing.md"),
    ]);
    expect(result.graph.nodes).toHaveLength(1);
  });

  it("skips runtime-scoped item requirements when the adapter is excluded", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-runtime-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "app", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# App\n`);
    await writeText(join(root, "rules", "codex.rules"), [
      "# Codex",
      "prefix_rule(",
      "    pattern = [\"gh\", \"pr\", \"view\"],",
      "    decision = \"prompt\",",
      "    justification = \"Viewing PRs is allowed with approval\",",
      ")",
      "",
    ].join("\n"));
    await writeOpenPack(root, {
      name: "phase-c/runtime",
      provides: [
        { type: "rules", path: "rules" },
        {
          type: "skills",
          path: "skills",
          items: {
            app: { requires: [{ selector: "rules/codex.rules", runtimes: ["codex"] }] },
          },
        },
      ],
    });

    const claude = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "phase-c-runtime-claude",
      yes: true,
    });
    expect(claude.graph.roots[0]?.selected).toEqual(["skills/app"]);
    expect(claude.warnings[0]).toMatch(/skip requirement .*not targeted/);

    const codex = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/app"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: codexAdapter,
      targetKey: "phase-c-runtime-codex",
      yes: true,
    });
    expect(codex.graph.roots[0]?.selected).toEqual(["rules/codex.rules", "skills/app"]);
  });

  it("does not fetch unused aliases", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-phase-c-unused-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "safe", "SKILL.md"), `---\nname: fixture\ndescription: Fixture skill for tests.\n---\n\n# Safe\n`);
    await writeOpenPack(root, {
      name: "phase-c/unused",
      requires: { loud: { source: "../does-not-exist" } },
      provides: [{ type: "skills", path: "skills" }],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/safe"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawAdapter,
      targetKey: "phase-c-unused",
      yes: true,
    });

    expect(result.graph.nodes.map((node) => node.name)).toEqual(["phase-c/unused"]);
  });
});
