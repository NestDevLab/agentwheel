import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { copilotAdapter } from "../src/adapters/copilot.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, readInstallManifest, uninstall } from "../src/install/index.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-copilot-adapter-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeCopilotPackage(root: string): Promise<void> {
  await mkdir(join(root, "plugins", "demo-plugin"), { recursive: true });
  await mkdir(join(root, "settings"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "acme/copilot-adapter",
    version: "1.0.0",
    provides: [
      { type: "plugins", path: "plugins" },
      { type: "settings", path: "settings/settings.json" },
    ],
  }, null, 2), "utf8");
  await writeFile(join(root, "plugins", "demo-plugin", "plugin.json"), JSON.stringify({
    name: "demo-plugin",
  }, null, 2), "utf8");
  await writeFile(join(root, "settings", "settings.json"), JSON.stringify({
    featureFlags: { managed: true },
    managedOnly: true,
  }, null, 2), "utf8");
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

describe("Copilot adapter", () => {
  it("rejects local persistent plugin installs clearly", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeCopilotPackage(source);

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: ["plugins/demo-plugin"],
    });
    expect(copilotAdapter.targets.plugins?.local).toBeUndefined();
    await expect(createInstallPlan(bundle, copilotAdapter, target, undefined, localTransport, { installationType: "local" }))
      .rejects.toThrow(/Adapter copilot does not support plugins artifacts for installation type 'local'.*Supported: user/);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("plans user plugins as semantic local-path installs and deep-merges user settings", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot("agentwheel-copilot-home-");
    await writeCopilotPackage(source);
    await mkdir(join(home, ".copilot"), { recursive: true });
    await writeFile(join(home, ".copilot", "settings.json"), JSON.stringify({
      featureFlags: { user: true },
      keep: true,
    }, null, 2), "utf8");

    await withTestHome(home, async () => {
      const bundle = await stageSource(new LocalSourceDriver(), source, {
        select: ["plugins/demo-plugin", "settings/settings.json"],
      });
      const plan = await createInstallPlan(bundle, copilotAdapter, target, undefined, localTransport, { installationType: "user" });
      const plugin = plan.operations.find((operation) => operation.artifactType === "plugins");
      const settings = plan.operations.find((operation) => operation.artifactType === "settings");

      expect(copilotAdapter.targets.plugins?.user?.semantic).toBe("copilot-plugin");
      expect(copilotAdapter.targets.plugins?.user?.dest).toBe(".agentwheel/plugins/copilot");
      expect(plugin?.action).toBe("plugin");
      expect(plugin?.relativeDestPath).toBe("plugins/demo-plugin");
      expect(plugin?.destPath).toBe(home);
      expect(plugin?.semanticPlugin).toMatchObject({
        runtime: "copilot",
        pluginName: "demo-plugin",
        stateRoot: join(home, ".agentwheel", "plugins", "copilot", "user", "acme-copilot-adapter", "demo-plugin"),
        installCommands: [["copilot", "plugin", "install", join(home, ".agentwheel", "plugins", "copilot", "user", "acme-copilot-adapter", "demo-plugin", "plugin")]],
        uninstallCommands: [["copilot", "plugin", "uninstall", "demo-plugin"]],
      });
      expect(settings?.relativeDestPath).toBe(".copilot/settings.json");
      expect(settings?.mergeStrategy).toBe("json-deep");

      const manifest = await applyInstallPlan(plan, bundle.sourceLock);

      await expect(stat(join(home, ".copilot", "plugins", "demo-plugin", "plugin.json"))).rejects.toThrow();
      const mergedSettings = JSON.parse(await readFile(join(home, ".copilot", "settings.json"), "utf8"));
      expect(mergedSettings.keep).toBe(true);
      expect(mergedSettings.managedOnly).toBe(true);
      expect(mergedSettings.featureFlags).toEqual({ user: true, managed: true });
      expect(manifest.entries.find((entry) => entry.artifactType === "settings")?.mergeStrategy).toBe("json-deep");
      expect(manifest.entries.find((entry) => entry.artifactType === "plugins")?.path).toBe("plugins/demo-plugin");
      expect(manifest.entries.find((entry) => entry.artifactType === "plugins")?.executed).toBe(false);
      await rm(bundle.root, { recursive: true, force: true });
    });
  });

  it("executes Copilot user plugin install/uninstall through the persistent Agentwheel state dir", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeCopilotPackage(source);
    const executed: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const sshTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
      async execFile(command, args, options = {}) {
        executed.push({ command, args, cwd: options.cwd });
        if (command === "copilot" && args[0] === "plugin" && args[1] === "install") {
          await stat(args[2] ?? "");
        }
      },
    };

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: ["plugins/demo-plugin"],
    });
    const plan = await createInstallPlan(bundle, copilotAdapter, target, undefined, sshTransport, { installationType: "user" });
    const manifest = await applyInstallPlan(plan, bundle.sourceLock, {
      executePlugins: true,
      transport: sshTransport,
    });
    const stateRoot = join(target, ".agentwheel", "plugins", "copilot", "user", "acme-copilot-adapter", "demo-plugin");

    expect(executed).toEqual([
      {
        command: "copilot",
        args: ["plugin", "install", join(stateRoot, "plugin")],
        cwd: target,
      },
    ]);
    await expect(stat(join(stateRoot, "plugin", "plugin.json"))).resolves.toBeTruthy();
    expect(manifest.entries[0]?.executed).toBe(true);

    const uninstallPlan = await createUninstallPlan((await readInstallManifest(target, copilotAdapter.name, sshTransport, { installationType: "user" }))!, sshTransport);
    await uninstall(uninstallPlan, { transport: sshTransport });

    expect(executed.at(-1)).toEqual({
      command: "copilot",
      args: ["plugin", "uninstall", "demo-plugin"],
      cwd: target,
    });
    await expect(stat(stateRoot)).rejects.toThrow();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("rejects Copilot plugins without plugin.json", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await mkdir(join(source, "plugins", "demo-plugin"), { recursive: true });
    await writeFile(join(source, "openpack.json"), JSON.stringify({
      schemaVersion: 2,
      name: "acme/copilot-adapter",
      version: "1.0.0",
      provides: [{ type: "plugins", path: "plugins" }],
    }, null, 2), "utf8");

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: ["plugins/demo-plugin"],
    });

    await expect(createInstallPlan(bundle, copilotAdapter, target, undefined, localTransport, { installationType: "user" }))
      .rejects.toThrow(/Copilot plugins must contain plugin\.json/);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("smoke checks installed Copilot plugin install help when available", async () => {
    if (!(await hasCopilotBinary())) return;
    const { stdout } = await execFileAsync("copilot", ["plugin", "install", "--help"]);
    expect(stdout).toContain("Usage: copilot plugin install");
  });
});

async function hasCopilotBinary(): Promise<boolean> {
  try {
    await execFileAsync("copilot", ["plugin", "--help"]);
    return true;
  } catch {
    return false;
  }
}
