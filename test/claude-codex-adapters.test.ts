import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";
import { localTransport } from "../src/transport/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-claude-codex-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "subagents", "reviewer"), { recursive: true });
  await mkdir(join(root, "mcp"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "shared", "bin"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "adapter-package",
    version: "1.0.0",
    provides: [
      { type: "instructions", path: "instructions/AGENTS.md" },
      { type: "rules", path: "rules" },
      {
        type: "skills",
        path: "skills",
        assets: [{ from: "shared/bin", into: "bin", include: ["*.sh"], mode: "preserve" }],
      },
      { type: "commands", path: "commands" },
      { type: "subagents", path: "subagents" },
      { type: "mcp", path: "mcp" },
      { type: "hooks", path: "hooks" },
    ],
  }, null, 2), "utf8");
  await writeFile(join(root, "instructions", "AGENTS.md"), "# Instructions\n", "utf8");
  await writeFile(join(root, "rules", "safe.md"), "# Safe\n", "utf8");
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Fixture skill for tests.\n---\n\n# Demo\n", "utf8");
  await writeFile(join(root, "commands", "review.md"), "# Review\n", "utf8");
  await writeFile(join(root, "subagents", "reviewer", "AGENTS.md"), "# Reviewer\n", "utf8");
  await writeFile(join(root, "mcp", "managed.json"), JSON.stringify({
    mcpServers: { managed: { command: "managed", args: ["--ok"], env: { TOKEN: "public-token" } } },
  }, null, 2), "utf8");
  await writeFile(join(root, "hooks", "events.json"), JSON.stringify({
    hooks: { managed: [{ matcher: ".*", hooks: [{ type: "command", command: "echo managed" }] }] },
  }, null, 2), "utf8");
  await writeFile(join(root, "shared", "bin", "tool.sh"), "#!/bin/sh\necho ok\n", "utf8");
  await chmod(join(root, "shared", "bin", "tool.sh"), 0o755);
}

describe("Claude and Codex adapters", () => {
  it("installs Claude Code artifacts and deep-merges MCP/hooks files", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);
    await mkdir(join(target, ".claude"), { recursive: true });
    await writeFile(join(target, ".mcp.json"), JSON.stringify({
      mcpServers: { user: { command: "user" } },
      keep: true,
    }, null, 2), "utf8");
    await writeFile(join(target, ".claude", "settings.json"), JSON.stringify({
      hooks: { user: [{ matcher: "UserPromptSubmit", hooks: [{ type: "command", command: "echo user" }] }] },
      userOnly: true,
    }, null, 2), "utf8");

    const bundle = await stageSource(new LocalSourceDriver(), source);
    const plan = await createInstallPlan(bundle, claudeAdapter, target);
    await applyInstallPlan(plan, bundle.sourceLock);

    await expect(stat(join(target, "CLAUDE.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".claude", "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".claude", "skills", "demo", "bin", "tool.sh"))).resolves.toBeTruthy();
    expect((await stat(join(target, ".claude", "skills", "demo", "bin", "tool.sh"))).mode & 0o111).toBeTruthy();
    await expect(stat(join(target, ".claude", "commands", "review.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".claude", "agents", "reviewer", "AGENTS.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".claude", "rules", "safe.md"))).resolves.toBeTruthy();

    const mcp = JSON.parse(await readFile(join(target, ".mcp.json"), "utf8"));
    expect(mcp.keep).toBe(true);
    expect(mcp.mcpServers.user.command).toBe("user");
    expect(mcp.mcpServers.managed.command).toBe("managed");
    const settings = JSON.parse(await readFile(join(target, ".claude", "settings.json"), "utf8"));
    expect(settings.userOnly).toBe(true);
    expect(settings.hooks.user[0].hooks[0].command).toBe("echo user");
    expect(settings.hooks.managed[0].hooks[0].command).toBe("echo managed");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("installs Codex artifacts and merges MCP into config.toml without deleting user config", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);
    await writeFile(join(source, "rules", "safe.rules"), [
      "prefix_rule(",
      "    pattern = [\"gh\", \"pr\", \"view\"],",
      "    decision = \"prompt\",",
      "    justification = \"Viewing PRs is allowed with approval\",",
      ")",
      "",
    ].join("\n"), "utf8");
    await mkdir(join(target, ".codex"), { recursive: true });
    await writeFile(join(target, ".codex", "config.toml"), [
      "model = \"gpt-5.1-codex\"",
      "",
      "[mcp_servers.user]",
      "command = \"user\"",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(target, ".codex", "hooks.json"), JSON.stringify({
      hooks: { user: [{ command: "echo user" }] },
      keep: true,
    }, null, 2), "utf8");

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: ["instructions/AGENTS.md", "rules/safe.rules", "skills/demo", "mcp/managed.json", "hooks/events.json"],
    });
    const plan = await createInstallPlan(bundle, codexAdapter, target, undefined, localTransport, { installationType: "local" });
    await applyInstallPlan(plan, bundle.sourceLock);

    await expect(stat(join(target, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".agents", "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".agents", "skills", "demo", "bin", "tool.sh"))).resolves.toBeTruthy();
    expect((await stat(join(target, ".agents", "skills", "demo", "bin", "tool.sh"))).mode & 0o111).toBeTruthy();
    await expect(stat(join(target, ".codex", "commands", "review.md"))).rejects.toThrow();
    await expect(stat(join(target, ".codex", "agents", "reviewer", "AGENTS.md"))).rejects.toThrow();
    await expect(stat(join(target, ".codex", "rules", "safe.rules"))).resolves.toBeTruthy();

    const config = await readFile(join(target, ".codex", "config.toml"), "utf8");
    expect(config).toContain("model = \"gpt-5.1-codex\"");
    expect(config).toContain("[mcp_servers.user]");
    expect(config).toContain("command = \"user\"");
    expect(config).toContain("[mcp_servers.managed]");
    expect(config).toContain("command = \"managed\"");
    expect(config).toContain("args = [\"--ok\"]");
    expect(config).toContain("[mcp_servers.managed.env]");
    const hooks = JSON.parse(await readFile(join(target, ".codex", "hooks.json"), "utf8"));
    expect(hooks.keep).toBe(true);
    expect(hooks.hooks.user[0].command).toBe("echo user");
    expect(hooks.hooks.managed[0].hooks[0].command).toBe("echo managed");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("plans selected mesh skills into Claude and Codex skill directories", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);

    const claudeBundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/demo"] });
    const claudePlan = await createInstallPlan(claudeBundle, claudeAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(claudePlan.operations.map((operation) => operation.relativeDestPath)).toEqual([".claude/skills/demo"]);
    await rm(claudeBundle.root, { recursive: true, force: true });

    const codexBundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/demo"] });
    const codexPlan = await createInstallPlan(codexBundle, codexAdapter, target, undefined, localTransport, { installationType: "local" });
    expect(codexPlan.operations.map((operation) => operation.relativeDestPath)).toEqual([".agents/skills/demo"]);
    await rm(codexBundle.root, { recursive: true, force: true });
  });
});
