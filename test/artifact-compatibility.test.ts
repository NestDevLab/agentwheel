import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    await writeFile(join(sourcePath, type === "skills" ? "SKILL.md" : "AGENTS.md"), `# ${name}\n`, "utf8");
  } else {
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, type === "mcp" || type === "hooks" || type === "settings" ? "{}\n" : `# ${name}\n`, "utf8");
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
  { label: "codex local rules", adapter: codexAdapter, installationType: "local", type: "rules", name: "default.rules", expectedRoot: "target", expectedPath: ".codex/rules/default.rules" },
  { label: "codex local skills", adapter: codexAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".agents/skills/smoke" },
  { label: "codex local mcp", adapter: codexAdapter, installationType: "local", type: "mcp", name: "server.json", expectedRoot: "target", expectedPath: ".codex/config.toml" },
  { label: "codex local hooks", adapter: codexAdapter, installationType: "local", type: "hooks", name: "hooks.json", expectedRoot: "target", expectedPath: ".codex/hooks.json" },
  { label: "codex user skills", adapter: codexAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".agents/skills/smoke" },

  { label: "claude local instructions", adapter: claudeAdapter, installationType: "local", type: "instructions", name: "CLAUDE.md", expectedRoot: "target", expectedPath: "CLAUDE.md" },
  { label: "claude local rules", adapter: claudeAdapter, installationType: "local", type: "rules", name: "testing.md", expectedRoot: "target", expectedPath: ".claude/rules/testing.md" },
  { label: "claude local skills", adapter: claudeAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".claude/skills/smoke" },
  { label: "claude local commands", adapter: claudeAdapter, installationType: "local", type: "commands", name: "review.md", expectedRoot: "target", expectedPath: ".claude/commands/review.md" },
  { label: "claude local subagents", adapter: claudeAdapter, installationType: "local", type: "subagents", name: "reviewer", kind: "dir", expectedRoot: "target", expectedPath: ".claude/agents/reviewer" },
  { label: "claude local mcp", adapter: claudeAdapter, installationType: "local", type: "mcp", name: "server.json", expectedRoot: "target", expectedPath: ".mcp.json" },
  { label: "claude local settings", adapter: claudeAdapter, installationType: "local", type: "settings", name: "settings.json", expectedRoot: "target", expectedPath: ".claude/settings.json" },
  { label: "claude user skills", adapter: claudeAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".claude/skills/smoke" },

  { label: "copilot local instructions", adapter: copilotAdapter, installationType: "local", type: "instructions", name: "copilot-instructions.md", expectedRoot: "target", expectedPath: ".github/copilot-instructions.md" },
  { label: "copilot local rules", adapter: copilotAdapter, installationType: "local", type: "rules", name: "typescript.instructions.md", expectedRoot: "target", expectedPath: ".github/instructions/typescript.instructions.md" },
  { label: "copilot local commands", adapter: copilotAdapter, installationType: "local", type: "commands", name: "review.prompt.md", expectedRoot: "target", expectedPath: ".github/prompts/review.prompt.md" },
  { label: "copilot local skills", adapter: copilotAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: ".github/skills/smoke" },
  { label: "copilot local subagents", adapter: copilotAdapter, installationType: "local", type: "subagents", name: "reviewer.agent.md", expectedRoot: "target", expectedPath: ".github/agents/reviewer.agent.md" },
  { label: "copilot user skills", adapter: copilotAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".copilot/skills/smoke" },

  { label: "openclaw local skills", adapter: openClawAdapter, installationType: "local", type: "skills", name: "smoke", kind: "dir", expectedRoot: "target", expectedPath: "skills/smoke" },
  { label: "openclaw user skills", adapter: openClawAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".openclaw/skills/smoke" },
  { label: "hermes user skills", adapter: hermesAdapter, installationType: "user", type: "skills", name: "smoke", kind: "dir", expectedRoot: "home", expectedPath: ".hermes/skills/smoke" },
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

  it("rejects known undocumented or wrong mappings", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const codexSkill = await desiredArtifact(source, "skills", "smoke", "dir");
    const codexSkillPlan = await createCombinedInstallPlan([codexSkill], codexAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(codexSkillPlan.operations[0]?.relativeDestPath).toBe(".agents/skills/smoke");
    expect(codexSkillPlan.operations[0]?.relativeDestPath).not.toBe(".codex/skills/smoke");

    const command = await desiredArtifact(source, "commands", "review.md");
    await expect(createCombinedInstallPlan([command], codexAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support commands artifacts/);

    const claudeMcp = await desiredArtifact(source, "mcp", "server.json");
    const claudeMcpPlan = await createCombinedInstallPlan([claudeMcp], claudeAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(claudeMcpPlan.operations[0]?.relativeDestPath).toBe(".mcp.json");
    expect(claudeMcpPlan.operations[0]?.relativeDestPath).not.toBe(".claude/.mcp.json");

    const hermesLocalSkill = await desiredArtifact(source, "skills", "local-only", "dir");
    await expect(createCombinedInstallPlan([hermesLocalSkill], hermesAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/does not support skills artifacts for installation type 'local'/);
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
});
