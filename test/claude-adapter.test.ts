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
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
  return {
    type: "plugins",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join("plugins", name),
    kind: "dir",
    hash: await hashPath(sourcePath),
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
      dest: ".claude/plugins",
      semantic: "claude-plugin",
    });
    expect(claudeAdapter.targets.plugins?.user).toMatchObject({
      root: "home",
      dest: ".claude/plugins",
      semantic: "claude-plugin",
    });
  });

  it("plans Claude plugin installs to local and user plugin directories", async () => {
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
      relativeDestPath: ".claude/plugins/demo-plugin",
    });
    expect(localPlan.operations[0]?.destPath).toBe(join(target, ".claude", "plugins", "demo-plugin"));

    const userPlan = await createCombinedInstallPlan([artifact], claudeAdapter, target, undefined, undefined, { installationType: "user" });
    expect(userPlan.targetRoot).toBe(home);
    expect(userPlan.operations).toHaveLength(1);
    expect(userPlan.operations[0]).toMatchObject({
      artifactType: "plugins",
      artifactName: "demo-plugin",
      installName: "demo-plugin",
      relativeDestPath: ".claude/plugins/demo-plugin",
    });
    expect(userPlan.operations[0]?.destPath).toBe(join(home, ".claude", "plugins", "demo-plugin"));
  });
});
