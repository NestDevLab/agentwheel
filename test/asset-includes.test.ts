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

async function tempRoot(prefix = "agentwheel-assets-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createPackage(): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await mkdir(join(root, "skills", "beta"), { recursive: true });
  await mkdir(join(root, "packages", "tmux-bridge", "bin"), { recursive: true });
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n", "utf8");
  await writeFile(join(root, "skills", "beta", "SKILL.md"), "# Beta\n", "utf8");
  await writeFile(join(root, "packages", "tmux-bridge", "bin", "agent-send.sh"), "#!/bin/bash\necho send\n", "utf8");
  await writeFile(join(root, "packages", "tmux-bridge", "bin", "agent-read.sh"), "#!/bin/bash\necho read\n", "utf8");
  await writeFile(join(root, "packages", "tmux-bridge", "bin", "README.txt"), "not included\n", "utf8");
  await chmod(join(root, "packages", "tmux-bridge", "bin", "agent-send.sh"), 0o755);
  await chmod(join(root, "packages", "tmux-bridge", "bin", "agent-read.sh"), 0o755);
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "asset-package",
    version: "1.0.0",
    provides: [
      {
        type: "skills",
        path: "skills",
        assets: [
          {
            from: "packages/tmux-bridge/bin",
            into: "bin",
            include: ["*.sh"],
            mode: "preserve",
          },
        ],
      },
    ],
  }, null, 2), "utf8");
  return root;
}

describe("asset includes", () => {
  it("composes shared assets into each staged skill and includes them in hashes", async () => {
    const source = await createPackage();
    const bundle = await stageSource(new LocalSourceDriver(), source);

    expect(bundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`).sort()).toEqual([
      "skills:alpha",
      "skills:beta",
    ]);
    for (const skill of ["alpha", "beta"]) {
      const sendPath = join(bundle.root, "skills", skill, "bin", "agent-send.sh");
      await expect(stat(sendPath)).resolves.toBeTruthy();
      expect(await readFile(sendPath, "utf8")).toContain("echo send");
      await expect(stat(join(bundle.root, "skills", skill, "bin", "README.txt"))).rejects.toThrow();
    }

    const alpha = bundle.artifacts.find((artifact) => artifact.name === "alpha");
    expect(alpha?.hash).toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("preserves executable assets after sync and remains idempotent", async () => {
    const source = await createPackage();
    const target = await tempRoot();
    const driver = new LocalSourceDriver();
    const first = await stageSource(driver, source);
    const firstPlan = await createInstallPlan(first, openClawAdapter, target);
    await applyInstallPlan(firstPlan, first.sourceLock);
    await rm(first.root, { recursive: true, force: true });

    const installedScript = join(target, "skills", "alpha", "bin", "agent-send.sh");
    expect((await stat(installedScript)).mode & 0o111).toBeTruthy();

    const second = await stageSource(driver, source);
    const secondPlan = await createInstallPlan(second, openClawAdapter, target, await readInstallManifest(target, openClawAdapter.name));
    expect(secondPlan.operations.map((operation) => operation.action)).toEqual(["skip", "skip"]);
    await rm(second.root, { recursive: true, force: true });
  });

  it("detects drift when an installed included asset changes", async () => {
    const source = await createPackage();
    const target = await tempRoot();
    const driver = new LocalSourceDriver();
    const first = await stageSource(driver, source);
    await applyInstallPlan(await createInstallPlan(first, openClawAdapter, target), first.sourceLock);
    await rm(first.root, { recursive: true, force: true });

    await writeFile(join(target, "skills", "alpha", "bin", "agent-send.sh"), "#!/bin/bash\necho changed\n", "utf8");
    const second = await stageSource(driver, source);
    const secondPlan = await createInstallPlan(second, openClawAdapter, target, await readInstallManifest(target, openClawAdapter.name));
    expect(secondPlan.operations.find((operation) => operation.artifactName === "alpha")?.action).toBe("drift");
    await rm(second.root, { recursive: true, force: true });
  });
});
