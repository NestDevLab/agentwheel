import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, type DesiredArtifact } from "../src/install/index.js";
import type { ArtifactFormat } from "../src/model/artifact.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-plugin-shim-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("semantic plugin shims", () => {
  it.each([
    ["--force\n--accept-capabilities", true],
    ["--force", false],
    [undefined, false],
  ])("detects OpenClaw consent on the target once per apply: %s", async (help, supported) => {
    const source = await tempRoot();
    const target = await tempRoot();
    const plugins = await Promise.all(["first-plugin", "second-plugin"].map((name) => pluginArtifact(source, "openclaw", name, "openclaw-plugin")));
    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const transport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake target",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        if (args.includes("--help") || args.includes("--version")) {
          if (help === undefined) throw new Error("probe unavailable");
          return help;
        }
        await stat(args.at(-1)!);
      },
    };
    const plan = await createCombinedInstallPlan(plugins, openClawAdapter, target, undefined, transport);
    expect(executed).toEqual([]);
    await applyCombinedInstallPlan(plan, { transport, executePlugins: true });
    expect(executed.filter(({ args }) => args.includes("--help"))).toEqual([
      { command: "openclaw", args: ["plugins", "install", "--help"], cwd: target },
    ]);
    expect(executed.filter(({ args }) => args.includes("--version"))).toHaveLength(help === undefined ? 1 : 0);
    const installs = executed.filter(({ args }) => !args.includes("--help") && args[1] === "install");
    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install.command).toBe("openclaw");
      expect(install.args.includes("--accept-capabilities")).toBe(supported);
      expect(install.args).toContain("--force");
      expect(install.args.at(-1)).toContain(join(target, ".agentwheel", "plugin-staging"));
    }
  });

  it("materializes a Claude local marketplace at apply time and executes install commands", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const plugin = await pluginArtifact(source, "claude", "demo-plugin", "claude-plugin");
    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport = fakeSshTransport(executed);

    const plan = await createCombinedInstallPlan([plugin], claudeAdapter, target, undefined, sshTransport, { installationType: "local" });
    const manifest = await applyCombinedInstallPlan(plan, { executePlugins: true, transport: sshTransport });
    const marketplaceRoot = join(target, ".agentwheel", "plugins", "claude", "local", "acme-claude-pack", "demo-plugin", "marketplace");

    await expect(stat(join(marketplaceRoot, "plugins", "demo-plugin", ".claude-plugin", "plugin.json"))).resolves.toBeTruthy();
    const marketplace = JSON.parse(await readFile(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(marketplace).toMatchObject({
      name: "agentwheel-acme-claude-pack-demo-plugin",
      plugins: [{ name: "demo-plugin", source: "./plugins/demo-plugin" }],
    });
    expect(executed).toEqual([
      {
        command: "claude",
        args: ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "local"],
        cwd: target,
      },
      {
        command: "claude",
        args: ["plugin", "install", "demo-plugin@agentwheel-acme-claude-pack-demo-plugin", "--scope", "local"],
        cwd: target,
      },
    ]);
    expect(manifest.entries[0]?.executed).toBe(true);
  });

  it("materializes a Codex local marketplace at apply time and executes install commands", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const plugin = await pluginArtifact(source, "codex", "demo-plugin", "codex-plugin");
    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport = fakeSshTransport(executed);

    const plan = await createCombinedInstallPlan([plugin], codexAdapter, target, undefined, sshTransport, { installationType: "local" });
    const manifest = await applyCombinedInstallPlan(plan, { executePlugins: true, transport: sshTransport });
    const marketplaceRoot = join(target, ".agentwheel", "plugins", "codex", "local", "acme-codex-pack", "demo-plugin", "marketplace");

    await expect(stat(join(marketplaceRoot, "plugins", "demo-plugin", ".codex-plugin", "plugin.json"))).resolves.toBeTruthy();
    const marketplace = JSON.parse(await readFile(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    expect(marketplace).toMatchObject({
      name: "agentwheel-acme-codex-pack-demo-plugin",
      plugins: [
        {
          name: "demo-plugin",
          source: { source: "local", path: "./plugins/demo-plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        },
      ],
    });
    expect(executed).toEqual([
      {
        command: "codex",
        args: ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
        cwd: target,
      },
      {
        command: "codex",
        args: ["plugin", "add", "demo-plugin@agentwheel-acme-codex-pack-demo-plugin", "--json"],
        cwd: target,
      },
    ]);
    expect(manifest.entries[0]?.executed).toBe(true);
  });
});

function fakeSshTransport(executed: Array<{ command: string; args: string[]; cwd?: string }>): TargetTransport {
  return {
    ...localTransport,
    kind: "ssh",
    description: "fake ssh",
    async execFile(command, args, options = {}) {
      executed.push({ command, args, cwd: options.cwd });
      if (command === "claude" || command === "codex") {
        const marketplaceRoot = args.includes("marketplace") && args.includes("add") ? args[3] : undefined;
        if (marketplaceRoot) await stat(marketplaceRoot);
      }
    },
  };
}

async function pluginArtifact(root: string, runtime: "claude" | "codex" | "openclaw", name: string, format: ArtifactFormat): Promise<DesiredArtifact> {
  const sourcePath = join(root, "plugins", name);
  const descriptorRoot = runtime === "openclaw" ? "" : runtime === "claude" ? ".claude-plugin" : ".codex-plugin";
  await mkdir(join(sourcePath, descriptorRoot), { recursive: true });
  await writeFile(join(sourcePath, descriptorRoot, "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
  return {
    type: "plugins",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join("plugins", name),
    kind: "dir",
    hash: await hashPath(sourcePath),
    format,
    packageName: `acme/${runtime}-pack`,
    channel: "managed",
    meta: {
      logicalSelector: `plugins/${name}`,
      dependencyRole: "root",
      owners: [`${runtime}-shim-test`],
    },
  };
}
