import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { hermesAdapter } from "../src/adapters/hermes.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, readInstallManifest, type DesiredArtifact } from "../src/install/index.js";
import type { ArtifactType, FileKind } from "../src/model/artifact.js";
import { localTransport } from "../src/transport/index.js";
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

  it("maps user plugins to ~/.hermes/plugins with hermes-plugin semantic metadata", async () => {
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
      dest: ".hermes/plugins",
      semantic: "hermes-plugin",
    });

    const plugin = await desiredArtifact("plugins", "demo-plugin", pluginRoot, "dir", "hermes-plugin");
    await withTestHome(home, async () => {
      const plan = await createCombinedInstallPlan([plugin], hermesAdapter, target, undefined, localTransport, { installationType: "user" });
      expect(plan.targetRoot).toBe(home);
      expect(plan.operations[0]).toMatchObject({
        artifactType: "plugins",
        artifactName: "demo-plugin",
        relativeDestPath: ".hermes/plugins/demo-plugin",
        destPath: join(home, ".hermes", "plugins", "demo-plugin"),
      });
    });
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
