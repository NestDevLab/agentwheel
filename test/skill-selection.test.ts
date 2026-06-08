import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, readInstallManifest } from "../src/install/index.js";
import { createSourcePlan } from "../src/lifecycle/source-plan.js";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../src/model/workspace.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-skill-selection-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createPackage(): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await mkdir(join(root, "skills", "beta"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "shared", "bin"), { recursive: true });
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n", "utf8");
  await writeFile(join(root, "skills", "beta", "SKILL.md"), "# Beta\n", "utf8");
  await writeFile(join(root, "rules", "core.md"), "# Core\n", "utf8");
  await writeFile(join(root, "rules", "optional.md"), "# Optional\n", "utf8");
  await writeFile(join(root, "shared", "bin", "tool.sh"), "#!/bin/bash\necho tool\n", "utf8");
  await chmod(join(root, "shared", "bin", "tool.sh"), 0o755);
  await writeFile(join(root, "agentwheel.json"), JSON.stringify({
    schemaVersion: 1,
    name: "selection-package",
    version: "1.0.0",
    provides: [
      {
        type: "rules",
        path: "rules/core.md",
        required: true,
      },
      {
        type: "rules",
        path: "rules/optional.md",
      },
      {
        type: "skills",
        path: "skills",
        assets: [
          {
            from: "shared/bin",
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

describe("artifact selection", () => {
  it("installs all artifacts by default", async () => {
    const source = await createPackage();
    const target = await tempRoot();
    const bundle = await stageSource(new LocalSourceDriver(), source);
    await applyInstallPlan(await createInstallPlan(bundle, openClawAdapter, target), bundle.sourceLock);

    await expect(stat(join(target, ".openclaw", "skills", "alpha", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".openclaw", "skills", "beta", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".openclaw", "rules", "core.md"))).resolves.toBeTruthy();
    await expect(stat(join(target, ".openclaw", "rules", "optional.md"))).resolves.toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("installs selected skills and always includes required artifacts", async () => {
    const source = await createPackage();
    const target = await tempRoot();
    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/beta"] });
    expect(bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["rules/core.md", "skills/beta"]);

    await applyInstallPlan(await createInstallPlan(bundle, openClawAdapter, target), bundle.sourceLock);
    const tool = join(target, ".openclaw", "skills", "beta", "bin", "tool.sh");
    await expect(stat(join(target, ".openclaw", "skills", "alpha", "SKILL.md"))).rejects.toThrow();
    await expect(stat(join(target, ".openclaw", "rules", "optional.md"))).rejects.toThrow();
    await expect(stat(join(target, ".openclaw", "rules", "core.md"))).resolves.toBeTruthy();
    expect(await readFile(join(target, ".openclaw", "skills", "beta", "SKILL.md"), "utf8")).toContain("Beta");
    expect((await stat(tool)).mode & 0o111).toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("selects non-skill artifacts", async () => {
    const source = await createPackage();
    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["rules/optional.md"] });
    expect(bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["rules/core.md", "rules/optional.md"]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("selects a mixed artifact set", async () => {
    const source = await createPackage();
    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/beta", "rules/optional.md"] });
    expect(bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["rules/core.md", "rules/optional.md", "skills/beta"]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("keeps --skill compatible as a shortcut", async () => {
    const source = await createPackage();
    const bundle = await stageSource(new LocalSourceDriver(), source, { skills: ["beta"] });
    expect(bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["rules/core.md", "skills/beta"]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("errors clearly when a selected artifact is not provided", async () => {
    const source = await createPackage();
    await expect(stageSource(new LocalSourceDriver(), source, { select: ["rules/missing.md"] })).rejects.toThrow(/Selected artifact not found in package: rules\/missing.md/);
  });

  it("persists selected artifacts in workspace config and reuses them for sync planning", async () => {
    const source = await createPackage();
    const workspace = await tempRoot();
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      profiles: {},
      agents: {},
      packages: [
        {
          name: "selection-package",
          source,
          driver: "local",
          adapter: "openclaw",
          mode: "pinned",
          select: ["skills/alpha"],
        },
      ],
    });

    const config = await readWorkspaceConfig(workspace);
    expect(config.packages[0]?.select).toEqual(["skills/alpha"]);
    const pkg = config.packages[0]!;
    const result = await createSourcePlan({
      source: pkg.source,
      driver: pkg.driver,
      adapter: openClawAdapter,
      targetRoot: workspace,
      workspaceRoot: workspace,
      select: pkg.select,
    });
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/rules/core.md", ".openclaw/skills/alpha"]);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("keeps legacy workspace skills selection compatible", async () => {
    const source = await createPackage();
    const workspace = await tempRoot();
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      profiles: {},
      agents: {},
      packages: [
        {
          name: "selection-package",
          source,
          driver: "local",
          adapter: "openclaw",
          mode: "pinned",
          skills: ["alpha"],
        },
      ],
    });

    const config = await readWorkspaceConfig(workspace);
    const pkg = config.packages[0]!;
    const result = await createSourcePlan({
      source: pkg.source,
      driver: pkg.driver,
      adapter: openClawAdapter,
      targetRoot: workspace,
      workspaceRoot: workspace,
      skills: pkg.skills,
    });
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/rules/core.md", ".openclaw/skills/alpha"]);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("uninstall plans only installed selected artifacts because the manifest only tracks that subset", async () => {
    const source = await createPackage();
    const target = await tempRoot();
    const bundle = await stageSource(new LocalSourceDriver(), source, { select: ["skills/alpha"] });
    await applyInstallPlan(await createInstallPlan(bundle, openClawAdapter, target), bundle.sourceLock);
    await rm(bundle.root, { recursive: true, force: true });

    const manifest = await readInstallManifest(target, openClawAdapter.name);
    expect(manifest?.entries.map((entry) => entry.path)).toEqual([".openclaw/rules/core.md", ".openclaw/skills/alpha"]);
    const uninstallPlan = await createUninstallPlan(manifest!);
    expect(uninstallPlan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/rules/core.md", ".openclaw/skills/alpha"]);
  });
});
