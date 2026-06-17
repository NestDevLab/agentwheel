import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { copilotAdapter } from "../src/adapters/copilot.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../src/install/index.js";
import { ejectArtifact, remember } from "../src/lifecycle/customization.js";
import { upsertPackage, writeWorkspaceConfig } from "../src/model/workspace.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-wave2-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeFullPackage(root: string, options: { instruction?: string; rule?: string } = {}): Promise<void> {
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills", "demo-skill"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "subagents", "reviewer"), { recursive: true });
  await mkdir(join(root, "mcp"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "plugins", "demo-plugin"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "acme/wave2",
    version: "0.2.0",
    provides: [
      { type: "instructions", path: "instructions/AGENTS.md" },
      { type: "rules", path: "rules" },
      { type: "skills", path: "skills" },
      { type: "commands", path: "commands" },
      { type: "subagents", path: "subagents" },
      { type: "mcp", path: "mcp" },
      { type: "hooks", path: "hooks" },
      { type: "plugins", path: "plugins" },
    ],
  }, null, 2));
  await writeFile(join(root, "instructions", "AGENTS.md"), options.instruction ?? "# Wave 2 instructions\n");
  await writeFile(join(root, "rules", "core.md"), options.rule ?? "# Wave 2 rule\n");
  await writeFile(join(root, "skills", "demo-skill", "SKILL.md"), "# Demo skill\n");
  await writeFile(join(root, "commands", "review.md"), "# Review command\n");
  await writeFile(join(root, "subagents", "code-reviewer.md"), "# Code reviewer\n");
  await writeFile(join(root, "subagents", "reviewer", "AGENTS.md"), "# Reviewer\n");
  await writeFile(join(root, "mcp", "server.json"), JSON.stringify({ mcpServers: { demo: { command: "demo" } } }, null, 2));
  await writeFile(join(root, "hooks", "pre-sync.json"), JSON.stringify({ event: "pre-sync", command: "echo ok" }, null, 2));
  await writeFile(join(root, "plugins", "demo-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }, null, 2));
}

async function withTestHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENTWHEEL_TEST_HOME;
  process.env.AGENTWHEEL_TEST_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTWHEEL_TEST_HOME;
    } else {
      process.env.AGENTWHEEL_TEST_HOME = previous;
    }
  }
}

describe("v0.2 wave 2", () => {
  it("installs Hermes user skills and rejects local skills", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-wave2-hermes-home-");
    await writeFullPackage(source);

    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/demo-skill"] });
    await expect(createInstallPlan(bundle, hermesAdapter, target)).rejects.toThrow(/does not support skills artifacts for installation type 'local'/);
    await withTestHome(home, async () => {
      const plan = await createInstallPlan(bundle, hermesAdapter, target, undefined, undefined, { installationType: "user" });
      await applyInstallPlan(plan, bundle.sourceLock);
    });

    await expect(stat(join(home, ".hermes", "skills", "demo-skill"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".hermes", "skills", "demo-skill"))).rejects.toThrow();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("installs Copilot instructions, rules, prompts, skills, agents, and merges workspace MCP", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeFullPackage(source);
    await mkdir(join(target, ".github"), { recursive: true });
    await writeFile(join(target, ".github", "mcp.json"), JSON.stringify({
      mcpServers: { user: { command: "user" } },
      keep: true,
    }, null, 2));

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: [
        "instructions/AGENTS.md",
        "rules/core.md",
        "commands/review.md",
        "skills/demo-skill",
        "subagents/code-reviewer.md",
        "subagents/reviewer",
        "mcp/server.json",
      ],
    });
    const plan = await createInstallPlan(bundle, copilotAdapter, target);
    await applyInstallPlan(plan, bundle.sourceLock);

    const planned = plan.operations.map((operation) => `${operation.artifactType}:${operation.artifactName}`).sort();
    expect(planned).toEqual(expect.arrayContaining([
      "commands:review.md",
      "instructions:AGENTS.md",
      "mcp:server.json",
      "rules:core.md",
      "skills:demo-skill",
      "subagents:code-reviewer.agent.md",
      "subagents:reviewer.agent.md",
    ]));
    expect(planned.some((operation) => operation.startsWith("hooks:"))).toBe(false);
    expect(planned.some((operation) => operation.startsWith("settings:"))).toBe(false);
    expect(planned.some((operation) => operation.startsWith("plugins:"))).toBe(false);
    await expect(stat(join(target, ".github", "copilot-instructions.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "instructions", "core.instructions.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "prompts", "review.prompt.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "skills", "demo-skill", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "agents", "code-reviewer.agent.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "agents", "reviewer.agent.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".github", "agents", "reviewer", "AGENTS.md"))).rejects.toThrow();
    expect(await readFile(join(target, ".github", "agents", "reviewer.agent.md"), "utf8")).toContain('description: "Reviewer"');
    const mcp = JSON.parse(await readFile(join(target, ".github", "mcp.json"), "utf8"));
    expect(mcp.keep).toBe(true);
    expect(mcp.mcpServers.user.command).toBe("user");
    expect(mcp.mcpServers.demo.command).toBe("demo");
    await expect(stat(join(target, ".github", "hooks", "pre-sync.json"))).rejects.toThrow();
    await expect(stat(join(target, ".github", "plugins", "demo-plugin"))).rejects.toThrow();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("installs OpenClaw skills and plans plugin installs without executing them by default", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeFullPackage(source);

    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/demo-skill", "plugins/demo-plugin"] });
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    const plugin = plan.operations.find((operation) => operation.artifactType === "plugins");

    expect(plugin?.action).toBe("plugin");
    expect(plugin?.semanticCommand?.slice(0, 3)).toEqual(["openclaw", "plugins", "install"]);
    expect(plugin?.semanticCommand).not.toContain("--link");

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);
    const entry = manifest.entries.find((candidate) => candidate.artifactType === "plugins");
    expect(entry?.semanticCommand?.slice(0, 3)).toEqual(["openclaw", "plugins", "install"]);
    expect(entry?.semanticCommand).not.toContain("--link");
    expect(entry?.executed).toBe(false);
    await expect(stat(join(target, "skills", "demo-skill", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".openclaw", "plugins", "demo-plugin"))).rejects.toThrow();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("ejects an artifact into local ownership and plans it as ejected", async () => {
    const source = await tempRoot();
    const workspace = await tempRoot();
    await writeFullPackage(source);
    await writeWorkspaceConfig(workspace, upsertPackage({ schemaVersion: 1, packages: [], registry: {}, profiles: {}, agents: {} }, {
      name: "acme/wave2",
      source,
      driver: "local",
      adapter: "claude",
      mode: "pinned",
    }));

    const result = await ejectArtifact(workspace, "acme/wave2/rules/core.md");
    expect(await readFile(result.ejectedPath, "utf8")).toBe("# Wave 2 rule\n");

    await writeFullPackage(source, { rule: "# Upstream changed\n" });
    const bundle = await stageSource(new LocalSourceDriver(), source, {
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      select: ["rules/core.md"],
    });
    const plan = await createInstallPlan(bundle, claudeAdapter, workspace);
    const ejected = plan.operations.find((operation) => operation.artifactType === "rules" && operation.artifactName === "core.md");
    expect(ejected?.channel).toBe("ejected");
    expect(ejected?.sourcePath).toContain(join(".agentwheel-composed", "ejected", "rules", "core.md"));
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("remembers local instructions in an overlay that survives upstream updates", async () => {
    const source = await tempRoot();
    const workspace = await tempRoot();
    await writeFullPackage(source, { instruction: "# Upstream v1\n" });
    await remember(workspace, "claude", "Remember durable preference.");

    const first = await stageSource(new LocalSourceDriver(), source, {
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      select: ["instructions/AGENTS.md"],
    });
    await applyInstallPlan(await createInstallPlan(first, claudeAdapter, workspace), first.sourceLock);
    await rm(first.root, { recursive: true, force: true });

    await writeFullPackage(source, { instruction: "# Upstream v2\n" });
    const second = await stageSource(new LocalSourceDriver(), source, {
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      select: ["instructions/AGENTS.md"],
    });
    const plan = await createInstallPlan(second, claudeAdapter, workspace, await readInstallManifest(workspace, "claude"));
    await applyInstallPlan(plan, second.sourceLock);

    const instructions = await readFile(join(workspace, "CLAUDE.md"), "utf8");
    expect(instructions).toContain("# Upstream v2");
    expect(instructions).toContain("Remember durable preference.");
    await rm(second.root, { recursive: true, force: true });
  });
});
