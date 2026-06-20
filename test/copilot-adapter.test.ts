import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copilotAdapter } from "../src/adapters/copilot.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";
import { localTransport } from "../src/transport/index.js";

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
  it("installs local plugins and deep-merges local settings", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeCopilotPackage(source);
    await mkdir(join(target, ".github"), { recursive: true });
    await writeFile(join(target, ".github", "settings.json"), JSON.stringify({
      featureFlags: { user: true },
      keep: true,
    }, null, 2), "utf8");

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      select: ["plugins/demo-plugin", "settings/settings.json"],
    });
    const plan = await createInstallPlan(bundle, copilotAdapter, target, undefined, localTransport, { installationType: "local" });
    const plugin = plan.operations.find((operation) => operation.artifactType === "plugins");
    const settings = plan.operations.find((operation) => operation.artifactType === "settings");

    expect(copilotAdapter.targets.plugins?.local?.semantic).toBe("copilot-plugin");
    expect(plugin?.relativeDestPath).toBe(".github/plugins/demo-plugin");
    expect(plugin?.action).toBe("create");
    expect(settings?.relativeDestPath).toBe(".github/settings.json");
    expect(settings?.mergeStrategy).toBe("json-deep");

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);

    await expect(stat(join(target, ".github", "plugins", "demo-plugin", "plugin.json"))).resolves.toBeTruthy();
    const mergedSettings = JSON.parse(await readFile(join(target, ".github", "settings.json"), "utf8"));
    expect(mergedSettings.keep).toBe(true);
    expect(mergedSettings.managedOnly).toBe(true);
    expect(mergedSettings.featureFlags).toEqual({ user: true, managed: true });
    expect(manifest.entries.find((entry) => entry.artifactType === "settings")?.mergeStrategy).toBe("json-deep");
    expect(manifest.entries.find((entry) => entry.artifactType === "plugins")?.path).toBe(".github/plugins/demo-plugin");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("installs user plugins and deep-merges user settings", async () => {
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
      expect(plugin?.relativeDestPath).toBe(".copilot/plugins/demo-plugin");
      expect(settings?.relativeDestPath).toBe(".copilot/settings.json");
      expect(settings?.mergeStrategy).toBe("json-deep");

      const manifest = await applyInstallPlan(plan, bundle.sourceLock);

      await expect(stat(join(home, ".copilot", "plugins", "demo-plugin", "plugin.json"))).resolves.toBeTruthy();
      const mergedSettings = JSON.parse(await readFile(join(home, ".copilot", "settings.json"), "utf8"));
      expect(mergedSettings.keep).toBe(true);
      expect(mergedSettings.managedOnly).toBe(true);
      expect(mergedSettings.featureFlags).toEqual({ user: true, managed: true });
      expect(manifest.entries.find((entry) => entry.artifactType === "settings")?.mergeStrategy).toBe("json-deep");
      expect(manifest.entries.find((entry) => entry.artifactType === "plugins")?.path).toBe(".copilot/plugins/demo-plugin");
      await rm(bundle.root, { recursive: true, force: true });
    });
  });
});
