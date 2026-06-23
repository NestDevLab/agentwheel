import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { createCombinedInstallPlan, type DesiredArtifact } from "../src/install/index.js";
import { hashPath } from "../src/utils/fs.js";

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

async function tempRoot(prefix = "agentwheel-codex-adapter-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function pluginArtifact(root: string, name = "demo-plugin"): Promise<DesiredArtifact> {
  const sourcePath = join(root, "plugins", name);
  await mkdir(join(sourcePath, ".codex-plugin"), { recursive: true });
  await writeFile(join(sourcePath, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
  return {
    type: "plugins",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join("plugins", name),
    kind: "dir",
    hash: await hashPath(sourcePath),
    packageName: "acme/codex-pack",
    channel: "managed",
    meta: {
      logicalSelector: `plugins/${name}`,
      dependencyRole: "root",
      owners: ["codex-adapter-test"],
    },
  };
}

async function ruleArtifact(root: string): Promise<DesiredArtifact> {
  const sourcePath = join(root, "rules", "safe.md");
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(sourcePath, "# Safe\n", "utf8");
  return {
    type: "rules",
    name: "safe.md",
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join("rules", "safe.md"),
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: {
      logicalSelector: "rules/safe.md",
      dependencyRole: "root",
      owners: ["codex-adapter-test"],
    },
  };
}

describe("Codex adapter", () => {
  it("declares Codex plugin targets and omits behavioral rules", () => {
    expect(codexAdapter.targets.plugins?.local).toMatchObject({
      dest: ".agentwheel/plugins/codex",
      semantic: "codex-plugin",
    });
    expect(codexAdapter.targets.plugins?.user).toMatchObject({
      root: "home",
      dest: ".agentwheel/plugins/codex",
      semantic: "codex-plugin",
    });
    expect(codexAdapter.targets.rules).toBeUndefined();
  });

  it("plans Codex plugin installs as local and user semantic marketplace operations", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot();
    process.env.AGENTWHEEL_TEST_HOME = home;
    const artifact = await pluginArtifact(source);

    const localPlan = await createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "local" });
    expect(localPlan.targetRoot).toBe(target);
    expect(localPlan.operations).toHaveLength(1);
    expect(localPlan.operations[0]).toMatchObject({
      artifactType: "plugins",
      artifactName: "demo-plugin",
      installName: "demo-plugin",
      action: "plugin",
      relativeDestPath: "plugins/demo-plugin",
    });
    expect(localPlan.operations[0]?.destPath).toBe(target);
    expect(localPlan.operations[0]?.semanticPlugin).toMatchObject({
      runtime: "codex",
      pluginName: "demo-plugin",
      marketplaceName: "agentwheel-acme-codex-pack-demo-plugin",
      stateRoot: join(target, ".agentwheel", "plugins", "codex", "local", "acme-codex-pack", "demo-plugin"),
      installCommands: [
        ["codex", "plugin", "marketplace", "add", join(target, ".agentwheel", "plugins", "codex", "local", "acme-codex-pack", "demo-plugin", "marketplace"), "--json"],
        ["codex", "plugin", "add", "demo-plugin@agentwheel-acme-codex-pack-demo-plugin", "--json"],
      ],
      uninstallCommands: [
        ["codex", "plugin", "remove", "demo-plugin@agentwheel-acme-codex-pack-demo-plugin", "--json"],
        ["codex", "plugin", "marketplace", "remove", "agentwheel-acme-codex-pack-demo-plugin", "--json"],
      ],
    });

    const userPlan = await createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "user" });
    expect(userPlan.targetRoot).toBe(home);
    expect(userPlan.operations).toHaveLength(1);
    expect(userPlan.operations[0]).toMatchObject({
      artifactType: "plugins",
      artifactName: "demo-plugin",
      installName: "demo-plugin",
      action: "plugin",
      relativeDestPath: "plugins/demo-plugin",
    });
    expect(userPlan.operations[0]?.destPath).toBe(home);
    expect(userPlan.operations[0]?.semanticPlugin?.stateRoot).toBe(join(home, ".agentwheel", "plugins", "codex", "user", "acme-codex-pack", "demo-plugin"));
  });

  it("rejects behavioral rules through the built-in Codex adapter", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await ruleArtifact(source);

    await expect(createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "local" }))
      .rejects.toThrow(/Adapter codex does not support rules artifacts for any installation type/);
  });

  it("rejects Codex plugins without .codex-plugin/plugin.json", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const sourcePath = join(source, "plugins", "demo-plugin");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(sourcePath, "plugin.json"), `${JSON.stringify({ name: "demo-plugin" }, null, 2)}\n`, "utf8");
    const artifact = {
      ...(await pluginArtifact(await tempRoot(), "valid-plugin")),
      name: "demo-plugin",
      sourcePath,
      stagedPath: sourcePath,
      relativePath: join("plugins", "demo-plugin"),
      hash: await hashPath(sourcePath),
    };

    await expect(createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "local" }))
      .rejects.toThrow(/Codex plugins must contain \.codex-plugin\/plugin\.json/);
  });
});
