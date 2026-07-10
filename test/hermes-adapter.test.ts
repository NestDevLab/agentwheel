import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, createUninstallPlan, readInstallManifest, uninstall, type DesiredArtifact } from "../src/install/index.js";
import type { ArtifactType, FileKind } from "../src/model/artifact.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-hermes-adapter-"): Promise<string> {
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

describe("Hermes adapter", () => {
  it("maps user instructions to HERMES_HOME/SOUL.md while preserving project AGENTS.md", () => {
    expect(hermesAdapter.targets.instructions?.local).toMatchObject({
      enabled: true,
      dest: "AGENTS.md",
    });
    expect(hermesAdapter.targets.instructions?.user).toMatchObject({
      enabled: true,
      root: "home",
      dest: ".hermes/SOUL.md",
    });
  });

  it("deep-merges user MCP and settings artifacts into ~/.hermes/config.yaml", async () => {
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-hermes-home-");
    const source = await tempRoot("agentwheel-hermes-source-");
    const configPath = join(home, ".hermes", "config.yaml");
    const mcpPath = join(source, "mcp", "servers.yaml");
    const settingsPath = join(source, "settings", "delegation.yaml");

    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(mcpPath), { recursive: true });
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(configPath, [
      "display:",
      "  skin: noir",
      "mcp_servers:",
      "  existing:",
      "    command: uvx",
      "delegation:",
      "  enabled: false",
      "",
    ].join("\n"), "utf8");
    await writeFile(mcpPath, [
      "mcp_servers:",
      "  managed:",
      "    command: npx",
      "    args:",
      "      - -y",
      "      - '@modelcontextprotocol/server-filesystem'",
      "",
    ].join("\n"), "utf8");
    await writeFile(settingsPath, [
      "delegation:",
      "  enabled: true",
      "  provider: openrouter",
      "mcp_servers:",
      "  settings_managed:",
      "    command: uvx",
      "",
    ].join("\n"), "utf8");

    const mcp = await desiredArtifact("mcp", "servers.yaml", mcpPath);
    const settings = await desiredArtifact("settings", "delegation.yaml", settingsPath);

    await withTestHome(home, async () => {
      const mcpPlan = await createCombinedInstallPlan([mcp], hermesAdapter, target, undefined, localTransport, { installationType: "user" });
      expect(mcpPlan.targetRoot).toBe(home);
      expect(mcpPlan.operations[0]).toMatchObject({
        artifactType: "mcp",
        relativeDestPath: ".hermes/config.yaml",
        destPath: configPath,
        mergeStrategy: "yaml-deep",
      });
      await applyCombinedInstallPlan(mcpPlan);

      const settingsPlan = await createCombinedInstallPlan(
        [settings],
        hermesAdapter,
        target,
        await readInstallManifest(home, hermesAdapter.name, localTransport, { installationType: "user" }),
        localTransport,
        { installationType: "user" },
      );
      expect(settingsPlan.operations[0]).toMatchObject({
        artifactType: "settings",
        relativeDestPath: ".hermes/config.yaml",
        destPath: configPath,
        mergeStrategy: "yaml-deep",
      });
      await applyCombinedInstallPlan(settingsPlan);
    });

    expect(parse(await readFile(configPath, "utf8"))).toEqual({
      display: {
        skin: "noir",
      },
      mcp_servers: {
        existing: {
          command: "uvx",
        },
        managed: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
        settings_managed: {
          command: "uvx",
        },
      },
      delegation: {
        enabled: true,
        provider: "openrouter",
      },
    });
  });

  it("plans user plugins with hermes-plugin semantic metadata", async () => {
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-hermes-home-");
    const pluginRoot = join(await tempRoot("agentwheel-hermes-plugin-"), "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.yaml"), [
      "name: demo-plugin",
      "version: '1.0'",
      "description: Demo Hermes plugin",
      "",
    ].join("\n"), "utf8");

    expect(hermesAdapter.targets.plugins?.user).toMatchObject({
      enabled: true,
      root: "home",
      dest: ".agentwheel/plugins/hermes",
      semantic: "hermes-plugin",
    });

    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");
    await withTestHome(home, async () => {
      const plan = await createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, localTransport, { installationType: "user" });
      expect(plan.targetRoot).toBe(home);
      expect(plan.operations[0]).toMatchObject({
        action: "plugin",
        artifactType: "plugins",
        artifactName: "demo-plugin",
        relativeDestPath: "plugins/demo-plugin",
        destPath: home,
        semanticPlugin: {
          runtime: "hermes",
          pluginName: "demo-plugin",
          stateRoot: join(home, ".agentwheel", "plugins", "hermes", "user", "package", "demo-plugin"),
          installCommands: [["hermes", "plugins", "install", "--force", "--enable", `file://${join(home, ".agentwheel", "plugins", "hermes", "user", "package", "demo-plugin", "repo")}`]],
          uninstallCommands: [["hermes", "plugins", "remove", "demo-plugin"]],
        },
      });
    });
  });

  it("executes Hermes install over ssh using a persistent remote git shim", async () => {
    const target = await tempRoot();
    const pluginRoot = join(await tempRoot("agentwheel-hermes-plugin-"), "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.yaml"), [
      "name: demo-plugin",
      "version: '1.0'",
      "description: Demo Hermes plugin",
      "",
    ].join("\n"), "utf8");
    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");
    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        if (command === "git") {
          await localTransport.execFile!(command, args, options);
        }
      },
    };

    const plan = await createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, sshTransport, { installationType: "user" });
    const manifest = await applyCombinedInstallPlan(plan, {
      executePlugins: true,
      transport: sshTransport,
    });
    const repoRoot = join(target, ".agentwheel", "plugins", "hermes", "user", "package", "demo-plugin", "repo");

    await expect(readFile(join(repoRoot, "plugin.yaml"), "utf8")).resolves.toContain("name: demo-plugin");
    await expect(readFile(join(repoRoot, ".git", "HEAD"), "utf8")).resolves.toBeTruthy();
    expect(executed.map((item) => [item.command, ...item.args])).toEqual([
      ["git", "init", repoRoot],
      ["git", "-C", repoRoot, "add", "-A"],
      ["git", "-C", repoRoot, "-c", "user.name=agentwheel", "-c", "user.email=agentwheel@example.invalid", "commit", "-m", `agentwheel plugin ${plugin.hash}`],
      ["hermes", "plugins", "install", "--force", "--enable", `file://${repoRoot}`],
    ]);
    expect(manifest.entries[0]?.executed).toBe(true);

    const uninstallPlan = await createUninstallPlan((await readInstallManifest(target, hermesAdapter.name, sshTransport, { installationType: "user" }))!, sshTransport);
    await uninstall(uninstallPlan, { transport: sshTransport });
    expect(executed.at(-1)).toEqual({
      command: "hermes",
      args: ["plugins", "remove", "demo-plugin"],
      cwd: target,
    });
    await expect(readFile(repoRoot, "utf8")).rejects.toThrow();
  });

  it("treats an already-absent Hermes plugin remove as successful with a warning", async () => {
    const target = await tempRoot();
    const pluginRoot = join(await tempRoot("agentwheel-hermes-plugin-"), "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.yaml"), "name: demo-plugin\nversion: '1.0'\n", "utf8");
    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");
    const installTransport = hermesPluginTransport();

    const plan = await createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, installTransport, { installationType: "user" });
    await applyCombinedInstallPlan(plan, { executePlugins: true, transport: installTransport });
    const manifest = await readInstallManifest(target, hermesAdapter.name, installTransport, { installationType: "user" });
    const uninstallPlan = await createUninstallPlan(manifest!, installTransport);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const absentTransport = hermesPluginTransport({
      removeError: Object.assign(new Error("remove failed"), { stderr: "Plugin demo-plugin is not installed\n" }),
    });

    try {
      await uninstall(uninstallPlan, { transport: absentTransport });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("plugin-already-absent plugins/demo-plugin"));
    } finally {
      warn.mockRestore();
    }

    await expect(readFile(join(target, ".agentwheel", "plugins", "hermes", "user", "package", "demo-plugin", "repo", "plugin.yaml"), "utf8")).rejects.toThrow();
  });

  it("does not mask non-absent Hermes plugin remove failures", async () => {
    const target = await tempRoot();
    const pluginRoot = join(await tempRoot("agentwheel-hermes-plugin-"), "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.yaml"), "name: demo-plugin\nversion: '1.0'\n", "utf8");
    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");
    const installTransport = hermesPluginTransport();

    const plan = await createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, installTransport, { installationType: "user" });
    await applyCombinedInstallPlan(plan, { executePlugins: true, transport: installTransport });
    const manifest = await readInstallManifest(target, hermesAdapter.name, installTransport, { installationType: "user" });
    const uninstallPlan = await createUninstallPlan(manifest!, installTransport);
    const failingTransport = hermesPluginTransport({
      removeError: Object.assign(new Error("remove failed"), { stderr: "Permission denied while removing demo-plugin\n" }),
    });

    await expect(uninstall(uninstallPlan, { transport: failingTransport })).rejects.toThrow(/remove failed/);
  });

  it("rejects Hermes plugins without plugin.yaml or plugin.yml", async () => {
    const target = await tempRoot();
    const pluginRoot = join(await tempRoot("agentwheel-hermes-plugin-"), "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "demo-plugin" }), "utf8");
    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");

    await expect(createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, localTransport, { installationType: "user" }))
      .rejects.toThrow(/Hermes plugins must contain plugin.yaml or plugin.yml/);
  });
});

async function desiredArtifact(
  type: ArtifactType,
  name: string,
  sourcePath: string,
  kind: FileKind = "file",
  format?: string,
): Promise<DesiredArtifact> {
  return {
    type,
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: `${type}/${name}`,
    kind,
    hash: await hashPath(sourcePath),
    format,
    channel: "managed",
    meta: {
      logicalSelector: `${type}/${name}`,
      dependencyRole: "root",
      owners: ["root"],
    },
  };
}

function hermesPluginTransport(options: { removeError?: Error } = {}): TargetTransport {
  return {
    ...localTransport,
    kind: "ssh",
    description: "fake ssh",
    async execFile(command, args, execOptions = {}) {
      if (command === "git") {
        await localTransport.execFile!(command, args, execOptions);
        return;
      }
      if (command === "hermes" && args.join(" ") === "plugins remove demo-plugin" && options.removeError) {
        throw options.removeError;
      }
    },
  };
}
