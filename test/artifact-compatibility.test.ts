import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { copilotAdapter } from "../src/adapters/copilot.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, createInstallPlan, readInstallManifest, type DesiredArtifact } from "../src/install/index.js";
import { installManifestPath } from "../src/install/paths.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import type { ArtifactType, FileKind } from "../src/model/artifact.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const smokeSource = join(testDir, "fixtures", "smoke", "skills-only");
const tempRoots: string[] = [];
const originalTestHome = process.env.AGENTWHEEL_TEST_HOME;

afterEach(async () => {
  if (originalTestHome === undefined) {
    delete process.env.AGENTWHEEL_TEST_HOME;
  } else {
    process.env.AGENTWHEEL_TEST_HOME = originalTestHome;
  }
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-compat-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function desiredArtifact(root: string, type: ArtifactType, name: string, kind: FileKind = "file"): Promise<DesiredArtifact> {
  const sourcePath = join(root, type, name);
  if (kind === "dir") {
    await mkdir(sourcePath, { recursive: true });
    if (type === "plugins") {
      await mkdir(join(sourcePath, ".claude-plugin"), { recursive: true });
      await mkdir(join(sourcePath, ".codex-plugin"), { recursive: true });
      await writeFile(join(sourcePath, "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
      await writeFile(join(sourcePath, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
      await writeFile(join(sourcePath, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
      await writeFile(join(sourcePath, "plugin.yaml"), `name: ${name}\nversion: '1.0.0'\n`, "utf8");
    } else {
      await writeFile(join(sourcePath, type === "skills" ? "SKILL.md" : "AGENTS.md"), type === "skills" ? `---\nname: ${name}\ndescription: Fixture skill for tests.\n---\n\n# ${name}\n` : `# ${name}\n`, "utf8");
    }
  } else {
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, artifactContent(type, name), "utf8");
  }
  const hash = await hashPath(sourcePath);
  return {
    type,
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join(type, name),
    kind,
    hash,
    channel: "managed",
    meta: {
      logicalSelector: `${type}/${name}`,
      dependencyRole: "root",
      owners: ["compat-test"],
    },
  };
}

function artifactContent(type: ArtifactType, name: string): string {
  if (type === "rules" && name.endsWith(".rules")) {
    return [
      "prefix_rule(",
      "    pattern = [\"gh\", \"pr\", \"view\"],",
      "    decision = \"prompt\",",
      "    justification = \"Viewing PRs is allowed with approval\",",
      ")",
      "",
    ].join("\n");
  }
  if (type === "mcp") return `${JSON.stringify({ mcpServers: { demo: { command: "demo" } } }, null, 2)}\n`;
  if (type === "hooks" || type === "settings") return "{}\n";
  return `# ${name}\n`;
}

const pathCases: Array<{
  label: string;
  adapter: AdapterConfig;
  installationType: string;
  type: ArtifactType;
  name: string;
  kind?: FileKind;
  expectedRoot: "target" | "home";
  expectedPath: string;
}> = [
  { label: "codex local instructions", adapter: codexAdapter, installationType: "local", type: "instructions", name: "AGENTS.md", expectedRoot: "target", expectedPath: "AGENTS.md" },
  { label: "codex local skills", adapter: codexAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".agents/skills/smoke" },
  { label: "codex local plugins", adapter: codexAdapter, installationType: "local", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "target", expectedPath: "plugins/demo-plugin" },
  { label: "codex local subagents", adapter: codexAdapter, installationType: "local", type: "subagents", name: "reviewer", expectedRoot: "target", expectedPath: ".codex/agents/reviewer.toml" },
  { label: "codex local mcp", adapter: codexAdapter, installationType: "local", type: "mcp", name: "server.json", expectedRoot: "target", expectedPath: ".codex/config.toml" },
  { label: "codex local hooks", adapter: codexAdapter, installationType: "local", type: "hooks", name: "hooks.json", expectedRoot: "target", expectedPath: ".codex/hooks.json" },
  { label: "codex user instructions", adapter: codexAdapter, installationType: "user", type: "instructions", name: "AGENTS.md", expectedRoot: "home", expectedPath: ".codex/AGENTS.md" },
  { label: "codex user skills", adapter: codexAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".agents/skills/smoke" },
  { label: "codex user plugins", adapter: codexAdapter, installationType: "user", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "home", expectedPath: "plugins/demo-plugin" },
  { label: "codex user subagents", adapter: codexAdapter, installationType: "user", type: "subagents", name: "reviewer", expectedRoot: "home", expectedPath: ".codex/agents/reviewer.toml" },
  { label: "codex user mcp", adapter: codexAdapter, installationType: "user", type: "mcp", name: "server.json", expectedRoot: "home", expectedPath: ".codex/config.toml" },
  { label: "codex user hooks", adapter: codexAdapter, installationType: "user", type: "hooks", name: "hooks.json", expectedRoot: "home", expectedPath: ".codex/hooks.json" },

  { label: "claude local instructions", adapter: claudeAdapter, installationType: "local", type: "instructions", name: "CLAUDE.md", expectedRoot: "target", expectedPath: "CLAUDE.md" },
  { label: "claude local rules", adapter: claudeAdapter, installationType: "local", type: "rules", name: "testing.md", expectedRoot: "target", expectedPath: ".claude/rules/testing.md" },
  { label: "claude local skills", adapter: claudeAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".claude/skills/smoke" },
  { label: "claude local plugins", adapter: claudeAdapter, installationType: "local", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "target", expectedPath: "plugins/demo-plugin" },
  { label: "claude local commands", adapter: claudeAdapter, installationType: "local", type: "commands", name: "review.md", expectedRoot: "target", expectedPath: ".claude/commands/review.md" },
  { label: "claude local subagents", adapter: claudeAdapter, installationType: "local", type: "subagents", name: "reviewer", kind: "dir", expectedRoot: "target", expectedPath: ".claude/agents/reviewer" },
  { label: "claude local mcp", adapter: claudeAdapter, installationType: "local", type: "mcp", name: "server.json", expectedRoot: "target", expectedPath: ".mcp.json" },
  { label: "claude local settings", adapter: claudeAdapter, installationType: "local", type: "settings", name: "settings.json", expectedRoot: "target", expectedPath: ".claude/settings.json" },
  { label: "claude local hooks", adapter: claudeAdapter, installationType: "local", type: "hooks", name: "hooks.json", expectedRoot: "target", expectedPath: ".claude/settings.json" },
  { label: "claude user instructions", adapter: claudeAdapter, installationType: "user", type: "instructions", name: "CLAUDE.md", expectedRoot: "home", expectedPath: ".claude/CLAUDE.md" },
  { label: "claude user rules", adapter: claudeAdapter, installationType: "user", type: "rules", name: "testing.md", expectedRoot: "home", expectedPath: ".claude/rules/testing.md" },
  { label: "claude user skills", adapter: claudeAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".claude/skills/smoke" },
  { label: "claude user plugins", adapter: claudeAdapter, installationType: "user", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "home", expectedPath: "plugins/demo-plugin" },
  { label: "claude user commands", adapter: claudeAdapter, installationType: "user", type: "commands", name: "review.md", expectedRoot: "home", expectedPath: ".claude/commands/review.md" },
  { label: "claude user subagents", adapter: claudeAdapter, installationType: "user", type: "subagents", name: "reviewer", kind: "dir", expectedRoot: "home", expectedPath: ".claude/agents/reviewer" },
  { label: "claude user settings", adapter: claudeAdapter, installationType: "user", type: "settings", name: "settings.json", expectedRoot: "home", expectedPath: ".claude/settings.json" },
  { label: "claude user hooks", adapter: claudeAdapter, installationType: "user", type: "hooks", name: "hooks.json", expectedRoot: "home", expectedPath: ".claude/settings.json" },

  { label: "copilot local instructions", adapter: copilotAdapter, installationType: "local", type: "instructions", name: "copilot-instructions.md", expectedRoot: "target", expectedPath: ".github/copilot-instructions.md" },
  { label: "copilot local rules", adapter: copilotAdapter, installationType: "local", type: "rules", name: "typescript.instructions.md", expectedRoot: "target", expectedPath: ".github/instructions/typescript.instructions.md" },
  { label: "copilot local generic rule", adapter: copilotAdapter, installationType: "local", type: "rules", name: "typescript.md", expectedRoot: "target", expectedPath: ".github/instructions/typescript.instructions.md" },
  { label: "copilot local commands", adapter: copilotAdapter, installationType: "local", type: "commands", name: "review.prompt.md", expectedRoot: "target", expectedPath: ".github/prompts/review.prompt.md" },
  { label: "copilot local generic command", adapter: copilotAdapter, installationType: "local", type: "commands", name: "review.md", expectedRoot: "target", expectedPath: ".github/prompts/review.prompt.md" },
  { label: "copilot local skills", adapter: copilotAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".github/skills/smoke" },
  { label: "copilot local subagents", adapter: copilotAdapter, installationType: "local", type: "subagents", name: "reviewer.agent.md", expectedRoot: "target", expectedPath: ".github/agents/reviewer.agent.md" },
  { label: "copilot local generic subagent", adapter: copilotAdapter, installationType: "local", type: "subagents", name: "reviewer.md", expectedRoot: "target", expectedPath: ".github/agents/reviewer.agent.md" },
  { label: "copilot local mcp", adapter: copilotAdapter, installationType: "local", type: "mcp", name: "server.json", expectedRoot: "target", expectedPath: ".github/mcp.json" },
  { label: "copilot local hooks", adapter: copilotAdapter, installationType: "local", type: "hooks", name: "notify.json", expectedRoot: "target", expectedPath: ".github/hooks/notify.json" },
  { label: "copilot local settings", adapter: copilotAdapter, installationType: "local", type: "settings", name: "settings.json", expectedRoot: "target", expectedPath: ".github/settings.json" },
  { label: "copilot user instructions", adapter: copilotAdapter, installationType: "user", type: "instructions", name: "copilot-instructions.md", expectedRoot: "home", expectedPath: ".copilot/copilot-instructions.md" },
  { label: "copilot user rules", adapter: copilotAdapter, installationType: "user", type: "rules", name: "style.instructions.md", expectedRoot: "home", expectedPath: ".copilot/instructions/style.instructions.md" },
  { label: "copilot user skills", adapter: copilotAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".copilot/skills/smoke" },
  { label: "copilot user plugins", adapter: copilotAdapter, installationType: "user", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "home", expectedPath: "plugins/demo-plugin" },
  { label: "copilot user subagents", adapter: copilotAdapter, installationType: "user", type: "subagents", name: "reviewer.agent.md", expectedRoot: "home", expectedPath: ".copilot/agents/reviewer.agent.md" },
  { label: "copilot user mcp", adapter: copilotAdapter, installationType: "user", type: "mcp", name: "server.json", expectedRoot: "home", expectedPath: ".copilot/mcp-config.json" },
  { label: "copilot user hooks", adapter: copilotAdapter, installationType: "user", type: "hooks", name: "notify.json", expectedRoot: "home", expectedPath: ".copilot/hooks/notify.json" },
  { label: "copilot user settings", adapter: copilotAdapter, installationType: "user", type: "settings", name: "settings.json", expectedRoot: "home", expectedPath: ".copilot/settings.json" },

  { label: "openclaw local skills", adapter: openClawAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: "skills/smoke" },
  { label: "openclaw user instructions", adapter: openClawAdapter, installationType: "user", type: "instructions", name: "AGENTS.md", expectedRoot: "home", expectedPath: ".openclaw/workspace/AGENTS.md" },
  { label: "openclaw user skills", adapter: openClawAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".openclaw/skills/smoke" },
  { label: "openclaw user subagents", adapter: openClawAdapter, installationType: "user", type: "subagents", name: "reviewer", kind: "dir", expectedRoot: "home", expectedPath: ".openclaw/workspace-subagents/reviewer" },
  { label: "openclaw user mcp", adapter: openClawAdapter, installationType: "user", type: "mcp", name: "server.json", expectedRoot: "home", expectedPath: ".openclaw/openclaw.json" },
  { label: "openclaw user settings", adapter: openClawAdapter, installationType: "user", type: "settings", name: "settings.json", expectedRoot: "home", expectedPath: ".openclaw/openclaw.json" },

  { label: "hermes local instructions", adapter: hermesAdapter, installationType: "local", type: "instructions", name: "AGENTS.md", expectedRoot: "target", expectedPath: "AGENTS.md" },
  { label: "hermes user instructions", adapter: hermesAdapter, installationType: "user", type: "instructions", name: "SOUL.md", expectedRoot: "home", expectedPath: ".hermes/SOUL.md" },
  { label: "hermes user skills", adapter: hermesAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".hermes/skills/smoke" },
  { label: "hermes user plugins", adapter: hermesAdapter, installationType: "user", type: "plugins", name: "demo-plugin", kind: "dir", expectedRoot: "home", expectedPath: "plugins/demo-plugin" },
  { label: "hermes user mcp", adapter: hermesAdapter, installationType: "user", type: "mcp", name: "servers.yaml", expectedRoot: "home", expectedPath: ".hermes/config.yaml" },
  { label: "hermes user settings", adapter: hermesAdapter, installationType: "user", type: "settings", name: "settings.yaml", expectedRoot: "home", expectedPath: ".hermes/config.yaml" },
];

describe("artifact compatibility registry", () => {
  it.each(pathCases)("resolves supported-native path: $label", async (item) => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-compat-home-");
    process.env.AGENTWHEEL_TEST_HOME = home;
    const artifact = await desiredArtifact(source, item.type, item.name, item.kind);

    const plan = await createCombinedInstallPlan([artifact], item.adapter, target, undefined, localTransport, {
      installationType: item.installationType,
    });

    expect(plan.installationType).toBe(item.installationType);
    expect(plan.targetRoot).toBe(item.expectedRoot === "home" ? home : target);
    expect(plan.operations.map((operation) => operation.relativeDestPath)).toEqual([item.expectedPath]);
  });

  it("plans built-in plugin installs as semantic operations rather than inert directory copies", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-compat-home-");
    process.env.AGENTWHEEL_TEST_HOME = home;
    const plugin = await desiredArtifact(source, "plugins", "demo-plugin", "dir");
    const cases = [
      {
        adapter: claudeAdapter,
        installationType: "local",
        inertPaths: [join(target, ".claude", "plugins", "demo-plugin")],
      },
      {
        adapter: codexAdapter,
        installationType: "local",
        inertPaths: [join(target, "plugins", "demo-plugin")],
      },
      {
        adapter: copilotAdapter,
        installationType: "user",
        inertPaths: [
          join(target, ".github", "plugins", "demo-plugin"),
          join(home, ".copilot", "plugins", "demo-plugin"),
        ],
      },
      {
        adapter: hermesAdapter,
        installationType: "user",
        inertPaths: [join(home, ".hermes", "plugins", "demo-plugin")],
      },
    ];

    for (const item of cases) {
      const plan = await createCombinedInstallPlan([plugin], item.adapter, target, undefined, localTransport, {
        installationType: item.installationType,
      });
      expect(plan.operations).toHaveLength(1);
      const operation = plan.operations[0]!;
      expect(operation.action).toBe("plugin");
      expect(operation.semanticPlugin?.runtime).toBe(item.adapter.name);
      for (const inertPath of item.inertPaths) {
        expect(operation.destPath).not.toBe(inertPath);
      }
      expect(["create", "update"]).not.toContain(operation.action);
    }
  });

  it("rejects known undocumented or wrong mappings", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const codexSkill = await desiredArtifact(source, "skills", "smoke", "dir");
    const codexSkillPlan = await createCombinedInstallPlan([codexSkill], codexAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(codexSkillPlan.operations[0]?.relativeDestPath).toBe(".agents/skills/smoke");
    expect(codexSkillPlan.operations[0]?.relativeDestPath).not.toBe(".codex/skills/smoke");

    const codexSubagent = await desiredArtifact(source, "subagents", "reviewer", "dir");
    const codexSubagentPlan = await createCombinedInstallPlan([codexSubagent], codexAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(codexSubagentPlan.operations[0]?.relativeDestPath).toBe(".codex/agents/reviewer.toml");
    expect(codexSubagentPlan.operations[0]?.relativeDestPath).not.toBe(".codex/agents/reviewer/AGENTS.md");

    const command = await desiredArtifact(source, "commands", "review.md");
    await expect(createCombinedInstallPlan([command], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support commands artifacts/);

    const codexRule = await desiredArtifact(source, "rules", "policy.rules");
    await expect(createCombinedInstallPlan([codexRule], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support rules artifacts/);

    const claudeMcp = await desiredArtifact(source, "mcp", "server.json");
    const claudeMcpPlan = await createCombinedInstallPlan([claudeMcp], claudeAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(claudeMcpPlan.operations[0]?.relativeDestPath).toBe(".mcp.json");
    expect(claudeMcpPlan.operations[0]?.relativeDestPath).not.toBe(".claude/.mcp.json");

    const copilotMcp = await desiredArtifact(source, "mcp", "server.json");
    const copilotMcpPlan = await createCombinedInstallPlan([copilotMcp], copilotAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(copilotMcpPlan.operations[0]?.relativeDestPath).toBe(".github/mcp.json");
    expect(copilotMcpPlan.operations[0]?.relativeDestPath).not.toBe(".vscode/mcp.json");

    const hermesLocalSkill = await desiredArtifact(source, "skills", "local-only", "dir");
    await expect(createCombinedInstallPlan([hermesLocalSkill], hermesAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support skills artifacts for installation type 'local'/);

    const claudeUserMcp = await desiredArtifact(source, "mcp", "server.json");
    await expect(createCombinedInstallPlan([claudeUserMcp], claudeAdapter, target, undefined, localTransport, { installationType: "user" }))
      .rejects.toThrow(/does not support mcp artifacts for installation type 'user'/);

    const copilotUserCommand = await desiredArtifact(source, "commands", "review.md");
    await expect(createCombinedInstallPlan([copilotUserCommand], copilotAdapter, target, undefined, localTransport, { installationType: "user" }))
      .rejects.toThrow(/does not support commands artifacts for installation type 'user'/);

    const copilotLocalPlugin = await desiredArtifact(source, "plugins", "demo-plugin", "dir");
    await expect(createCombinedInstallPlan([copilotLocalPlugin], copilotAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support plugins artifacts for installation type 'local'/);

    const openClawRule = await desiredArtifact(source, "rules", "policy.md");
    await expect(createCombinedInstallPlan([openClawRule], openClawAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support rules artifacts/);

    const openClawLocalInstructions = await desiredArtifact(source, "instructions", "AGENTS.md");
    await expect(createCombinedInstallPlan([openClawLocalInstructions], openClawAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support instructions artifacts for installation type 'local'/);

    const hermesLocalMcp = await desiredArtifact(source, "mcp", "server.json");
    await expect(createCombinedInstallPlan([hermesLocalMcp], hermesAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support mcp artifacts for installation type 'local'/);

    const codexSettings = await desiredArtifact(source, "settings", "settings.json");
    await expect(createCombinedInstallPlan([codexSettings], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support settings artifacts/);
  });

  it("rejects artifacts whose format or structure does not match the target runtime", async () => {
    const source = await tempRoot();
    const target = await tempRoot();

    const markdownRule = await desiredArtifact(source, "rules", "policy.md");
    await expect(createCombinedInstallPlan([markdownRule], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support rules artifacts/);

    const codexSkill = await desiredArtifact(source, "skills", "codex-skill", "dir");
    const skippedCodexRule = await desiredArtifact(source, "rules", "policy.rules");
    const warnings: string[] = [];
    const codexPlan = await createCombinedInstallPlan([codexSkill, skippedCodexRule], codexAdapter, target, undefined, localTransport, {
      installationType: "local",
      warn: (message) => warnings.push(message),
    });
    expect(codexPlan.operations.map((operation) => operation.relativeDestPath)).toEqual([".agents/skills/codex-skill"]);
    expect(warnings.join("\n")).toMatch(/skip rules\/policy\.rules .*target does not support behavioral Markdown rules/);

    const codexRule = await desiredArtifact(source, "rules", "policy.rules");
    await expect(createCombinedInstallPlan([codexRule], claudeAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/format 'codex-command-policy' is not compatible.*markdown-rule/s);

    const pluginDir = await desiredArtifact(source, "plugins", "bad-plugin", "dir");
    await rm(join(pluginDir.sourcePath, "plugin.json"));
    await expect(createCombinedInstallPlan([
      { ...pluginDir, hash: await hashPath(pluginDir.sourcePath) },
    ], openClawAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/OpenClaw plugins must contain plugin\.json or openclaw\.plugin\.json/);

    const openClawDescriptorPlugin = await desiredArtifact(source, "plugins", "openclaw-plugin", "dir");
    await writeFile(join(openClawDescriptorPlugin.sourcePath, "openclaw.plugin.json"), JSON.stringify({ name: "openclaw-plugin" }, null, 2), "utf8");
    const openClawDescriptorPlan = await createCombinedInstallPlan([
      { ...openClawDescriptorPlugin, hash: await hashPath(openClawDescriptorPlugin.sourcePath) },
    ], openClawAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(openClawDescriptorPlan.operations[0]?.action).toBe("plugin");

    const mismatchedPlugin = await desiredArtifact(source, "plugins", "mismatched-plugin", "dir");
    await writeFile(join(mismatchedPlugin.sourcePath, "plugin.json"), JSON.stringify({ name: "first" }, null, 2), "utf8");
    await writeFile(join(mismatchedPlugin.sourcePath, "openclaw.plugin.json"), JSON.stringify({ name: "second" }, null, 2), "utf8");
    await expect(createCombinedInstallPlan([
      { ...mismatchedPlugin, hash: await hashPath(mismatchedPlugin.sourcePath) },
    ], openClawAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/OpenClaw plugin descriptors must declare the same name/);

    const invalidMcp = await desiredArtifact(source, "mcp", "empty.json");
    await writeFile(invalidMcp.sourcePath, "{}\n", "utf8");
    await expect(createCombinedInstallPlan([{ ...invalidMcp, hash: await hashPath(invalidMcp.sourcePath) }], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/Codex MCP artifact must contain at least one server object/);

    const missingSkill = await desiredArtifact(source, "skills", "missing-skill", "dir");
    await rm(join(missingSkill.sourcePath, "SKILL.md"));
    await expect(createCombinedInstallPlan([{ ...missingSkill, hash: await hashPath(missingSkill.sourcePath) }], claudeAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/skill directory must contain SKILL\.md/);
  });

  it("honors custom adapter config installation types and artifact capabilities", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const adapter: AdapterConfig = {
      name: "custom-profile",
      targets: {
        rules: {
          "profile-main": { enabled: true, dest: ".profile/rules" },
        },
        skills: {
          "profile-main": { enabled: true, dest: ".profile/skills" },
        },
      },
    };
    const rule = await desiredArtifact(source, "rules", "behavior.md");
    const skill = await desiredArtifact(source, "skills", "profile-skill", "dir");

    const plan = await createCombinedInstallPlan([rule, skill], adapter, target, undefined, localTransport, {
      installationType: "profile-main",
    });

    expect(plan.operations.map((operation) => operation.relativeDestPath).sort()).toEqual([
      ".profile/rules/behavior.md",
      ".profile/skills/profile-skill",
    ]);
  });

  it("installs smoke skills end-to-end into separate local and user state", async () => {
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-compat-home-");
    process.env.AGENTWHEEL_TEST_HOME = home;
    const localBundle = await stageSource(new LocalSourceDriver(), smokeSource);
    const userBundle = await stageSource(new LocalSourceDriver(), smokeSource);

    const localPlan = await createInstallPlan(localBundle, codexAdapter, target, undefined, localTransport, { installationType: "local" });
    const userPlan = await createInstallPlan(userBundle, codexAdapter, target, undefined, localTransport, { installationType: "user" });
    await applyCombinedInstallPlan(localPlan);
    await applyCombinedInstallPlan(userPlan);

    await expect(stat(join(target, ".agents", "skills", "agentwheel-smoke-skill", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(home, ".agents", "skills", "agentwheel-smoke-skill", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(installManifestPath(target, codexAdapter.name, { installationType: "local" }))).resolves.toBeTruthy();
    await expect(stat(installManifestPath(home, codexAdapter.name, { installationType: "user" }))).resolves.toBeTruthy();
    expect((await readInstallManifest(target, codexAdapter.name, localTransport, { installationType: "local" }))?.entries[0]?.path)
      .toBe(".agents/skills/agentwheel-smoke-skill");
    expect((await readInstallManifest(home, codexAdapter.name, localTransport, { installationType: "user" }))?.entries[0]?.path)
      .toBe(".agents/skills/agentwheel-smoke-skill");

    await rm(localBundle.root, { recursive: true, force: true });
    await rm(userBundle.root, { recursive: true, force: true });
  });

  it("installs Codex subagents from TOML, Markdown, and AGENTS.md directory sources", async () => {
    const cases = [
      {
        name: "toml-reviewer",
        async write(root: string) {
          await writeSubagentPackage(root, "toml-reviewer.toml", [
            'name = "toml-reviewer"',
            'description = "TOML reviewer."',
            'developer_instructions = """',
            "Review from TOML.",
            '"""',
            "",
          ].join("\n"));
        },
        expected: ['name = "toml-reviewer"', "Review from TOML."],
      },
      {
        name: "markdown-reviewer",
        async write(root: string) {
          await writeSubagentPackage(root, "markdown-reviewer.md", [
            "---",
            "description: Markdown reviewer.",
            "model: gpt-5.6-sol",
            "model_reasoning_effort: high",
            "---",
            "# Markdown reviewer",
            "",
            "Review from Markdown.",
            "",
          ].join("\n"));
        },
        expected: [
          'name = "markdown-reviewer"',
          'description = "Markdown reviewer."',
          'model = "gpt-5.6-sol"',
          'model_reasoning_effort = "high"',
          "Review from Markdown.",
        ],
      },
      {
        name: "directory-reviewer",
        async write(root: string) {
          await writeSubagentPackage(root, join("directory-reviewer", "AGENTS.md"), [
            "# Directory reviewer",
            "",
            "Review from AGENTS.md.",
            "",
          ].join("\n"));
        },
        expected: ['name = "directory-reviewer"', 'description = "Directory reviewer"', "Review from AGENTS.md."],
      },
    ];

    for (const item of cases) {
      const source = await tempRoot();
      const target = await tempRoot();
      await item.write(source);
      const bundle = await stageSource(new LocalSourceDriver(), source, {
        adapter: codexAdapter,
        select: [`subagents/${item.name}`],
      });
      const plan = await createInstallPlan(bundle, codexAdapter, target, undefined, localTransport, { installationType: "local" });
      await applyCombinedInstallPlan(plan);

      const installed = await readFile(join(target, ".codex", "agents", `${item.name}.toml`), "utf8");
      for (const expected of item.expected) expect(installed).toContain(expected);
      await expect(stat(join(target, ".codex", "agents", item.name, "AGENTS.md"))).rejects.toThrow();
      await rm(bundle.root, { recursive: true, force: true });
    }
  });

  it("keeps role subagent nesting guards compatible across native runtimes", async () => {
    const source = await tempRoot();
    await writeSubagentPackage(source, join("guarded-role", "AGENTS.md"), [
      "---",
      "name: guarded-role",
      'description: "Guarded role."',
      "disallowedTools: Agent, Task, Skill, mcp__ccd_session__spawn_task, SendMessage",
      "agents: []",
      "---",
      "",
      "# Guarded Role",
      "",
      "Do not start, resume, spawn, message, or orchestrate other agents through native subagents, task tools, skill-driven bridges, agent-tmux, tmux/agent-mesh, OpenClaw `sessions_spawn`, CCD session tools, `SendMessage`, or deferred MCP messaging.",
      "",
      "Work as a leaf role agent and return a concise handoff.",
      "",
    ].join("\n"));

    const codexTarget = await tempRoot();
    const codexBundle = await stageSource(new LocalSourceDriver(), source, {
      adapter: codexAdapter,
      select: ["subagents/guarded-role"],
    });
    const codexPlan = await createInstallPlan(codexBundle, codexAdapter, codexTarget, undefined, localTransport, { installationType: "local" });
    await applyCombinedInstallPlan(codexPlan);
    const codexAgent = await readFile(join(codexTarget, ".codex", "agents", "guarded-role.toml"), "utf8");
    expect(codexAgent).toContain('name = "guarded-role"');
    expect(codexAgent).toContain('description = "Guarded role."');
    expect(codexAgent).toContain("Work as a leaf role agent");
    expect(codexAgent).toContain("Do not start, resume, spawn, message");
    expect(codexAgent).not.toContain("disallowedTools");
    expect(codexAgent).not.toContain("mcp__ccd_session__spawn_task");
    expect(codexAgent).not.toContain("agents: []");

    const claudeTarget = await tempRoot();
    const claudeBundle = await stageSource(new LocalSourceDriver(), source, {
      adapter: claudeAdapter,
      select: ["subagents/guarded-role"],
    });
    const claudePlan = await createInstallPlan(claudeBundle, claudeAdapter, claudeTarget, undefined, localTransport, { installationType: "local" });
    await applyCombinedInstallPlan(claudePlan);
    const claudeAgent = await readFile(join(claudeTarget, ".claude", "agents", "guarded-role.md"), "utf8");
    expect(claudeAgent).toContain("name: guarded-role");
    expect(claudeAgent).toContain("disallowedTools: Agent, Task, Skill, mcp__ccd_session__spawn_task, SendMessage");
    expect(claudeAgent).toContain("Do not start, resume, spawn, message");

    const copilotTarget = await tempRoot();
    const copilotBundle = await stageSource(new LocalSourceDriver(), source, {
      adapter: copilotAdapter,
      select: ["subagents/guarded-role"],
    });
    const copilotPlan = await createInstallPlan(copilotBundle, copilotAdapter, copilotTarget, undefined, localTransport, { installationType: "local" });
    await applyCombinedInstallPlan(copilotPlan);
    const copilotAgent = await readFile(join(copilotTarget, ".github", "agents", "guarded-role.agent.md"), "utf8");
    expect(copilotAgent).toContain("name: guarded-role");
    expect(copilotAgent).toContain("disallowedTools: Agent, Task, Skill, mcp__ccd_session__spawn_task, SendMessage");
    expect(copilotAgent).toContain("agents: []");

    const openClawHome = await tempRoot("agentwheel-openclaw-compat-home-");
    process.env.AGENTWHEEL_TEST_HOME = openClawHome;
    const openClawBundle = await stageSource(new LocalSourceDriver(), source, {
      adapter: openClawAdapter,
      select: ["subagents/guarded-role"],
    });
    const openClawPlan = await createInstallPlan(openClawBundle, openClawAdapter, await tempRoot(), undefined, localTransport, { installationType: "user" });
    await applyCombinedInstallPlan(openClawPlan);
    const openClawAgent = await readFile(join(openClawHome, ".openclaw", "workspace-subagents", "guarded-role", "AGENTS.md"), "utf8");
    expect(openClawAgent).toContain("# Guarded Role");
    expect(openClawAgent).toContain("Do not start, resume, spawn, message");
    expect(openClawAgent).toContain("Work as a leaf role agent");
    expect(openClawAgent).not.toContain("disallowedTools");
    expect(openClawAgent).not.toContain("agents: []");

    await rm(codexBundle.root, { recursive: true, force: true });
    await rm(claudeBundle.root, { recursive: true, force: true });
    await rm(copilotBundle.root, { recursive: true, force: true });
    await rm(openClawBundle.root, { recursive: true, force: true });
  });

  it("rejects Codex custom agent TOML missing required fields before apply", async () => {
    const source = await tempRoot();
    await writeSubagentPackage(source, "broken.toml", [
      'name = "broken"',
      'description = "Missing developer instructions."',
      "",
    ].join("\n"));

    await expect(stageSource(new LocalSourceDriver(), source, { adapter: codexAdapter }))
      .rejects.toThrow(/missing required field 'developer_instructions'/);
  });
});

async function writeSubagentPackage(root: string, relativeSubagentPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, "subagents", relativeSubagentPath)), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: `compat/${relativeSubagentPath.replace(/[^a-z0-9]+/gi, "-")}`,
    version: "1.0.0",
    provides: [{ type: "subagents", path: "subagents" }],
  }, null, 2), "utf8");
  await writeFile(join(root, "subagents", relativeSubagentPath), content, "utf8");
}
