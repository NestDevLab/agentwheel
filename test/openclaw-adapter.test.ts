import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../src/install/index.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-openclaw-adapter-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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

async function writePackage(root: string, provides: Array<{ type: string; path: string }>): Promise<void> {
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "openclaw-adapter-fixture",
    version: "1.0.0",
    provides,
  }, null, 2), "utf8");
}

describe("OpenClaw adapter", () => {
  it("declares user-level config and subagent workspace targets", () => {
    expect(openClawAdapter.targets.instructions).toEqual({
      user: { enabled: true, root: "home", dest: ".openclaw/workspace/AGENTS.md", mode: "managed-block" },
    });
    expect(openClawAdapter.targets.subagents).toEqual({
      user: { enabled: true, root: "home", dest: ".openclaw/workspace-subagents", semantic: "openclaw-subagent" },
    });
    expect(openClawAdapter.targets.mcp).toEqual({
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "openclaw-json-deep" },
    });
    expect(openClawAdapter.targets.settings).toEqual({
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "openclaw-json-deep" },
    });
    expect(openClawAdapter.targets.instructions?.local).toBeUndefined();
  });

  it("installs user instructions to the OpenClaw workspace AGENTS file", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-openclaw-home-");
    await mkdir(join(source, "instructions"), { recursive: true });
    await writePackage(source, [{ type: "instructions", path: "instructions/AGENTS.md" }]);
    await writeFile(join(source, "instructions", "AGENTS.md"), "# OpenClaw user instructions\n", "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source);
      const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, undefined, { installationType: "user" });
      expect(plan.targetRoot).toBe(home);
      expect(plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/workspace/AGENTS.md"]);
      expect(plan.operations[0]?.destPath).toBe(join(home, ".openclaw", "workspace", "AGENTS.md"));

      await applyInstallPlan(plan, bundle.sourceLock);
      await expect(stat(join(home, ".openclaw", "workspace", "AGENTS.md"))).resolves.toBeTruthy();
      await expect(stat(join(target, ".openclaw", "workspace", "AGENTS.md"))).rejects.toThrow();
      await rm(bundle.root, { recursive: true, force: true });
    });
  });

  it("deep-merges OpenClaw MCP payloads into the user openclaw.json", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-openclaw-home-");
    await mkdir(join(source, "mcp"), { recursive: true });
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await writeFakeOpenClaw(home);
    await writePackage(source, [{ type: "mcp", path: "mcp/server.json" }]);
    await writeFile(join(source, "mcp", "server.json"), JSON.stringify({
      mcp: { servers: { managed: { command: "managed", args: ["--ok"] }, user: { headers: { Authorization: "Bearer ${MISSING_TEST_TOKEN}" } } } },
    }, null, 2), "utf8");
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify({
      mcp: { servers: { user: { command: "user", headers: { Authorization: "Bearer existing" } } } },
      keep: true,
    }, null, 2), "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source);
      const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, undefined, { installationType: "user" });
      const operation = plan.operations.find((candidate) => candidate.artifactType === "mcp");
      expect(operation?.action).toBe("update");
      expect(operation?.relativeDestPath).toBe(".openclaw/openclaw.json");
      expect(operation?.destPath).toBe(join(home, ".openclaw", "openclaw.json"));
      expect(operation?.mergeStrategy).toBe("openclaw-json-deep");

      await applyInstallPlan(plan, bundle.sourceLock);
      const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
      expect(config.keep).toBe(true);
      expect(config.mcp.servers.user.command).toBe("user");
      expect(config.mcp.servers.user.headers.Authorization).toBe("Bearer existing");
      expect(config.mcp.servers.managed.command).toBe("managed");
      const manifest = await readInstallManifest(home, "openclaw", undefined, { installationType: "user" });
      expect(manifest?.entries.find((entry) => entry.artifactType === "mcp")?.mergeStrategy).toBe("openclaw-json-deep");
      await rm(bundle.root, { recursive: true, force: true });
    });
  });

  it("deep-merges OpenClaw settings, including agents.list, into the user openclaw.json", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-openclaw-home-");
    await mkdir(join(source, "settings"), { recursive: true });
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await writeFakeOpenClaw(home);
    await writePackage(source, [{ type: "settings", path: "settings/openclaw.json" }]);
    await writeFile(join(source, "settings", "openclaw.json"), JSON.stringify({
      agents: { list: [{ id: "managed", name: "managed", model: "gpt-5" }] },
      ui: { theme: "dark" },
    }, null, 2), "utf8");
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify({
      agents: { list: [{ id: "existing", name: "existing", model: "local" }, { id: "managed", name: "managed", systemPromptOverride: "stale" }] },
      keep: true,
    }, null, 2), "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source);
      const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, undefined, { installationType: "user" });
      const operation = plan.operations.find((candidate) => candidate.artifactType === "settings");
      expect(operation?.action).toBe("update");
      expect(operation?.relativeDestPath).toBe(".openclaw/openclaw.json");
      expect(operation?.destPath).toBe(join(home, ".openclaw", "openclaw.json"));
      expect(operation?.mergeStrategy).toBe("openclaw-json-deep");

      await applyInstallPlan(plan, bundle.sourceLock);
      const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
      expect(config.keep).toBe(true);
      expect(config.ui.theme).toBe("dark");
      expect(config.agents.list).toEqual([
        { id: "existing", name: "existing", model: "local" },
        { id: "managed", name: "managed", model: "gpt-5" },
      ]);
      const manifest = await readInstallManifest(home, "openclaw", undefined, { installationType: "user" });
      expect(manifest?.entries.find((entry) => entry.artifactType === "settings")?.mergeStrategy).toBe("openclaw-json-deep");
      await rm(bundle.root, { recursive: true, force: true });
    });
  });

  it("installs OpenClaw subagents as workspace AGENTS directories", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-openclaw-home-");
    await mkdir(join(source, "subagents", "reviewer"), { recursive: true });
    await writePackage(source, [{ type: "subagents", path: "subagents" }]);
    await writeFile(join(source, "subagents", "reviewer", "AGENTS.md"), [
      "---",
      "name: reviewer",
      'description: "Review work."',
      "disallowedTools: Agent",
      "---",
      "",
      "# Reviewer",
      "",
      "Review the work and return a concise handoff.",
      "",
    ].join("\n"), "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source, { adapter: openClawAdapter });
      const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, undefined, { installationType: "user" });
      expect(plan.targetRoot).toBe(home);
      expect(plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/workspace-subagents/reviewer"]);

      await applyInstallPlan(plan, bundle.sourceLock);
      const installed = await readFile(join(home, ".openclaw", "workspace-subagents", "reviewer", "AGENTS.md"), "utf8");
      expect(installed).toContain("# Reviewer");
      expect(installed).toContain("Review the work");
      expect(installed).not.toContain("disallowedTools");
      expect(installed).not.toMatch(/^---/);
      await rm(bundle.root, { recursive: true, force: true });
    });
  });

  it("validates openclaw-json-deep merges before replacing openclaw.json", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-openclaw-home-");
    await mkdir(join(source, "settings"), { recursive: true });
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await writeFakeOpenClaw(home, { rejectSystemPromptOverride: true });
    await writePackage(source, [{ type: "settings", path: "settings/openclaw.json" }]);
    await writeFile(join(source, "settings", "openclaw.json"), JSON.stringify({
      agents: { list: [{ id: "bad", systemPromptOverride: "invalid" }] },
    }, null, 2), "utf8");
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ keep: true }, null, 2), "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source);
      const plan = await createInstallPlan(bundle, openClawAdapter, target, undefined, undefined, { installationType: "user" });
      await expect(applyInstallPlan(plan, bundle.sourceLock)).rejects.toThrow(/valid": false|Invalid config/);
      const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
      expect(config).toEqual({ keep: true });
      await rm(bundle.root, { recursive: true, force: true });
    });
  });
});

async function writeFakeOpenClaw(home: string, options: { rejectSystemPromptOverride?: boolean } = {}): Promise<void> {
  const bin = join(home, ".openclaw", "npm", "node_modules", ".bin", "openclaw");
  await mkdir(join(home, ".openclaw", "npm", "node_modules", ".bin"), { recursive: true });
  await writeFile(bin, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const cfg = process.env.OPENCLAW_CONFIG_PATH;",
    "const text = fs.readFileSync(cfg, 'utf8');",
    "JSON.parse(text);",
    options.rejectSystemPromptOverride
      ? "const valid = !text.includes('systemPromptOverride');"
      : "const valid = true;",
    "process.stdout.write(JSON.stringify(valid ? { valid: true, path: cfg } : { valid: false, path: cfg, issues: [{ path: 'agents.list.0', message: 'Invalid config' }] }));",
    "process.exit(0);",
    "",
  ].join("\n"), "utf8");
  await chmod(bin, 0o755);
}
