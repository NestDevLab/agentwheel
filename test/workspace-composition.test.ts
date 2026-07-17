import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatGraphPlan, graphPlanReport } from "../src/cli/format.js";
import { syncProfile } from "../src/lifecycle/profile.js";
import { createGraphSourcePlan, writeGraphSourceLock } from "../src/lifecycle/source-plan.js";
import { createGraphLock, resolveDependencyGraph } from "../src/resolve/graph.js";
import { workspaceConfigSchema, mergeWorkspaceConfig, upsertPackage } from "../src/model/workspace.js";
import { resolveSelectionImport } from "../src/model/workspace-composition.js";
import { claudeAdapter } from "../src/adapters/claude.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-composition-"): Promise<string> {
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

async function writeProjectPackage(root: string, selections: Record<string, unknown> = defaultSelections()): Promise<void> {
  await writeText(join(root, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A fixture skill.\n---\n\n# A\n");
  await writeText(join(root, "skills", "b", "SKILL.md"), "---\nname: b\ndescription: B fixture skill.\n---\n\n# B\n");
  await writeText(join(root, "skills", "c", "SKILL.md"), "---\nname: c\ndescription: C fixture skill.\n---\n\n# C\n");
  await writeText(join(root, "rules", "required.md"), "# Required\n");
  await writeJson(join(root, "openpack.json"), {
    schemaVersion: 2,
    name: "acme/project",
    version: "1.0.0",
    provides: [
      { type: "skills", path: "skills" },
      { type: "rules", path: "rules/required.md", required: true },
    ],
  });
  await writeJson(join(root, ".agentwheel", "config.json"), {
    schemaVersion: 2,
    exports: { selections },
  });
}

function defaultSelections(): Record<string, unknown> {
  return {
    default: { select: ["skills/a", "skills/b", "rules/required.md"] },
    odino: { extends: "default", add: ["skills/c"], exclude: ["skills/b"] },
  };
}

describe("workspace configuration composition", () => {
  it("requires v2 for composition and preserves v2 exports through config helpers", () => {
    expect(() => workspaceConfigSchema.parse({
      schemaVersion: 1,
      packages: [],
      registry: {},
      trust: {},
      profiles: {},
      agents: {},
      exports: { selections: { default: { select: ["skills/a"] } } },
    })).toThrow(/never|Invalid input/i);
    expect(() => workspaceConfigSchema.parse({
      schemaVersion: 1,
      packages: [{ name: "pkg", source: ".", selection: { export: "default" } }],
      registry: {},
      trust: {},
      profiles: {},
      agents: {},
    })).toThrow(/never|Invalid input/i);
    expect(() => workspaceConfigSchema.parse({
      schemaVersion: 2,
      packages: [{ name: "pkg", source: ".", select: ["skills/a"], selection: { export: "default" } }],
      registry: {},
      trust: {},
      profiles: {},
      agents: {},
      exports: { selections: { default: { select: ["skills/a"] } } },
    })).toThrow(/either selection or select\/skills/i);
    expect(() => workspaceConfigSchema.parse({
      schemaVersion: 2,
      packages: [{ name: "pkg", source: ".", select: [], selection: { export: "default" } }],
      registry: {},
      trust: {},
      profiles: {},
      agents: {},
      exports: { selections: { default: { select: ["skills/a"] } } },
    })).toThrow(/either selection or select\/skills/i);

    const v2 = workspaceConfigSchema.parse({
      schemaVersion: 2,
      packages: [],
      registry: {},
      trust: {},
      profiles: {},
      agents: {},
      exports: { selections: { default: { select: ["skills/a"] } } },
    });
    const updated = upsertPackage(v2, { name: "pkg", source: ".", driver: "local", adapter: "copilot", mode: "pinned" });
    expect(updated).toMatchObject({ schemaVersion: 2, exports: { selections: { default: { select: ["skills/a"] } } } });
    expect(mergeWorkspaceConfig(
      workspaceConfigSchema.parse({ schemaVersion: 1, packages: [], registry: {}, trust: {}, profiles: {}, agents: {} }),
      v2,
    )).toMatchObject({ schemaVersion: 2, exports: v2.exports });
  });

  it("resolves only exported source selections with extends, additions, and exclusions", async () => {
    const source = await tempRoot();
    await writeProjectPackage(source);
    const configPath = join(source, ".agentwheel", "config.json");
    const sourceConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    sourceConfig.agents = { hostPolicy: { adapter: "hermes", root: "/not-used", transport: "ssh", host: "not-used" } };
    sourceConfig.trust = { allow: ["everything"] };
    await writeJson(configPath, sourceConfig);

    const resolved = await resolveSelectionImport(source, "local", {
      export: "odino",
      add: ["skills/b", "skills/b"],
      exclude: ["skills/c"],
    });

    expect(resolved.extends).toEqual(["default", "odino"]);
    expect(resolved.inherited).toEqual(["rules/required.md", "skills/a", "skills/c"]);
    expect(resolved.additions).toEqual(["skills/b"]);
    expect(resolved.exclusions).toEqual(["skills/c"]);
    expect(resolved.effective).toEqual(["rules/required.md", "skills/a", "skills/b"]);
    expect(resolved.configPath).toBe(".agentwheel/config.json");
    expect(resolved.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.exportHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(resolveSelectionImport(source, "skillkit", { export: "odino" })).rejects.toThrow(/unsupported for source driver 'skillkit'/);
  });

  it("reports missing exports and full extends cycles clearly", async () => {
    const source = await tempRoot();
    await writeProjectPackage(source, {
      first: { extends: "second", add: ["skills/a"] },
      second: { extends: "first", add: ["skills/b"] },
    });
    await expect(resolveSelectionImport(source, "local", { export: "missing" })).rejects.toThrow("Selection export not found: missing");
    await expect(resolveSelectionImport(source, "local", { export: "first" })).rejects.toThrow("Selection export cycle: first -> second -> first");
  });

  it("uses a local source export in the graph, preserves required artifacts, and records auditable lock metadata", async () => {
    const workspace = await tempRoot();
    const source = join(workspace, "project");
    await writeProjectPackage(source);

    const graph = await resolveDependencyGraph([{
      rootId: "project",
      source,
      selection: { export: "default", exclude: ["rules/required.md", "skills/b"] },
    }], { workspaceRoot: workspace });
    const root = graph.roots[0]!;
    const lock = createGraphLock(graph);

    expect(root.selected).toEqual(["rules/required.md", "skills/a"]);
    expect(root.selectionImport).toMatchObject({
      exportName: "default",
      exclusions: ["rules/required.md", "skills/b"],
      effective: ["rules/required.md", "skills/a"],
    });
    expect(lock.canonical.roots[0]?.selectionImport).toEqual(root.selectionImport);

    const onlyRequired = await resolveDependencyGraph([{
      rootId: "only-required",
      source,
      selection: { export: "default", exclude: ["rules/required.md", "skills/a", "skills/b"] },
    }], { workspaceRoot: workspace });
    expect(onlyRequired.roots[0]?.selected).toEqual(["rules/required.md"]);
    expect(onlyRequired.roots[0]?.selectionImport?.effective).toEqual(["rules/required.md"]);
  });

  it("uses the source configuration from the resolved git snapshot", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "source-repo");
    await writeProjectPackage(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "source config"]);
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const graph = await resolveDependencyGraph([{
      rootId: "git-project",
      source: `git:${repo}#${commit}`,
      mode: "pinned",
      selection: { export: "odino" },
    }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache"),
    });

    expect(graph.roots[0]?.selectionImport).toMatchObject({
      exportName: "odino",
      extends: ["default", "odino"],
      effective: ["rules/required.md", "skills/a", "skills/c"],
    });
    expect(graph.nodes[0]?.resolvedCommit).toBe(commit);
  });

  it("keeps project-owned local profiles portable and rejects config-only selection changes under frozen lock", async () => {
    const workspace = await tempRoot();
    await writeProjectPackage(workspace);
    await writeJson(join(workspace, ".agentwheel", "config.json"), {
      schemaVersion: 2,
      exports: { selections: defaultSelections() },
      packages: [{
        name: "project",
        source: ".",
        driver: "local",
        adapter: "copilot",
        mode: "pinned",
        selection: { export: "default" },
      }],
      profiles: {
        "local-mac": { runtimes: [{ agent: "mac-copilot" }] },
      },
      agents: {
        "mac-copilot": { adapter: "copilot", root: ".", installationType: "local" },
      },
      registry: {},
      trust: {},
    });

    const profile = await syncProfile({
      workspaceRoot: workspace,
      profile: "local-mac",
      dryRun: true,
      readOnly: true,
      yes: true,
    });
    expect(profile).toHaveLength(1);
    expect(profile[0]?.runtime).toBe("copilot");
    expect(profile[0]?.graphPlan.graph.roots[0]?.selectionImport?.exportName).toBe("default");
    await expect(syncProfile({
      workspaceRoot: workspace,
      profile: "local-mac",
      select: ["skills/a"],
      dryRun: true,
      readOnly: true,
      yes: true,
    })).rejects.toThrow(/cannot be combined with a package selection import/);

    const first = await createGraphSourcePlan({
      roots: [{ rootId: "project", source: workspace, selection: { export: "default" } }],
      workspaceRoot: workspace,
      targetRoot: join(workspace, "target"),
      adapter: claudeAdapter,
      targetKey: "frozen",
      globalRoot: join(workspace, "no-global"),
      readOnly: true,
      yes: true,
    });
    expect(formatGraphPlan(first)).toContain("IMPORT  root=project");
    expect(formatGraphPlan(first)).toContain("SELECT  root=project");
    expect(graphPlanReport(first).roots[0]?.selectionImport?.exportName).toBe("default");
    await writeGraphSourceLock(first);
    await rm(first.bundle.root, { recursive: true, force: true });

    await writeJson(join(workspace, ".agentwheel", "config.json"), {
      schemaVersion: 2,
      exports: { selections: {
        default: { select: ["skills/a", "skills/c", "rules/required.md"] },
      } },
      packages: [{
        name: "project",
        source: ".",
        driver: "local",
        adapter: "copilot",
        mode: "pinned",
        selection: { export: "default" },
      }],
      profiles: { "local-mac": { runtimes: [{ agent: "mac-copilot" }] } },
      agents: { "mac-copilot": { adapter: "copilot", root: ".", installationType: "local" } },
      registry: {},
      trust: {},
    });

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "project", source: workspace, selection: { export: "default" } }],
      workspaceRoot: workspace,
      targetRoot: join(workspace, "target"),
      adapter: claudeAdapter,
      targetKey: "frozen",
      globalRoot: join(workspace, "no-global"),
      frozenLock: true,
      readOnly: true,
      yes: true,
    })).rejects.toThrow(/selection import changed/);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
