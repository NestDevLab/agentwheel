import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stateKeyFor } from "../src/install/paths.js";
import { workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";
import { computeTargetFingerprint } from "../src/model/graph-lock.js";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "dist", "index.js");
const tempRoots: string[] = [];
let cliHome: string;

beforeAll(async () => {
  cliHome = await tempRoot("agentwheel-cli-consumers-home-");
  await ensureCliBuild(cli);
});

afterEach(async () => {
  await Promise.all(tempRoots.filter((path) => path !== cliHome).map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.splice(1);
  await Promise.all([
    rm(join(cliHome, ".agentwheel"), { recursive: true, force: true }),
    rm(join(cliHome, ".agents"), { recursive: true, force: true }),
    rm(join(cliHome, ".codex"), { recursive: true, force: true }),
  ]);
});

afterAll(async () => {
  await rm(cliHome, { recursive: true, force: true });
});

describe("released target state CLI consumers", () => {
  it("migrates released state during a scoped package update without losing its sibling", async () => {
    const workspace = await tempRoot("agentwheel-cli-released-package-");
    const alpha = await gitSkillPackage("released-package-alpha", { "released-alpha": "alpha-v1" });
    const beta = await gitSkillPackage("released-package-beta", { "released-beta": "beta-v1" });
    await addTrackingPackage(workspace, alpha, "released-package-alpha");
    await addTrackingPackage(workspace, beta, "released-package-beta");
    await installWorkspace(workspace);
    const released = await moveInstalledStateToReleasedPaths(workspace);

    await updateGitSkills(alpha, { "released-alpha": "alpha-v2" });
    await updateGitSkills(beta, { "released-beta": "beta-v2" });
    const update = await runCli([
      "update", "released-package-alpha", "--adapter", "codex", "--installation-type", "local",
      "--target-root", workspace, "--only-source",
    ]);

    expect(update.stdout).toContain("UPDATE   MANAGED  skills/released-alpha");
    await expect(readFile(skillPath(workspace, "released-alpha"), "utf8")).resolves.toContain("alpha-v2");
    await expect(readFile(skillPath(workspace, "released-beta"), "utf8")).resolves.toContain("beta-v1");
    expect((await readJson(released.stableManifestPath)).entries.map((entry: { artifactName: string }) => entry.artifactName).sort())
      .toEqual(["released-alpha", "released-beta"]);
    await expect(stat(released.legacyManifestPath)).rejects.toThrow();
    await expect(stat(released.legacyGraphPath)).rejects.toThrow();
  }, 30_000);

  it("migrates released state during a focused skill update without losing sibling artifacts", async () => {
    const workspace = await tempRoot("agentwheel-cli-released-skill-");
    const source = await gitSkillPackage("released-skill-bundle", {
      "released-focus": "focus-v1",
      "released-sibling": "sibling-v1",
    });
    await addTrackingPackage(workspace, source, "released-skill-bundle");
    await installWorkspace(workspace);
    const released = await moveInstalledStateToReleasedPaths(workspace);

    await updateGitSkills(source, {
      "released-focus": "focus-v2",
      "released-sibling": "sibling-v2",
    });
    const update = await runCli([
      "skill", "update", "released-focus", "--adapter", "codex", "--installation-type", "local",
      "--target-root", workspace,
    ]);

    expect(update.stdout).toContain("UPDATE   MANAGED  skills/released-focus");
    await expect(readFile(skillPath(workspace, "released-focus"), "utf8")).resolves.toContain("focus-v2");
    await expect(readFile(skillPath(workspace, "released-sibling"), "utf8")).resolves.toContain("sibling-v1");
    expect((await readJson(released.stableManifestPath)).entries.map((entry: { artifactName: string }) => entry.artifactName).sort())
      .toEqual(["released-focus", "released-sibling"]);
    await expect(stat(released.legacyManifestPath)).rejects.toThrow();
    await expect(stat(released.legacyGraphPath)).rejects.toThrow();
  }, 30_000);

  it("migrates released state during a dependency update while unrelated dependencies stay locked", async () => {
    const workspace = await tempRoot("agentwheel-cli-released-dependency-");
    const alpha = await gitSkillPackage("released-dependency-alpha", { "released-dep-alpha": "alpha-v1" });
    const beta = await gitSkillPackage("released-dependency-beta", { "released-dep-beta": "beta-v1" });
    const root = await metaPackage("released-dependency-root", {
      alpha: { source: `git:${alpha}#main`, mode: "tracking", select: ["skills/released-dep-alpha"] },
      beta: { source: `git:${beta}#main`, mode: "tracking", select: ["skills/released-dep-beta"] },
    });
    await runCli([
      "add", root, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    await installWorkspace(workspace);
    const released = await moveInstalledStateToReleasedPaths(workspace);

    await updateGitSkills(alpha, { "released-dep-alpha": "alpha-v2" });
    await updateGitSkills(beta, { "released-dep-beta": "beta-v2" });
    const update = await runCli([
      "update", "--dependency", "released-dependency-alpha", "--adapter", "codex",
      "--installation-type", "local", "--target-root", workspace,
    ]);

    expect(update.stdout).toContain("UPDATE   MANAGED  skills/released-dep-alpha");
    await expect(readFile(skillPath(workspace, "released-dep-alpha"), "utf8")).resolves.toContain("alpha-v2");
    await expect(readFile(skillPath(workspace, "released-dep-beta"), "utf8")).resolves.toContain("beta-v1");
    expect((await readJson(released.stableManifestPath)).entries.map((entry: { artifactName: string }) => entry.artifactName).sort())
      .toEqual(["released-dep-alpha", "released-dep-beta"]);
    await expect(stat(released.legacyManifestPath)).rejects.toThrow();
    await expect(stat(released.legacyGraphPath)).rejects.toThrow();
  }, 30_000);

  it("reports a released-state skill as managed in doctor", async () => {
    const fixture = await installedReleasedSkill("released-doctor-pack", "released-doctor-skill");

    const report = JSON.parse((await runCli([
      "doctor", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
      "--skill", fixture.skillName, "--source", fixture.source, "--json",
    ])).stdout);

    expect(report.manifest).toMatchObject({ entries: 1 });
    expect(report.skills).toEqual([
      expect.objectContaining({ name: fixture.skillName, status: "managed", managed: true, present: true }),
    ]);
  }, 30_000);

  it("refuses ownership handoff from released state with an explicit migrate-first instruction", async () => {
    const fixture = await installedReleasedSkill("released-ownership-pack", "released-ownership-skill");
    const destinationOwner = await tempRoot("agentwheel-cli-ownership-destination-");
    const before = await releasedStateBytes(fixture.released);

    await expect(runCli([
      "ownership", "handoff", `skills/${fixture.skillName}`,
      "--from-workspace-root", fixture.workspace,
      "--to-workspace-root", destinationOwner,
      "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
      "--dry-run",
    ])).rejects.toMatchObject({ stderr: expect.stringMatching(/migrate.*target state.*before.*ownership/i) });

    expect(await releasedStateBytes(fixture.released)).toEqual(before);
  }, 30_000);

  it("lists and aborts a released-state pending apply journal", async () => {
    const fixture = await installedReleasedSkill("released-journal-pack", "released-journal-skill");
    await writeReleasedJournal(fixture.released);
    const manifestBefore = await readFile(fixture.released.legacyManifestPath, "utf8");
    const graphBefore = await readFile(fixture.released.legacyGraphPath, "utf8");

    const listed = await runCli([
      "journal", "list", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);
    expect(listed.stdout).toContain("PENDING codex/local");
    expect(listed.stdout).toContain(`stateKey: ${fixture.released.legacyStateKey}`);

    const aborted = await runCli([
      "journal", "abort", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);
    expect(aborted.stdout).toContain("Archived codex/local pending journal:");
    await expect(stat(fixture.released.legacyJournalPath)).rejects.toThrow();
    const archives = await readdir(join(fixture.workspace, ".agentwheel", "archive"));
    expect(archives.some((name) => name.startsWith(`${fixture.released.legacyStateKey}.apply-journal.failed-`))).toBe(true);
    await expect(readFile(fixture.released.legacyManifestPath, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(fixture.released.legacyGraphPath, "utf8")).resolves.toBe(graphBefore);
  }, 30_000);

  it("recovers a released-state pending journal before migrating an install", async () => {
    const fixture = await installedReleasedSkill("released-recovery-pack", "released-recovery-skill");
    await writeReleasedJournal(fixture.released);

    const install = await runCli([
      "install", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);

    expect(install.stdout).toContain("Applied codex");
    await expect(stat(fixture.released.legacyJournalPath)).rejects.toThrow();
    await expect(stat(fixture.released.legacyManifestPath)).rejects.toThrow();
    await expect(stat(fixture.released.legacyGraphPath)).rejects.toThrow();
    await expect(stat(fixture.released.stableManifestPath)).resolves.toBeTruthy();
    await expect(stat(fixture.released.stableGraphPath)).resolves.toBeTruthy();
  }, 30_000);

  it("fully uninstalls released state and leaves status and reinstall planning usable", async () => {
    const fixture = await installedReleasedSkill("released-full-uninstall-pack", "released-full-uninstall-skill");

    const removed = await runCli([
      "uninstall", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);

    expect(removed.stdout).toContain("Removed 1 managed file");
    await expect(readFile(skillPath(fixture.workspace, fixture.skillName), "utf8")).rejects.toThrow();
    for (const path of releasedPersistentPaths(fixture.released)) {
      await expect(stat(path)).rejects.toThrow();
    }

    const status = await runCli([
      "status", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);
    expect(status.stdout).toContain("Install manifest: missing");
    expect(status.stdout).not.toContain("unavailable");
    const replan = await runCli([
      "install", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace, "--dry-run",
    ]);
    expect(replan.stdout).toContain("CREATE");
    expect(replan.stdout).toContain(fixture.skillName);
    for (const path of releasedPersistentPaths(fixture.released)) {
      await expect(stat(path)).rejects.toThrow();
    }
  }, 30_000);

  it("migrates remaining released state transactionally during package uninstall", async () => {
    const workspace = await tempRoot("agentwheel-cli-released-package-uninstall-");
    const alpha = await localSkillPackage("released-uninstall-alpha", "released-uninstall-alpha-skill", "alpha-v1");
    const beta = await localSkillPackage("released-uninstall-beta", "released-uninstall-beta-skill", "beta-v1");
    await runCli(["add", alpha, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await installWorkspace(workspace);
    const released = await moveInstalledStateToReleasedPaths(workspace);

    const removed = await runCli([
      "uninstall", "released-uninstall-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);

    expect(removed.stdout).toContain("Removed 1 managed file");
    await expect(readFile(skillPath(workspace, "released-uninstall-alpha-skill"), "utf8")).rejects.toThrow();
    await expect(readFile(skillPath(workspace, "released-uninstall-beta-skill"), "utf8")).resolves.toContain("beta-v1");
    for (const path of [released.legacyManifestPath, released.legacySourceLockPath, released.legacyGraphPath]) {
      await expect(stat(path)).rejects.toThrow();
    }
    const stableManifest = await readJson(released.stableManifestPath);
    expect(stableManifest.entries.map((entry: { artifactName: string }) => entry.artifactName))
      .toEqual(["released-uninstall-beta-skill"]);
    await expect(stat(released.stableGraphPath)).resolves.toBeTruthy();

    const status = await runCli([
      "status", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    expect(status.stdout).toContain("released-uninstall-beta\tpinned\t*\t1.0.0\t1.0.0");
    expect(status.stdout).toContain("Artifacts: 1 locked, 1 installed");
    expect(status.stdout).toContain("Pending install work: none");
    const replan = await runCli([
      "install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(replan.stdout).toContain("SKIP");
    expect(replan.stdout).toContain("released-uninstall-beta-skill");
  }, 30_000);

  it("lists a released journal after its manifest was removed by an interrupted commit", async () => {
    const fixture = await installedReleasedSkill("released-orphan-list-pack", "released-orphan-list-skill");
    await writeReleasedJournal(fixture.released);
    await rm(fixture.released.legacyManifestPath);
    const before = await persistentFileBytes([
      fixture.released.legacyGraphPath,
      fixture.released.legacyJournalPath,
    ]);

    const listed = await runCli([
      "journal", "list", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);

    expect(listed.stdout).toContain("PENDING codex/local");
    expect(listed.stdout).toContain(`stateKey: ${fixture.released.legacyStateKey}`);
    expect(await persistentFileBytes([...before.keys()])).toEqual(before);
  }, 30_000);

  it("aborts a released journal after its manifest was removed without consuming the graph lock", async () => {
    const fixture = await installedReleasedSkill("released-orphan-abort-pack", "released-orphan-abort-skill");
    await writeReleasedJournal(fixture.released);
    await rm(fixture.released.legacyManifestPath);
    const graphBefore = await readFile(fixture.released.legacyGraphPath, "utf8");

    const aborted = await runCli([
      "journal", "abort", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);

    expect(aborted.stdout).toContain("Archived codex/local pending journal:");
    await expect(stat(fixture.released.legacyJournalPath)).rejects.toThrow();
    await expect(readFile(fixture.released.legacyGraphPath, "utf8")).resolves.toBe(graphBefore);
    const archives = await readdir(join(fixture.workspace, ".agentwheel", "archive"));
    expect(archives.some((name) => name.startsWith(`${fixture.released.legacyStateKey}.apply-journal.failed-`))).toBe(true);
  }, 30_000);

  it("recovers and migrates a released journal after its manifest was removed by an interrupted commit", async () => {
    const fixture = await installedReleasedSkill("released-orphan-recover-pack", "released-orphan-recover-skill");
    await writeReleasedJournal(fixture.released);
    await rm(fixture.released.legacyManifestPath);

    const install = await runCli([
      "install", "--adapter", "codex", "--installation-type", "local", "--target-root", fixture.workspace,
    ]);

    expect(install.stdout).toContain("Applied codex");
    for (const path of [
      fixture.released.legacyManifestPath,
      fixture.released.legacySourceLockPath,
      fixture.released.legacyGraphPath,
      fixture.released.legacyJournalPath,
    ]) {
      await expect(stat(path)).rejects.toThrow();
    }
    await expect(stat(fixture.released.stableManifestPath)).resolves.toBeTruthy();
    await expect(stat(fixture.released.stableGraphPath)).resolves.toBeTruthy();
    await expect(readFile(skillPath(fixture.workspace, fixture.skillName), "utf8")).resolves.toContain("released-v1");
  }, 30_000);
});

describe("foreign target state keep semantics", () => {
  it("keeps an exact foreign artifact outside the new manifest while applying a disjoint own artifact", async () => {
    const runtime = await tempRoot("agentwheel-cli-foreign-runtime-");
    const ownerWorkspace = await tempRoot("agentwheel-cli-foreign-owner-");
    const observerWorkspace = await tempRoot("agentwheel-cli-foreign-observer-");
    const foreignSource = await localSkillPackage("foreign-exact-pack", "foreign-exact-skill", "foreign-v1");
    const ownSource = await localSkillPackage("observer-own-pack", "observer-own-skill", "observer-v1");
    await writeProfileConfig(ownerWorkspace, runtime, [packageConfig("foreign-exact-pack", foreignSource)]);
    await writeProfileConfig(observerWorkspace, runtime, [
      packageConfig("foreign-exact-pack", foreignSource),
      packageConfig("observer-own-pack", ownSource),
    ]);

    await runCli(["install", "--profile", "all", "--target-root", ownerWorkspace]);
    const ownerManifest = await manifestOwnedBy(runtime, workspaceOwnerForRoot(ownerWorkspace));
    const ownerBytes = await readFile(ownerManifest.path, "utf8");

    const preview = await runCli(["install", "--profile", "all", "--target-root", observerWorkspace, "--dry-run"]);
    expect(preview.stdout).toContain("KEEP");
    expect(preview.stdout).toContain("foreign-exact-skill");
    expect(preview.stdout).toContain("CREATE");
    expect(preview.stdout).toContain("observer-own-skill");
    await runCli(["install", "--profile", "all", "--target-root", observerWorkspace]);

    await expect(readFile(ownerManifest.path, "utf8")).resolves.toBe(ownerBytes);
    const observerManifest = await manifestOwnedBy(runtime, workspaceOwnerForRoot(observerWorkspace));
    expect(observerManifest.manifest.entries.map((entry: { path: string }) => entry.path))
      .toEqual([".agents/skills/observer-own-skill"]);
    const replan = await runCli(["install", "--profile", "all", "--target-root", observerWorkspace, "--dry-run"]);
    expect(replan.stdout).toContain("KEEP");
    const status = await runCli(["status", "--profile", "all", "--target-root", observerWorkspace]);
    expect(status.stdout).toContain("Pending install work: none");
    await expect(readFile(ownerManifest.path, "utf8")).resolves.toBe(ownerBytes);
  }, 30_000);

  it.each(["drift", "missing"] as const)("refuses an exact foreign claim when runtime bytes are %s", async (condition) => {
    const runtime = await tempRoot(`agentwheel-cli-foreign-${condition}-runtime-`);
    const ownerWorkspace = await tempRoot(`agentwheel-cli-foreign-${condition}-owner-`);
    const observerWorkspace = await tempRoot(`agentwheel-cli-foreign-${condition}-observer-`);
    const source = await localSkillPackage(`foreign-${condition}-pack`, `foreign-${condition}-skill`, "foreign-v1");
    await writeProfileConfig(ownerWorkspace, runtime, [packageConfig(`foreign-${condition}-pack`, source)]);
    await writeProfileConfig(observerWorkspace, runtime, [packageConfig(`foreign-${condition}-pack`, source)]);
    await runCli(["install", "--profile", "all", "--target-root", ownerWorkspace]);
    const runtimePath = join(runtime, ".agents", "skills", `foreign-${condition}-skill`);
    if (condition === "drift") await writeFile(join(runtimePath, "SKILL.md"), "local drift\n", "utf8");
    else await rm(runtimePath, { recursive: true });

    await expect(runCli([
      "install", "--profile", "all", "--target-root", observerWorkspace, "--dry-run",
    ])).rejects.toMatchObject({ stderr: expect.stringMatching(/another workspace|Refusing to plan/i) });
  }, 30_000);

  it("reports mixed own and exact foreign state as installed without claiming the foreign entry", async () => {
    const runtime = await tempRoot("agentwheel-cli-mixed-status-runtime-");
    const ownerWorkspace = await tempRoot("agentwheel-cli-mixed-status-owner-");
    const observerWorkspace = await tempRoot("agentwheel-cli-mixed-status-observer-");
    const foreignSource = await localSkillPackage("mixed-status-foreign", "mixed-status-foreign-skill", "foreign-v1");
    const ownSource = await localSkillPackage("mixed-status-own", "mixed-status-own-skill", "own-v1");
    await writeProfileConfig(ownerWorkspace, runtime, [packageConfig("mixed-status-foreign", foreignSource)]);
    await writeProfileConfig(observerWorkspace, runtime, [
      packageConfig("mixed-status-foreign", foreignSource),
      packageConfig("mixed-status-own", ownSource),
    ]);
    await runCli(["install", "--profile", "all", "--target-root", ownerWorkspace]);
    const ownerManifest = await manifestOwnedBy(runtime, workspaceOwnerForRoot(ownerWorkspace));
    const ownerBefore = await readFile(ownerManifest.path, "utf8");
    await runCli(["install", "--profile", "all", "--target-root", observerWorkspace]);
    const observerManifest = await manifestOwnedBy(runtime, workspaceOwnerForRoot(observerWorkspace));
    const observerBefore = await readFile(observerManifest.path, "utf8");

    const status = await runCli(["status", "--profile", "all", "--target-root", observerWorkspace]);

    expect(status.stdout).toContain("Install manifest: 2 entries");
    expect(status.stdout).toContain("mixed-status-foreign\tpinned\t*\t1.0.0\t1.0.0");
    expect(status.stdout).toContain("mixed-status-own\tpinned\t*\t1.0.0\t1.0.0");
    expect(status.stdout).toContain("Artifacts: 2 locked, 2 installed");
    expect(status.stdout).toContain("Pending install work: none");
    await expect(readFile(ownerManifest.path, "utf8")).resolves.toBe(ownerBefore);
    await expect(readFile(observerManifest.path, "utf8")).resolves.toBe(observerBefore);
    expect(observerManifest.manifest.entries.map((entry: { artifactName: string }) => entry.artifactName))
      .toEqual(["mixed-status-own-skill"]);
  }, 30_000);
});

interface ReleasedPaths {
  stableStateKey: string;
  legacyStateKey: string;
  stableManifestPath: string;
  legacyManifestPath: string;
  stableGraphPath: string;
  legacyGraphPath: string;
  legacyJournalPath: string;
  stableSourceLockPath: string;
  legacySourceLockPath: string;
}

async function installedReleasedSkill(packageName: string, skillName: string) {
  const workspace = await tempRoot(`agentwheel-cli-${packageName}-`);
  const source = await localSkillPackage(packageName, skillName, "released-v1");
  await runCli(["add", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
  await installWorkspace(workspace);
  return { workspace, source, packageName, skillName, released: await moveInstalledStateToReleasedPaths(workspace) };
}

async function moveInstalledStateToReleasedPaths(workspace: string): Promise<ReleasedPaths> {
  const graphFiles = (await filesBelow(join(workspace, ".agentwheel", "locks")))
    .filter((path) => path.endsWith(".graph-lock.json"));
  expect(graphFiles).toHaveLength(1);
  const stableGraphPath = graphFiles[0]!;
  const graphBytes = await readFile(stableGraphPath, "utf8");
  const graph = JSON.parse(graphBytes);
  const legacyFingerprint = computeTargetFingerprint({
    adapter: "codex",
    installationType: "local",
    targetRoot: workspace,
    transport: "local",
  });
  expect(graph.canonical.targetFingerprint).toBe(legacyFingerprint);
  const legacyGraphPath = join(dirname(stableGraphPath), `${legacyFingerprint}.graph-lock.json`);
  expect(legacyGraphPath).not.toBe(stableGraphPath);
  await writeFile(legacyGraphPath, graphBytes, "utf8");
  await rm(stableGraphPath);

  const metadataRoot = join(workspace, ".agentwheel");
  const manifestNames = (await readdir(metadataRoot)).filter((name) => name.endsWith(".install-manifest.json"));
  expect(manifestNames).toHaveLength(1);
  const stableManifestPath = join(metadataRoot, manifestNames[0]!);
  const stableStateKey = manifestNames[0]!.replace(".install-manifest.json", "");
  const legacyStateKey = stateKeyFor("codex", { installationType: "local", targetFingerprint: legacyFingerprint });
  const legacyManifestPath = join(metadataRoot, `${legacyStateKey}.install-manifest.json`);
  expect(legacyManifestPath).not.toBe(stableManifestPath);
  const manifest = JSON.parse(await readFile(stableManifestPath, "utf8"));
  await writeFile(legacyManifestPath, `${JSON.stringify({ ...manifest, stateKey: legacyStateKey }, null, 2)}\n`, "utf8");
  await rm(stableManifestPath);

  const stableSourceLockPath = join(metadataRoot, `${stableStateKey}.source-lock.json`);
  const legacySourceLockPath = join(metadataRoot, `${legacyStateKey}.source-lock.json`);
  try {
    const sourceLock = await readFile(stableSourceLockPath, "utf8");
    await writeFile(legacySourceLockPath, sourceLock, "utf8");
    await rm(stableSourceLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return {
    stableStateKey,
    legacyStateKey,
    stableManifestPath,
    legacyManifestPath,
    stableGraphPath,
    legacyGraphPath,
    legacyJournalPath: join(metadataRoot, `${legacyStateKey}.apply-journal.json`),
    stableSourceLockPath,
    legacySourceLockPath,
  };
}

function releasedPersistentPaths(state: ReleasedPaths): string[] {
  return [
    state.stableManifestPath,
    state.legacyManifestPath,
    state.stableSourceLockPath,
    state.legacySourceLockPath,
    state.stableGraphPath,
    state.legacyGraphPath,
  ];
}

async function writeReleasedJournal(state: ReleasedPaths): Promise<void> {
  const manifest = await readJson(state.legacyManifestPath);
  const graphLock = await readJson(state.legacyGraphPath);
  const operations = manifest.entries.map((entry: Record<string, any>) => ({
    action: "skip",
    artifactType: entry.artifactType,
    artifactName: entry.artifactName,
    installName: entry.installName,
    logicalSelector: entry.logicalSelector,
    graphNodeId: entry.graphNodeId,
    dependencyRole: entry.dependencyRole,
    owners: entry.owners,
    workspaceOwner: entry.workspaceOwner,
    kind: entry.kind,
    destPath: join(manifest.targetRoot, entry.path),
    relativeDestPath: entry.path,
    desiredHash: entry.sourceHash,
    currentHash: entry.hash,
    manifestHash: entry.hash,
    reason: "already up to date",
    channel: entry.channel,
    packageName: entry.packageName,
    composedFrom: entry.composedFrom,
    graphLockDigest: entry.graphLockDigest,
  }));
  await writeFile(state.legacyJournalPath, `${JSON.stringify({
    version: 1,
    mode: "apply",
    adapter: "codex",
    installationType: "local",
    stateKey: state.legacyStateKey,
    targetRoot: manifest.targetRoot,
    baseRevision: manifest.revision,
    graphLockDigest: manifest.entries[0]?.graphLockDigest,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    operations,
    completed: [],
    manifest,
    graphLockPath: state.legacyGraphPath,
    graphLock,
  }, null, 2)}\n`, "utf8");
}

async function releasedStateBytes(state: ReleasedPaths): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all([
    state.legacyManifestPath,
    state.legacyGraphPath,
  ].map(async (path) => [path, await readFile(path, "utf8")] as const)));
}

async function persistentFileBytes(paths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const)));
}

async function addTrackingPackage(workspace: string, source: string, name: string): Promise<void> {
  await runCli([
    "add", `git:${source}#main`, "--name", name, "--mode", "tracking",
    "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
  ]);
}

async function installWorkspace(workspace: string): Promise<void> {
  await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);
}

async function gitSkillPackage(name: string, skills: Record<string, string>): Promise<string> {
  const root = await localSkillPackage(name, skills);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", `${name}-v1`]);
  return root;
}

async function localSkillPackage(name: string, skillName: string, content: string): Promise<string>;
async function localSkillPackage(name: string, skills: Record<string, string>): Promise<string>;
async function localSkillPackage(name: string, skillOrSkills: string | Record<string, string>, content?: string): Promise<string> {
  const root = await tempRoot(`agentwheel-cli-${name}-source-`);
  const skills = typeof skillOrSkills === "string" ? { [skillOrSkills]: content ?? skillOrSkills } : skillOrSkills;
  await writeSkills(root, skills);
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`, "utf8");
  return root;
}

async function updateGitSkills(root: string, skills: Record<string, string>): Promise<void> {
  await writeSkills(root, skills);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", Object.values(skills).join("-")]);
}

async function writeSkills(root: string, skills: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(skills)) {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), [
      "---",
      `name: ${name}`,
      "description: Target state CLI consumer fixture.",
      "---",
      "",
      `# ${content}`,
      "",
    ].join("\n"), "utf8");
  }
}

async function metaPackage(name: string, requires: Record<string, unknown>): Promise<string> {
  const root = await tempRoot(`agentwheel-cli-${name}-source-`);
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires,
  }, null, 2)}\n`, "utf8");
  return root;
}

function packageConfig(name: string, source: string) {
  return { name, source, driver: "local", adapter: "codex", installationType: "local", mode: "pinned" };
}

async function writeProfileConfig(workspace: string, runtime: string, packages: unknown[]): Promise<void> {
  await mkdir(join(workspace, ".agentwheel"), { recursive: true });
  await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify({
    schemaVersion: 2,
    packages,
    registry: {},
    trust: {},
    agents: { runtime: { adapter: "codex", root: runtime, transport: "local", installationType: "local" } },
    profiles: { all: { runtimes: [{ agent: "runtime" }] } },
    exports: { selections: {} },
  }, null, 2)}\n`, "utf8");
}

async function manifestOwnedBy(runtime: string, owner: string): Promise<{ path: string; manifest: any }> {
  const root = join(runtime, ".agentwheel");
  for (const name of (await readdir(root)).filter((entry) => entry.endsWith(".install-manifest.json")).sort()) {
    const path = join(root, name);
    const manifest = await readJson(path);
    if (manifest.entries.some((entry: { workspaceOwner?: string }) => entry.workspaceOwner === owner)) return { path, manifest };
  }
  throw new Error(`Manifest owned by ${owner} not found`);
}

function skillPath(workspace: string, name: string): string {
  return join(workspace, ".agents", "skills", name, "SKILL.md");
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd });
}

async function runCli(args: string[], options: { cwd?: string } = {}) {
  try {
    return await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        HOME: cliHome,
        XDG_CONFIG_HOME: join(cliHome, ".config"),
        XDG_CACHE_HOME: join(cliHome, ".cache"),
        XDG_STATE_HOME: join(cliHome, ".local", "state"),
        AGENTWHEEL_TEST_HOME: "",
      },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw error as { stdout: string; stderr: string; code: number };
  }
}
