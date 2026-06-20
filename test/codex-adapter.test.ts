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
      dest: "plugins",
      semantic: "codex-plugin",
    });
    expect(codexAdapter.targets.plugins?.user).toMatchObject({
      root: "home",
      dest: ".codex/plugins",
      semantic: "codex-plugin",
    });
    expect(codexAdapter.targets.rules).toBeUndefined();
  });

  it("plans Codex plugin installs to local and user plugin directories", async () => {
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
      relativeDestPath: "plugins/demo-plugin",
    });
    expect(localPlan.operations[0]?.destPath).toBe(join(target, "plugins", "demo-plugin"));

    const userPlan = await createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "user" });
    expect(userPlan.targetRoot).toBe(home);
    expect(userPlan.operations).toHaveLength(1);
    expect(userPlan.operations[0]).toMatchObject({
      artifactType: "plugins",
      artifactName: "demo-plugin",
      installName: "demo-plugin",
      relativeDestPath: ".codex/plugins/demo-plugin",
    });
    expect(userPlan.operations[0]?.destPath).toBe(join(home, ".codex", "plugins", "demo-plugin"));
  });

  it("rejects behavioral rules through the built-in Codex adapter", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const artifact = await ruleArtifact(source);

    await expect(createCombinedInstallPlan([artifact], codexAdapter, target, undefined, undefined, { installationType: "local" }))
      .rejects.toThrow(/Adapter codex does not support rules artifacts for any installation type/);
  });
});
