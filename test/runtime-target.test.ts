import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan } from "../src/install/index.js";
import { createSourcePlan } from "../src/lifecycle/source-plan.js";
import { syncProfile } from "../src/lifecycle/profile.js";
import { readMergedWorkspaceConfig, writeWorkspaceConfig } from "../src/model/workspace.js";
import { resolveAllRuntimeTargets, resolveRuntimeTarget } from "../src/runtime/target.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-target-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await writeFile(join(root, "agentwheel.json"), JSON.stringify({
    schemaVersion: 1,
    name: "fixture/runtime-target",
    version: "0.1.0",
    provides: [
      { type: "instructions", path: "AGENTS.md" },
      { type: "rules", path: "rules" },
      { type: "skills", path: "skills" },
    ],
  }, null, 2), "utf8");
  await writeFile(join(root, "AGENTS.md"), "# Runtime target fixture\n", "utf8");
  await writeFile(join(root, "rules", "core.md"), "# Runtime target rule\n", "utf8");
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "# Runtime target skill\n", "utf8");
}

describe("runtime target resolution", () => {
  it("auto-detects cwd inside an OpenClaw runtime dir without nesting", async () => {
    const root = await tempRoot();
    const source = await tempRoot("agentwheel-target-source-");
    await mkdir(join(root, ".openclaw"), { recursive: true });
    await writePackage(source);

    const target = await resolveRuntimeTarget({ cwd: join(root, ".openclaw"), adapter: "openclaw" });
    expect(target.adapter).toBe("openclaw");
    expect(target.targetRoot).toBe(root);

    const result = await createSourcePlan({ source, targetRoot: target.targetRoot, workspaceRoot: target.workspaceRoot, adapter: openClawAdapter });
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toContain(".openclaw/skills/demo");
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).not.toContain(".openclaw/.openclaw/skills/demo");
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("auto-detects cwd containing a runtime dir as the runtime root", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".openclaw"), { recursive: true });
    const target = await resolveRuntimeTarget({ cwd: root, adapter: "openclaw" });
    expect(target.targetRoot).toBe(root);
    expect(target.source).toBe("auto-detect");
  });

  it("merges fleet agents with project config overriding global config", async () => {
    const globalRoot = await tempRoot("agentwheel-global-");
    const project = await tempRoot("agentwheel-project-");
    const globalAgentRoot = join(globalRoot, "global-openclaw");
    const projectAgentRoot = join(project, "project-openclaw");

    await writeWorkspaceConfig(globalRoot, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        lab: { adapter: "openclaw", root: globalAgentRoot },
        globalOnly: { adapter: "hermes", root: join(globalRoot, "hermes") },
      },
    });
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        lab: { adapter: "codex", root: projectAgentRoot },
      },
    });

    const merged = await readMergedWorkspaceConfig(project, { globalRoot });
    expect(merged.agents.lab).toEqual({ adapter: "codex", root: projectAgentRoot });
    expect(merged.agents.globalOnly?.adapter).toBe("hermes");
  });

  it("resolves --agent and --all targets to distinct roots with separate manifests", async () => {
    const project = await tempRoot("agentwheel-fleet-");
    const source = await tempRoot("agentwheel-fleet-source-");
    const alpha = join(project, "alpha-root");
    const beta = join(project, "beta-root");
    await writePackage(source);
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        alpha: { adapter: "openclaw", root: alpha },
        beta: { adapter: "openclaw", root: beta },
      },
    });

    const one = await resolveRuntimeTarget({ cwd: project, agent: "alpha" });
    expect(one.targetRoot).toBe(alpha);
    const all = await resolveAllRuntimeTargets({ cwd: project, all: true });
    expect(all.map((target) => target.targetRoot).sort()).toEqual([alpha, beta].sort());

    for (const target of all) {
      const result = await createSourcePlan({ source, targetRoot: target.targetRoot, workspaceRoot: target.workspaceRoot, adapter: openClawAdapter });
      await applyInstallPlan(result.plan, result.bundle.sourceLock);
      await rm(result.bundle.root, { recursive: true, force: true });
    }
    await expect(stat(join(alpha, ".agentwheel", "openclaw.install-manifest.json"))).resolves.toBeTruthy();
    await expect(stat(join(beta, ".agentwheel", "openclaw.install-manifest.json"))).resolves.toBeTruthy();
  });

  it("respects target resolution order", async () => {
    const cwd = await tempRoot("agentwheel-order-");
    const explicit = await tempRoot("agentwheel-explicit-");
    const agentRoot = await tempRoot("agentwheel-agent-");
    await mkdir(join(cwd, ".openclaw"), { recursive: true });
    await writeWorkspaceConfig(cwd, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        named: { adapter: "hermes", root: agentRoot },
      },
    });

    expect((await resolveRuntimeTarget({ cwd, targetRoot: explicit, agent: "named", adapter: "codex" })).targetRoot).toBe(explicit);
    const agent = await resolveRuntimeTarget({ cwd, agent: "named" });
    expect(agent.targetRoot).toBe(agentRoot);
    expect(agent.adapter).toBe("hermes");
    const auto = await resolveRuntimeTarget({ cwd });
    expect(auto.source).toBe("auto-detect");
    expect(auto.targetRoot).toBe(cwd);
    await rm(join(cwd, ".openclaw"), { recursive: true, force: true });
    const fallback = await resolveRuntimeTarget({ cwd, adapter: "codex" });
    expect(fallback.source).toBe("cwd");
    expect(fallback.targetRoot).toBe(cwd);
    expect(fallback.adapter).toBe("codex");
  });

  it("profiles can reference named agents", async () => {
    const project = await tempRoot("agentwheel-profile-agents-");
    const source = await tempRoot("agentwheel-profile-source-");
    const alpha = join(project, "alpha-root");
    await writePackage(source);
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {
        alpha: { adapter: "openclaw", root: alpha },
      },
      profiles: {
        default: {
          runtimes: [{ agent: "alpha", adapter: "openclaw" }],
        },
      },
    });

    const results = await syncProfile({
      workspaceRoot: project,
      profile: "default",
      source,
      dryRun: false,
    });
    expect(results[0]?.targetRoot).toBe(alpha);
    await expect(stat(join(alpha, ".openclaw", "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
  });
});
