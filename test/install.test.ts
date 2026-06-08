import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, readInstallManifest, uninstall } from "../src/install/index.js";
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
  const root = await mkdtemp(join(tmpdir(), "agentweave-test-"));
  tempRoots.push(root);
  return root;
}

async function buildPlan(targetRoot: string) {
  const driver = new LocalSourceDriver();
  const bundle = await stageSource(driver, fixtureSource);
  const manifest = await readInstallManifest(targetRoot, openClawAdapter.name);
  const plan = await createInstallPlan(bundle, openClawAdapter, targetRoot, manifest);
  return { bundle, plan };
}

describe("install engine", () => {
  it("plans and applies OpenClaw file-drop artifacts", async () => {
    const targetRoot = await tempRoot();
    const { bundle, plan } = await buildPlan(targetRoot);

    expect(plan.hasBlockingChanges).toBe(false);
    expect(plan.operations.map((operation) => operation.action)).toEqual(["create", "create", "create"]);

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      ".openclaw/AGENTS.md",
      ".openclaw/rules/core.md",
      ".openclaw/skills/demo-skill",
    ]);

    await expect(stat(join(targetRoot, ".openclaw", "AGENTS.md"))).resolves.toBeTruthy();
    await expect(stat(join(targetRoot, ".agentweave", "openclaw.install-manifest.json"))).resolves.toBeTruthy();
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

    await appendFile(join(targetRoot, ".openclaw", "rules", "core.md"), "\nmanual change\n", "utf8");
    const drift = await buildPlan(targetRoot);
    expect(drift.plan.hasBlockingChanges).toBe(true);
    expect(drift.plan.operations.find((operation) => operation.relativeDestPath === ".openclaw/rules/core.md")?.action).toBe("drift");
    await expect(applyInstallPlan(drift.plan, drift.bundle.sourceLock)).rejects.toThrow(/Refusing to apply/);
    await rm(drift.bundle.root, { recursive: true, force: true });
  });

  it("uninstalls managed artifacts when there is no drift", async () => {
    const targetRoot = await tempRoot();
    const first = await buildPlan(targetRoot);
    await applyInstallPlan(first.plan, first.bundle.sourceLock);
    await rm(first.bundle.root, { recursive: true, force: true });

    const manifest = await readInstallManifest(targetRoot, openClawAdapter.name);
    expect(manifest).toBeTruthy();
    const plan = await createUninstallPlan(manifest!);
    expect(plan.operations.map((operation) => operation.action)).toEqual(["remove", "remove", "remove"]);

    await uninstall(plan, false);
    await expect(stat(join(targetRoot, ".openclaw", "AGENTS.md"))).rejects.toThrow();
    expect(await readInstallManifest(targetRoot, openClawAdapter.name)).toBeUndefined();
  });
});

