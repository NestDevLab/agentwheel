import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
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

async function tempRoot(prefix = "agentwheel-claude-adapter-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function pluginArtifact(root: string, name = "demo-plugin"): Promise<DesiredArtifact> {
  const sourcePath = join(root, "plugins", name);
  await mkdir(join(sourcePath, ".claude-plugin"), { recursive: true });
  await writeFile(join(sourcePath, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
  return {
    type: "plugins",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join("plugins", name),
    kind: "dir",
    hash: await hashPath(sourcePath),
    packageName: "acme/claude-pack",
    channel: "managed",
    meta: {
      logicalSelector: `plugins/${name}`,
      dependencyRole: "root",
      owners: ["claude-adapter-test"],
    },
  };
}

describe("Claude adapter", () => {
  it("declares Claude plugin targets with claude-plugin semantics", () => {
    expect(claudeAdapter.targets.plugins?.local).toMatchObject({
      dest: ".agentwheel/plugins/claude",
      semantic: "claude-plugin",
    });
    expect(claudeAdapter.targets.plugins?.user).toMatchObject({
      root: "home",
      dest: ".agentwheel/plugins/claude",
      semantic: "claude-plugin",
    });
  });

  it("plans Claude plugin installs as local and user semantic marketplace operations", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const home = await tempRoot();
    process.env.AGENTWHEEL_TEST_HOME = home;
    const artifact = await pluginArtifact(source);

    const localPlan = await createCombinedInstallPlan([artifact], claudeAdapter, target, undefined, undefined, { installationType: "local" });
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
      runtime: "claude",
      pluginName: "demo-plugin",
      marketplaceName: "agentwheel-acme-claude-pack-demo-plugin",
      stateRoot: join(target, ".agentwheel", "plugins", "claude", "local", "acme-claude-pack", "demo-plugin"),
      installCommands: [
        ["claude", "plugin", "marketplace", "add", join(target, ".agentwheel", "plugins", "claude", "local", "acme-claude-pack", "demo-plugin", "marketplace"), "--scope", "local"],
        ["claude", "plugin", "install", "demo-plugin@agentwheel-acme-claude-pack-demo-plugin", "--scope", "local"],
      ],
      uninstallCommands: [
        ["claude", "plugin", "uninstall", "demo-plugin@agentwheel-acme-claude-pack-demo-plugin", "--scope", "local"],
        ["claude", "plugin", "marketplace", "remove", "agentwheel-acme-claude-pack-demo-plugin", "--scope", "local"],
      ],
    });

    const userPlan = await createCombinedInstallPlan([artifact], claudeAdapter, target, undefined, undefined, { installationType: "user" });
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
    expect(userPlan.operations[0]?.semanticPlugin?.stateRoot).toBe(join(home, ".agentwheel", "plugins", "claude", "user", "acme-claude-pack", "demo-plugin"));
    expect(userPlan.operations[0]?.semanticPlugin?.installCommands[0]).toEqual([
      "claude",
      "plugin",
      "marketplace",
      "add",
      join(home, ".agentwheel", "plugins", "claude", "user", "acme-claude-pack", "demo-plugin", "marketplace"),
      "--scope",
      "user",
    ]);
  });

  it("rejects Claude plugins without .claude-plugin/plugin.json", async () => {
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

    await expect(createCombinedInstallPlan([artifact], claudeAdapter, target, undefined, undefined, { installationType: "local" }))
      .rejects.toThrow(/Claude plugins must contain \.claude-plugin\/plugin\.json/);
  });
});
