import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { formatPlan } from "../src/cli/format.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, readInstallManifest, uninstall } from "../src/install/index.js";
import type { CombinedInstallPlanOptions } from "../src/install/plan.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = join(testDir, "fixtures", "local-source");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-test-"));
  tempRoots.push(root);
  return root;
}

async function buildPlan(targetRoot: string, options: CombinedInstallPlanOptions = {}) {
  const driver = new LocalSourceDriver();
  const bundle = await stageSource(driver, fixtureSource);
  const manifest = await readInstallManifest(targetRoot, claudeAdapter.name);
  const plan = await createInstallPlan(bundle, claudeAdapter, targetRoot, manifest, undefined, options);
  return { bundle, plan };
}

async function createSixFileSource(): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills", "demo-skill"), { recursive: true });
  await writeFile(join(root, "instructions.md"), "Core instructions\n", "utf8");
  await writeFile(join(root, "rules", "safe-actions.md"), "Safe actions\n", "utf8");
  await writeFile(join(root, "rules", "review.md"), "Review\n", "utf8");
  await writeFile(join(root, "rules", "handoff.md"), "Handoff\n", "utf8");
  await writeFile(join(root, "rules", "memory.md"), "Memory\n", "utf8");
  await writeFile(join(root, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Fixture skill for tests.\n---\n\n# Demo skill\n", "utf8");
  return root;
}

async function buildPlanFromSource(source: string, targetRoot: string) {
  const driver = new LocalSourceDriver();
  const bundle = await stageSource(driver, source);
  const manifest = await readInstallManifest(targetRoot, claudeAdapter.name);
  const plan = await createInstallPlan(bundle, claudeAdapter, targetRoot, manifest);
  return { bundle, plan };
}

describe("install engine", () => {
  it("hashes OpenPack local sources from declared provides instead of the entire root", async () => {
    const source = await tempRoot();
    const driver = new LocalSourceDriver();
    await mkdir(join(source, "skills", "demo"), { recursive: true });
    await mkdir(join(source, "var"), { recursive: true });
    await writeFile(join(source, "openpack.json"), JSON.stringify({
      schemaVersion: 2,
      name: "acme/large-workspace",
      version: "0.1.0",
      provides: [{ type: "skills", path: "skills" }],
    }, null, 2));
    await writeFile(join(source, "skills", "demo", "SKILL.md"), "# Demo\n");
    await writeFile(join(source, "var", "noise.log"), "first\n");

    const before = await driver.resolve(source);
    await writeFile(join(source, "var", "noise.log"), "changed outside openpack provides\n");
    const outsideChange = await driver.resolve(source);
    await writeFile(join(source, "skills", "demo", "SKILL.md"), "# Demo changed\n");
    const providedChange = await driver.resolve(source);

    expect(outsideChange.sourceHash).toBe(before.sourceHash);
    expect(providedChange.sourceHash).not.toBe(before.sourceHash);
  });

  it("plans and applies Claude file-drop artifacts", async () => {
    const targetRoot = await tempRoot();
    const { bundle, plan } = await buildPlan(targetRoot);

    expect(plan.hasBlockingChanges).toBe(false);
    expect(plan.operations.map((operation) => operation.action)).toEqual(["create", "create", "create"]);

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      ".claude/rules/core.md",
      ".claude/skills/demo-skill",
      "CLAUDE.md",
    ]);

    await expect(stat(join(targetRoot, "CLAUDE.md"))).resolves.toBeTruthy();
    await expect(stat(join(targetRoot, ".agentwheel", "claude.local.install-manifest.json"))).resolves.toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("is idempotent after apply", async () => {
    const targetRoot = await tempRoot();
    const first = await buildPlan(targetRoot);
    await applyInstallPlan(first.plan, first.bundle.sourceLock);
    await rm(first.bundle.root, { recursive: true, force: true });

    const second = await buildPlan(targetRoot);
    expect(second.plan.hasBlockingChanges).toBe(false);
    expect(second.plan.operations.map((operation) => operation.action)).toEqual(["skip", "skip", "skip"]);
    await rm(second.bundle.root, { recursive: true, force: true });
  });

  it("detects drift in managed files", async () => {
    const targetRoot = await tempRoot();
    const first = await buildPlan(targetRoot);
    await applyInstallPlan(first.plan, first.bundle.sourceLock);
    await rm(first.bundle.root, { recursive: true, force: true });

    await appendFile(join(targetRoot, ".claude", "rules", "core.md"), "\nmanual change\n", "utf8");
    const drift = await buildPlan(targetRoot);
    expect(drift.plan.hasBlockingChanges).toBe(true);
    expect(drift.plan.operations.find((operation) => operation.relativeDestPath === ".claude/rules/core.md")?.action).toBe("drift");
    await expect(applyInstallPlan(drift.plan, drift.bundle.sourceLock)).rejects.toThrow(/Refusing to apply/);
    await rm(drift.bundle.root, { recursive: true, force: true });
  });

  it("force drift replaces managed artifacts that changed outside agentwheel", async () => {
    const targetRoot = await tempRoot();
    const first = await buildPlan(targetRoot);
    await applyInstallPlan(first.plan, first.bundle.sourceLock);
    await rm(first.bundle.root, { recursive: true, force: true });

    const driftedPath = join(targetRoot, ".claude", "rules", "core.md");
    await appendFile(driftedPath, "\nmanual change\n", "utf8");

    const forced = await buildPlan(targetRoot, { forceDrift: true });
    const operation = forced.plan.operations.find((item) => item.relativeDestPath === ".claude/rules/core.md");
    expect(forced.plan.hasBlockingChanges).toBe(false);
    expect(operation?.action).toBe("update");
    expect(operation?.reason).toContain("force replacing drifted managed destination");

    await applyInstallPlan(forced.plan, forced.bundle.sourceLock);
    expect(await readFile(driftedPath, "utf8")).not.toContain("manual change");
    await rm(forced.bundle.root, { recursive: true, force: true });
  });

  it("force conflict adopts unmanaged artifacts when content already matches", async () => {
    const targetRoot = await tempRoot();
    const initial = await buildPlan(targetRoot);
    const instruction = initial.plan.operations.find((item) => item.relativeDestPath === "CLAUDE.md")!;
    await mkdir(dirname(instruction.destPath), { recursive: true });
    await writeFile(instruction.destPath, await readFile(instruction.sourcePath!, "utf8"), "utf8");

    const blocked = await buildPlan(targetRoot);
    expect(blocked.plan.operations.find((item) => item.relativeDestPath === "CLAUDE.md")?.action).toBe("conflict");
    await rm(blocked.bundle.root, { recursive: true, force: true });

    const forced = await buildPlan(targetRoot, { forceConflict: true });
    const operation = forced.plan.operations.find((item) => item.relativeDestPath === "CLAUDE.md");
    expect(forced.plan.hasBlockingChanges).toBe(false);
    expect(operation?.action).toBe("skip");
    expect(operation?.reason).toContain("force adopting unmanaged destination");

    const manifest = await applyInstallPlan(forced.plan, forced.bundle.sourceLock);
    expect(manifest.entries.map((entry) => entry.path)).toContain("CLAUDE.md");

    await rm(initial.bundle.root, { recursive: true, force: true });
    await rm(forced.bundle.root, { recursive: true, force: true });
  });

  it("replace conflict overwrites unmanaged artifacts that differ", async () => {
    const targetRoot = await tempRoot();
    const initial = await buildPlan(targetRoot);
    const instruction = initial.plan.operations.find((item) => item.relativeDestPath === "CLAUDE.md")!;
    await mkdir(dirname(instruction.destPath), { recursive: true });
    await writeFile(instruction.destPath, "manual unmanaged content\n", "utf8");

    const forced = await buildPlan(targetRoot, { replaceConflict: true });
    const operation = forced.plan.operations.find((item) => item.relativeDestPath === "CLAUDE.md");
    expect(forced.plan.hasBlockingChanges).toBe(false);
    expect(operation?.action).toBe("update");
    expect(operation?.reason).toContain("force replacing unmanaged destination");

    await applyInstallPlan(forced.plan, forced.bundle.sourceLock);
    expect(await readFile(instruction.destPath, "utf8")).not.toContain("manual unmanaged content");

    await rm(initial.bundle.root, { recursive: true, force: true });
    await rm(forced.bundle.root, { recursive: true, force: true });
  });

  it("uninstalls managed artifacts when there is no drift", async () => {
    const targetRoot = await tempRoot();
    const first = await buildPlan(targetRoot);
    await applyInstallPlan(first.plan, first.bundle.sourceLock);
    await rm(first.bundle.root, { recursive: true, force: true });

    const manifest = await readInstallManifest(targetRoot, claudeAdapter.name);
    expect(manifest).toBeTruthy();
    const plan = await createUninstallPlan(manifest!);
    expect(plan.operations.map((operation) => operation.action)).toEqual(["remove", "remove", "remove"]);

    await uninstall(plan, false);
    await expect(stat(join(targetRoot, "CLAUDE.md"))).rejects.toThrow();
    expect(await readInstallManifest(targetRoot, claudeAdapter.name)).toBeUndefined();
  });

  it("uninstalls clean managed artifacts and keeps drifted files by default", async () => {
    const source = await createSixFileSource();
    const targetRoot = await tempRoot();
    const first = await buildPlanFromSource(source, targetRoot);
    const manifest = await applyInstallPlan(first.plan, first.bundle.sourceLock);
    expect(manifest.entries).toHaveLength(6);
    await rm(first.bundle.root, { recursive: true, force: true });

    const driftedPath = join(targetRoot, ".claude", "rules", "safe-actions.md");
    await appendFile(driftedPath, "\nmanual change\n", "utf8");

    const uninstallPlan = await createUninstallPlan((await readInstallManifest(targetRoot, claudeAdapter.name))!);
    expect(uninstallPlan.hasBlockingChanges).toBe(false);
    expect(uninstallPlan.operations.filter((operation) => operation.action === "remove")).toHaveLength(5);
    expect(uninstallPlan.operations.filter((operation) => operation.action === "keep")).toHaveLength(1);
    expect(formatPlan(uninstallPlan)).toContain("KEEP");
    expect(formatPlan(uninstallPlan)).toContain("remove 5, keep 1, drift 0");

    const result = await uninstall(uninstallPlan, { dryRun: false });
    expect(result).toEqual({ removed: 5, kept: 1, removedDrifted: 0 });
    await expect(stat(driftedPath)).resolves.toBeTruthy();
    await expect(stat(join(targetRoot, "CLAUDE.md"))).rejects.toThrow();

    const partialManifest = await readInstallManifest(targetRoot, claudeAdapter.name);
    expect(partialManifest?.entries.map((entry) => entry.path)).toEqual([".claude/rules/safe-actions.md"]);
    const secondPlan = await createUninstallPlan(partialManifest!);
    expect(secondPlan.operations.map((operation) => operation.action)).toEqual(["keep"]);
  });

  it("uninstall force removes drifted managed artifacts", async () => {
    const source = await createSixFileSource();
    const targetRoot = await tempRoot();
    const first = await buildPlanFromSource(source, targetRoot);
    const manifest = await applyInstallPlan(first.plan, first.bundle.sourceLock);
    expect(manifest.entries).toHaveLength(6);
    await rm(first.bundle.root, { recursive: true, force: true });

    const driftedPath = join(targetRoot, ".claude", "rules", "safe-actions.md");
    await appendFile(driftedPath, "\nmanual change\n", "utf8");

    const uninstallPlan = await createUninstallPlan((await readInstallManifest(targetRoot, claudeAdapter.name))!);
    const result = await uninstall(uninstallPlan, { force: true });
    expect(result).toEqual({ removed: 6, kept: 0, removedDrifted: 1 });
    await expect(stat(driftedPath)).rejects.toThrow();
    expect(await readInstallManifest(targetRoot, claudeAdapter.name)).toBeUndefined();
  });
});
