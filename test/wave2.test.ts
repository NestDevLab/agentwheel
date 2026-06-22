import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { copilotAdapter } from "../src/adapters/copilot.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { formatPlan } from "../src/cli/format.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, readInstallManifest, uninstall } from "../src/install/index.js";
import { ejectArtifact, remember } from "../src/lifecycle/customization.js";
import { upsertPackage, writeWorkspaceConfig } from "../src/model/workspace.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

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
  await writeFile(join(root, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Fixture skill for tests.\n---\n\n# Demo skill\n");
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
    await mkdir(join(source, "plugins", "demo-plugin", "__pycache__"), { recursive: true });
    await writeFile(join(source, "plugins", "demo-plugin", "__pycache__", "demo.cpython-312.pyc"), "compiled cache");

    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/demo-skill", "plugins/demo-plugin"] });
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    const plugin = plan.operations.find((operation) => operation.artifactType === "plugins");
    const stagedPlugin = bundle.artifacts.find((artifact) => artifact.type === "plugins")?.stagedPath;

    expect(plugin?.action).toBe("plugin");
    expect(plugin?.semanticCommand?.slice(0, 3)).toEqual(["openclaw", "plugins", "install"]);
    expect(plugin?.semanticCommand).toContain("--force");
    expect(plugin?.semanticCommand).not.toContain("--link");
    const installCommand = plugin?.semanticCommand;
    expect(installCommand).toBeDefined();
    expect(plugin?.semanticPlugin).toMatchObject({
      runtime: "openclaw",
      pluginName: "demo-plugin",
      installCommands: [installCommand],
      uninstallCommands: [["openclaw", "plugins", "uninstall", "demo-plugin", "--force"]],
    });
    await expect(stat(join(stagedPlugin ?? "", "__pycache__", "demo.cpython-312.pyc"))).rejects.toThrow();

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);
    const entry = manifest.entries.find((candidate) => candidate.artifactType === "plugins");
    expect(entry?.semanticCommand?.slice(0, 3)).toEqual(["openclaw", "plugins", "install"]);
    expect(entry?.semanticCommand).toContain("--force");
    expect(entry?.semanticCommand).not.toContain("--link");
    expect(entry?.semanticPlugin?.runtime).toBe("openclaw");
    expect(entry?.semanticPlugin?.uninstallCommands).toEqual([["openclaw", "plugins", "uninstall", "demo-plugin", "--force"]]);
    expect(entry?.executed).toBe(false);
    await expect(stat(join(target, "skills", "demo-skill", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".openclaw", "plugins", "demo-plugin"))).rejects.toThrow();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("executes OpenClaw plugin installs over ssh by staging the plugin on the target", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeFullPackage(source);

    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        await stat(args.at(-1) ?? "");
      },
    };

    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["plugins/demo-plugin"] });
    const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, sshTransport);
    const manifest = await applyInstallPlan(plan, bundle.sourceLock, {
      executePlugins: true,
      transport: sshTransport,
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]?.command).toBe("openclaw");
    expect(executed[0]?.args.slice(0, 2)).toEqual(["plugins", "install"]);
    expect(executed[0]?.args).toContain("--force");
    expect(executed[0]?.args.at(-1)).toContain(join(target, ".agentwheel", "plugin-staging"));
    expect(executed[0]?.cwd).toBe(target);
    await expect(stat(executed[0]?.args.at(-1) ?? "")).rejects.toThrow();

    const entry = manifest.entries.find((candidate) => candidate.artifactType === "plugins");
    expect(entry?.executed).toBe(true);
    expect(entry?.semanticCommand?.slice(0, 3)).toEqual(["openclaw", "plugins", "install"]);
    expect(entry?.semanticCommand).toContain("--force");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("keeps unexecuted OpenClaw semantic plugins pending for a later execute run", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeFullPackage(source);

    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        await stat(args.at(-1) ?? "");
      },
    };

    const firstBundle = await stageSource(new LocalSourceDriver(), source, { select: ["plugins/demo-plugin"] });
    const firstPlan = await createInstallPlan(firstBundle, openClawAdapter, target, undefined, sshTransport);
    const firstManifest = await applyInstallPlan(firstPlan, firstBundle.sourceLock, { transport: sshTransport });
    expect(firstManifest.entries[0]?.executed).toBe(false);
    const persistedFirstManifest = await readInstallManifest(target, openClawAdapter.name, sshTransport);
    expect(persistedFirstManifest?.entries[0]?.executed).toBe(false);
    const plannedOnlyUninstall = await createUninstallPlan(persistedFirstManifest!, sshTransport);
    expect(plannedOnlyUninstall.operations[0]?.action).toBe("remove");
    expect(formatPlan(plannedOnlyUninstall)).not.toContain("openclaw plugins uninstall");
    await rm(firstBundle.root, { recursive: true, force: true });

    const secondBundle = await stageSource(new LocalSourceDriver(), source, { select: ["plugins/demo-plugin"] });
    const secondPlan = await createInstallPlan(secondBundle, openClawAdapter, target, persistedFirstManifest, sshTransport);
    const pending = secondPlan.operations.find((operation) => operation.artifactType === "plugins");
    expect(pending?.action).toBe("plugin");
    expect(pending?.reason).toBe("semantic plugin pending execution");

    const secondManifest = await applyInstallPlan(secondPlan, secondBundle.sourceLock, {
      executePlugins: true,
      transport: sshTransport,
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.args.slice(0, 2)).toEqual(["plugins", "install"]);
    expect(secondManifest.entries[0]?.executed).toBe(true);
    await rm(secondBundle.root, { recursive: true, force: true });
  });

  it("plans and executes OpenClaw semantic plugin uninstall without a copied plugin path", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeFullPackage(source);

    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        if (args[0] === "plugins" && args[1] === "install") await stat(args.at(-1) ?? "");
      },
    };

    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["plugins/demo-plugin"] });
    const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, sshTransport);
    await applyInstallPlan(plan, bundle.sourceLock, {
      executePlugins: true,
      transport: sshTransport,
    });
    const manifest = await readInstallManifest(target, openClawAdapter.name, sshTransport);
    expect(manifest).toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });

    await expect(stat(join(target, "plugins", "demo-plugin"))).rejects.toThrow();
    const uninstallPlan = await createUninstallPlan(manifest!, sshTransport);
    expect(uninstallPlan.operations).toHaveLength(1);
    expect(uninstallPlan.operations[0]).toMatchObject({
      action: "remove",
      artifactType: "plugins",
      relativeDestPath: "plugins/demo-plugin",
      destPath: target,
    });
    expect(formatPlan(uninstallPlan)).toContain("openclaw plugins uninstall demo-plugin --force");

    const result = await uninstall(uninstallPlan, { transport: sshTransport });
    expect(result).toEqual({ removed: 1, kept: 0, removedDrifted: 0 });
    expect(executed.map((item) => [item.command, ...item.args])).toEqual([
      ["openclaw", "plugins", "install", "--force", expect.stringContaining(join(target, ".agentwheel", "plugin-staging"))],
      ["openclaw", "plugins", "uninstall", "demo-plugin", "--force"],
    ]);
    expect(await readInstallManifest(target, openClawAdapter.name, sshTransport)).toBeUndefined();
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
