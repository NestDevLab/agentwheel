import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const cli = join(process.cwd(), "dist", "index.js");
let cliHome: string;

beforeAll(async () => {
  cliHome = await mkdtemp(join(tmpdir(), "agentwheel-cli-home-"));
  if (await cliBuildIsStale()) {
    await execFileAsync("pnpm", ["build"], { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
  }
});

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
  await cleanCliHomeState();
});

afterAll(async () => {
  if (cliHome) await rm(cliHome, { recursive: true, force: true });
});

describe("CLI verb redesign", () => {
  it("drafts a registry publish submission from a GitHub URL without writing workspace state", async () => {
    const { stdout } = await runCli([
      "registry",
      "publish",
      "https://github.com/Owner/Agent-Pack",
      "--description",
      "Reusable rules and skills for coding agents.",
      "--tag",
      "agents,skills",
    ]);

    expect(stdout).toContain("Draft registry entry:");
    expect(stdout).toContain('"name": "agent-pack"');
    expect(stdout).toContain('"source": "github:Owner/Agent-Pack"');
    expect(stdout).toContain("agentwheel install github:Owner/Agent-Pack --adapter codex --local --dry-run");
    expect(stdout).toContain("https://github.com/NestDevLab/agentwheel-registry/issues/new");
    await expect(stat(join(cliHome, ".agentwheel"))).rejects.toThrow();
  });

  it("doctor suggests the Copilot user companion skill install without writing files", async () => {
    const { stdout } = await runCli(["doctor", "--adapter", "copilot", "--user"]);

    expect(stdout).toContain("Agentwheel companion skill: missing");
    expect(stdout).toContain("agentwheel install github:NestDevLab/agentwheel --adapter copilot --user --skill agentwheel --dry-run");
    expect(stdout).toContain("agentwheel install github:NestDevLab/agentwheel --adapter copilot --user --skill agentwheel");
    await expect(stat(join(cliHome, ".copilot"))).rejects.toThrow();
  });

  it("doctor detects an installed Copilot user companion skill", async () => {
    await mkdir(join(cliHome, ".copilot", "skills", "agentwheel"), { recursive: true });
    await writeFile(join(cliHome, ".copilot", "skills", "agentwheel", "SKILL.md"), "# Agentwheel\n", "utf8");

    const { stdout } = await runCli(["doctor", "--adapter", "copilot", "--user"]);

    expect(stdout).toContain("Agentwheel companion skill: installed");
    expect(stdout).not.toContain("Suggested commands:");
  });

  it("doctor reports explicit Syncwheel skill status as JSON without writing files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".syncwheel"), { recursive: true });
    await writeFile(join(root, ".syncwheel", "manifest.json"), "{}\n", "utf8");

    const { stdout } = await runCli([
      "doctor",
      "--adapter",
      "codex",
      "--local",
      "--target-root",
      root,
      "--skill",
      "syncwheel",
      "--source",
      "github:NestDevLab/syncwheel",
      "--json",
    ]);
    const report = JSON.parse(stdout);

    expect(report.adapter).toBe("codex");
    expect(report.installationType).toBe("local");
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).toMatchObject({
      name: "syncwheel",
      source: "github:NestDevLab/syncwheel",
      status: "missing",
      managed: false,
      present: false,
    });
    expect(report.skills[0].suggestedCommands.dryRun).toContain("agentwheel install github:NestDevLab/syncwheel --adapter codex --local");
    expect(report.skills[0].suggestedCommands.dryRun).toContain(`--target-root ${root}`);
    expect(report.skills[0].suggestedCommands.dryRun).toContain("--skill syncwheel --dry-run");
    await expect(stat(join(root, ".agents"))).rejects.toThrow();
  });

  it("doctor suggests Syncwheel skill automatically inside Syncwheel-managed workspaces", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".syncwheel"), { recursive: true });
    await writeFile(join(root, ".syncwheel", "manifest.json"), "{}\n", "utf8");

    const { stdout } = await runCli(["doctor", "--adapter", "codex", "--local", "--target-root", root]);

    expect(stdout).toContain("Agentwheel companion skill: missing");
    expect(stdout).toContain("Syncwheel skill: missing");
    expect(stdout).toContain("agentwheel install github:NestDevLab/syncwheel --adapter codex --local");
  });

  it("ensures a new source with install <source> and hides the sync shim from top-level help", async () => {
    const root = await tempRoot();
    const source = await packageFixture("ensure");
    const { stdout } = await runCli(["install", source, "--adapter", "codex", "--installation-type", "local", "--target-root", root]);

    expect(stdout).toContain("Applied codex");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("ensure");
    const config = JSON.parse(await readFile(join(root, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages[0].source).toBe(source);

    const help = await runCli(["--help"]);
    expect(help.stdout).toContain("install [options] [name-or-source]");
    expect(help.stdout).not.toContain(" sync ");
  });

  it("installs a new source into every detected runtime with --all-detected", async () => {
    const root = await tempRoot();
    const source = await packageFixture("detected");
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });

    const { stdout } = await runCli(["install", source, "--target-root", root, "--installation-type", "local", "--all-detected"]);

    expect(stdout).toContain("Applied claude");
    expect(stdout).toContain("Applied codex");
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toContain("detected");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("detected");
  });

  it("installs a new source into comma-separated adapters with distinct saved package entries", async () => {
    const root = await tempRoot();
    const source = await packageFixture("multi");

    const { stdout } = await runCli(["install", source, "--adapter", "codex,claude", "--installation-type", "local", "--target-root", root]);

    expect(stdout).toContain("Applied codex");
    expect(stdout).toContain("Applied claude");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("multi");
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toContain("multi");

    const config = JSON.parse(await readFile(join(root, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages.map((pkg: { name: string; adapter: string }) => [pkg.name, pkg.adapter])).toEqual([
      ["multi-claude", "claude"],
      ["multi-codex", "codex"],
    ]);
  });

  it("defaults explicit source installs with explicit adapters to user-scoped targets", async () => {
    const source = await packageFixture("global-default");

    const { stdout } = await runCli(["install", source, "--adapter", "codex,claude"]);

    expect(stdout).toContain("Applied codex");
    expect(stdout).toContain("Applied claude");
    await expect(readFile(join(cliHome, ".codex", "AGENTS.md"), "utf8")).resolves.toContain("global-default");
    await expect(readFile(join(cliHome, ".claude", "CLAUDE.md"), "utf8")).resolves.toContain("global-default");

    const config = JSON.parse(await readFile(join(cliHome, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages.map((pkg: { name: string; adapter: string; installationType: string }) => [pkg.name, pkg.adapter, pkg.installationType])).toContainEqual([
      "global-default-codex",
      "codex",
      "user",
    ]);
    expect(config.packages.map((pkg: { name: string; adapter: string; installationType: string }) => [pkg.name, pkg.adapter, pkg.installationType])).toContainEqual([
      "global-default-claude",
      "claude",
      "user",
    ]);
  });

  it("infers local installation type from a non-home target root", async () => {
    const root = await tempRoot();
    const source = await packageFixture("target-local");

    const { stdout } = await runCli(["install", source, "--adapter", "codex,claude", "-t", root]);

    expect(stdout).toContain("Applied codex");
    expect(stdout).toContain("Applied claude");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("target-local");
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toContain("target-local");

    const config = JSON.parse(await readFile(join(root, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages.map((pkg: { installationType: string }) => pkg.installationType)).toEqual(["local", "local"]);
  });

  it("supports --user, --local, and -i installation type shortcuts", async () => {
    const userSource = await packageFixture("shortcut-user");
    const localRoot = await tempRoot();
    const localSource = await packageFixture("shortcut-local");
    const shortSource = await packageFixture("shortcut-short");

    await runCli(["install", userSource, "--adapter", "codex", "--user", "--only-source"]);
    await expect(readFile(join(cliHome, ".codex", "AGENTS.md"), "utf8")).resolves.toContain("shortcut-user");
    await cleanCliHomeState();

    await runCli(["install", localSource, "--adapter", "codex", "--local", "-t", localRoot, "--only-source"]);
    await expect(readFile(join(localRoot, "AGENTS.md"), "utf8")).resolves.toContain("shortcut-local");
    await cleanCliHomeState();

    await runCli(["install", shortSource, "--adapter", "claude", "-i", "user", "--only-source"]);
    await expect(readFile(join(cliHome, ".claude", "CLAUDE.md"), "utf8")).resolves.toContain("shortcut-short");

    const help = await runCli(["install", "--help"]);
    expect(help.stdout).toContain("-i, --installation-type <type>");
    expect(help.stdout).toContain("-t, --target-root <path>");
    expect(help.stdout).toContain("--user");
    expect(help.stdout).toContain("--local");
  });

  it("forwards the hidden sync shim with a deprecation warning", async () => {
    const root = await tempRoot();
    const source = await packageFixture("shim");
    const { stderr, stdout } = await runCli(["sync", source, "--adapter", "codex", "--installation-type", "local", "--target-root", root]);

    expect(stderr).toContain(`warning: 'agentwheel ${"sync"}' is deprecated`);
    expect(stdout).toContain("Applied codex");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("shim");
  });

  it("prints a teaching error for install garbage", async () => {
    await expect(runCli(["install", "not-a-real-package", "--target-root", await tempRoot()])).rejects.toMatchObject({
      stderr: expect.stringContaining("not a configured package and could not be resolved as a source"),
    });
    await expect(runCli(["install", "totally-bogus-pkg", "--target-root", await tempRoot()])).rejects.toMatchObject({
      stderr: expect.stringContaining("To add and install a new package:   agentwheel install <source>   (e.g. github:org/pack)"),
    });
  });

  it("honors --no-deps in graph planning", async () => {
    const root = await tempRoot();
    const dep = await packageFixture("dep");
    const source = await packageFixture("root", {
      requires: { dep: { source: dep, select: ["instructions/AGENTS.md"] } },
    });

    const { stdout } = await runCli(["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", root, "--only-source", "--no-deps"]);
    expect(stdout).toContain("WARN    --no-deps ignored dependencies");
    expect(stdout).toContain("RESOLVE root@");
    expect(stdout).not.toContain("RESOLVE dep@");
  });

  it("uses the graph lock for install and re-resolves tracking packages on update", async () => {
    const workspace = await tempRoot();
    const repo = await gitPackageFixture("v1");
    await runCli(["add", `git:${repo}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await writeFile(join(repo, "instructions", "AGENTS.md"), "# v2\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "v2"]);

    const install = await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run"]);
    expect(install.stdout).toContain("SKIP");
    expect(install.stdout).not.toContain("UPDATE");

    const update = await runCli(["update", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run"]);
    expect(update.stdout).toContain("UPDATE");
  });

  it("updates one tracking dependency while unrelated dependencies remain locked", async () => {
    const workspace = await tempRoot();
    const alpha = await gitSkillPackageFixture("dep-alpha", "alpha-skill");
    const beta = await skillPackageFixture("dep-beta", "beta-v1");
    const root = await metaPackageFixture("scoped-root", {
      alpha: { source: `git:${alpha}#main`, mode: "tracking", select: ["skills/alpha-skill"] },
      beta: { source: beta, mode: "tracking", select: ["skills/dep-beta"] },
    });
    await runCli(["add", root, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);
    const betaHashBefore = await lockedPackageSourceHash(workspace, "dep-beta");

    await updateGitSkill(alpha, "alpha-skill", "alpha-v2");
    await writeSkillPackage(beta, "dep-beta", "beta-v2");

    const preview = await runCli([
      "update", "--dependency", "dep-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(preview.stdout).toContain("UPDATE");
    expect(preview.stdout).toContain("alpha-skill");
    expect(preview.stdout).not.toContain("UPDATE   MANAGED  skills/dep-beta");

    await runCli([
      "update", "--dependency", "dep-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    await expect(readFile(join(workspace, ".agents", "skills", "alpha-skill", "SKILL.md"), "utf8")).resolves.toContain("alpha-v2");
    await expect(readFile(join(workspace, ".agents", "skills", "dep-beta", "SKILL.md"), "utf8")).resolves.not.toContain("beta-v2");
    await expect(lockedPackageSourceHash(workspace, "dep-beta")).resolves.toBe(betaHashBefore);

    const betaPreview = await runCli([
      "install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(betaPreview.stdout).toContain("UPDATE   MANAGED  skills/dep-beta");
  });

  it("updates a configured tracking root by name or normalized source without moving other roots", async () => {
    const workspace = await tempRoot();
    const alpha = await gitSkillPackageFixture("root-alpha", "alpha-root");
    const beta = await gitSkillPackageFixture("root-beta", "beta-root");
    await runCli(["add", `git:${alpha}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["add", `git:${beta}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    const betaHashBefore = await lockedPackageSourceHash(workspace, "root-beta");
    const alphaNormalizedSource = await lockedRootNormalizedSource(workspace, "root-alpha");

    await updateGitSkill(alpha, "alpha-root", "alpha-v2");
    await updateGitSkill(beta, "beta-root", "beta-v2");

    const byName = await runCli([
      "update", "--dependency", "root-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(byName.stdout).toContain("UPDATE");
    expect(byName.stdout).toContain("alpha-root");
    expect(byName.stdout).not.toMatch(/(?:UPDATE|REMOVE).*beta-root/);
    expect(byName.stdout).toContain("Summary: create 0, update 1, skip 1, remove 0, keep 0, drift 0, conflict 0, plugin 0");

    await runCli([
      "update", "--dependency", "root-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    await expect(readFile(join(workspace, ".agents", "skills", "alpha-root", "SKILL.md"), "utf8")).resolves.toContain("alpha-v2");
    await expect(readFile(join(workspace, ".agents", "skills", "beta-root", "SKILL.md"), "utf8")).resolves.not.toContain("beta-v2");
    await expect(lockedPackageSourceHash(workspace, "root-beta")).resolves.toBe(betaHashBefore);

    await updateGitSkill(alpha, "alpha-root", "alpha-v3");
    const byNormalizedSource = await runCli([
      "update", "--dependency", alphaNormalizedSource, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(byNormalizedSource.stdout).toContain("UPDATE");
    expect(byNormalizedSource.stdout).toContain("alpha-root");
    expect(byNormalizedSource.stdout).not.toMatch(/(?:UPDATE|REMOVE).*beta-root/);
    expect(byNormalizedSource.stdout).toContain("Summary: create 0, update 1, skip 1, remove 0, keep 0, drift 0, conflict 0, plugin 0");
  });

  it("preserves the entire non-selected graph when a scoped root update re-resolves a composed root", async () => {
    const workspace = await tempRoot();
    const selected = await gitSkillPackageFixture("selected-root", "selected-skill");
    const shared = await skillPackageFixture("shared-root", "shared-v1");
    const unrelated = await skillPackageFixture("unrelated-root", "unrelated-v1", {
      requires: { shared: { source: shared, mode: "tracking", select: ["skills/shared-root"] } },
    });
    const companion = await skillPackageFixture("companion-root", "companion-v1", {
      requires: { shared: { source: shared, mode: "tracking", select: ["skills/shared-root"] } },
    });
    await addSkillToPackage(unrelated, "unrelated-extra", "unrelated-extra-v1");
    await runCli(["add", `git:${selected}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["add", unrelated, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["add", companion, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);

    const before = await readTestGraphLock(workspace);
    const sharedNode = before.canonical.nodes.find((node) => node.name === "shared-root");
    if (!sharedNode) throw new Error("Shared node missing from graph lock");
    expect(sharedNode.requiredBy).toHaveLength(2);
    expect(before.canonical.artifacts.find((artifact) => artifact.graphNodeId === sharedNode.id)?.owners).toHaveLength(2);
    const beforeNonSelected = nonSelectedCanonicalGraph(before, "selected-root");

    await updateGitSkill(selected, "selected-skill", "selected-v2");
    await writeSkillPackage(unrelated, "unrelated-root", "unrelated-v2", {
      requires: { shared: { source: shared, mode: "tracking", select: ["skills/shared-root"] } },
    });
    const configPath = join(workspace, ".agentwheel", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      packages: Array<{ name: string; select?: string[] }>;
    };
    const unrelatedConfig = config.packages.find((pkg) => pkg.name === "unrelated-root");
    if (!unrelatedConfig) throw new Error("Unrelated package missing from config");
    unrelatedConfig.select = ["skills/unrelated-root", "skills/unrelated-extra"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const preview = await runCli([
      "update", "--dependency", "selected-root", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(preview.stdout).toContain("UPDATE   MANAGED  skills/selected-skill");
    expect(preview.stdout).not.toMatch(/UPDATE\s+MANAGED\s+skills\/(?:unrelated|companion|shared)-/);
    expect(preview.stdout).toContain("Summary: create 0, update 1");
    expect(preview.stdout).toMatch(/remove 0, keep \d+, drift 0, conflict 0, plugin 0/);
    expect(preview.stdout.match(/^MOVED node /gm) ?? []).toHaveLength(1);
    expect(preview.stdout).not.toMatch(/^MOVED node .*unrelated-root/m);

    await runCli([
      "update", "--dependency", "selected-root", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    await expect(readFile(join(workspace, ".agents", "skills", "selected-skill", "SKILL.md"), "utf8")).resolves.toContain("selected-v2");

    const after = await readTestGraphLock(workspace);
    expect(nonSelectedCanonicalGraph(after, "selected-root")).toEqual(beforeNonSelected);
    expect(after.canonical.nodes.find((node) => node.name === "selected-root")?.sourceHash)
      .not.toBe(before.canonical.nodes.find((node) => node.name === "selected-root")?.sourceHash);
  });

  it("rejects missing and ambiguous dependency update selectors", async () => {
    const workspace = await tempRoot();
    const source = await packageFixture("dependency-errors");
    await runCli(["add", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    await expect(runCli([
      "update", "--dependency", "missing", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("Tracking dependency not found in graph lock: missing") });

    const first = await gitSkillPackageFixture("duplicate-dependency", "duplicate-one");
    const second = await gitSkillPackageFixture("duplicate-dependency", "duplicate-two");
    const ambiguousRoot = await metaPackageFixture("ambiguous-root", {
      first: { source: `git:${first}#main`, mode: "tracking", select: ["skills/duplicate-one"] },
      second: { source: `git:${second}#main`, mode: "tracking", select: ["skills/duplicate-two"] },
    });
    const ambiguousWorkspace = await tempRoot();
    await runCli(["add", ambiguousRoot, "--adapter", "codex", "--installation-type", "local", "--target-root", ambiguousWorkspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", ambiguousWorkspace, "--yes"]);
    await expect(runCli([
      "update", "--dependency", "duplicate-dependency", "--adapter", "codex", "--installation-type", "local", "--target-root", ambiguousWorkspace, "--dry-run",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("Dependency update selector is ambiguous") });
  });

  it("updates an aliased configured root by node name and normalized source", async () => {
    const workspace = await tempRoot();
    const alpha = await gitSkillPackageFixture("metadata-alpha", "alpha-root");
    const beta = await gitSkillPackageFixture("metadata-beta", "beta-root");
    await runCli(["add", `git:${alpha}#main`, "--name", "alpha-alias", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["add", `git:${beta}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    const betaHashBefore = await lockedPackageSourceHash(workspace, "metadata-beta");
    const alphaNormalizedSource = await lockedRootNormalizedSource(workspace, "alpha-alias");

    await updateGitSkill(alpha, "alpha-root", "alpha-v2");
    await updateGitSkill(beta, "beta-root", "beta-v2");

    const byNodeName = await runCli([
      "update", "--dependency", "metadata-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(byNodeName.stdout).toContain("UPDATE   MANAGED  skills/alpha-root");
    expect(byNodeName.stdout).toContain("Summary: create 0, update 1, skip 1, remove 0, keep 0, drift 0, conflict 0, plugin 0");

    await runCli([
      "update", "--dependency", "metadata-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace,
    ]);
    await expect(readFile(join(workspace, ".agents", "skills", "alpha-root", "SKILL.md"), "utf8")).resolves.toContain("alpha-v2");
    await expect(lockedPackageSourceHash(workspace, "metadata-beta")).resolves.toBe(betaHashBefore);

    await updateGitSkill(alpha, "alpha-root", "alpha-v3");
    const byNormalizedSource = await runCli([
      "update", "--dependency", alphaNormalizedSource, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run",
    ]);
    expect(byNormalizedSource.stdout).toContain("UPDATE   MANAGED  skills/alpha-root");
    expect(byNormalizedSource.stdout).toContain("Summary: create 0, update 1, skip 1, remove 0, keep 0, drift 0, conflict 0, plugin 0");
  });

  it("scopes install <name> without installing or removing other configured packages", async () => {
    const workspace = await tempRoot();
    const alpha = await skillPackageFixture("scoped-alpha", "alpha-v1");
    const beta = await skillPackageFixture("scoped-beta", "beta-v1");
    const alphaDest = join(workspace, ".agents", "skills", "scoped-alpha", "SKILL.md");
    const betaDest = join(workspace, ".agents", "skills", "scoped-beta", "SKILL.md");

    await runCli(["add", alpha, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    const alphaInstall = await runCli(["install", "scoped-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(alphaInstall.stdout).toContain("CREATE");
    await expect(readFile(alphaDest, "utf8")).resolves.toContain("alpha-v1");
    await expect(readFile(betaDest, "utf8")).rejects.toThrow();

    await runCli(["install", "scoped-beta", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta-v1");

    const secondAlphaInstall = await runCli(["install", "scoped-alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(secondAlphaInstall.stdout).toContain("SKIP");
    await expect(readFile(alphaDest, "utf8")).resolves.toContain("alpha-v1");
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta-v1");
  });

  it("scopes update <name> without blocking on unrelated drift", async () => {
    const workspace = await tempRoot();
    const alpha = await gitSkillPackageFixture("scoped-update-alpha", "alpha-skill");
    const beta = await gitSkillPackageFixture("scoped-update-beta", "beta-skill");
    const betaDest = join(workspace, ".agents", "skills", "beta-skill", "SKILL.md");

    await runCli(["add", `git:${alpha}#main`, "--name", "alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["add", `git:${beta}#main`, "--name", "beta", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);
    await updateGitSkill(alpha, "alpha-skill", "alpha-v2");
    await writeFile(betaDest, "local beta drift\n", "utf8");

    const preview = await runCli(["update", "alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--dry-run"]);
    expect(preview.stdout).toContain("UPDATE   MANAGED  skills/alpha-skill");
    expect(preview.stdout).toContain("KEEP     MANAGED  skills/beta-skill");
    expect(preview.stdout).not.toContain("DRIFT");

    await runCli(["update", "alpha", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(join(workspace, ".agents", "skills", "alpha-skill", "SKILL.md"), "utf8")).resolves.toContain("alpha-v2");
    await expect(readFile(betaDest, "utf8")).resolves.toBe("local beta drift\n");
  });

  it("scoped install converges out-of-scope ownership without touching shared content", async () => {
    const workspace = await tempRoot();
    const shared = await skillPackageFixture("scope-shared", "shared-v1");
    const rootA = await skillPackageFixture("scope-owner-a", "owner-a", {
      requires: { shared: { source: shared, select: ["skills/scope-shared"] } },
    });
    const rootB = await skillPackageFixture("scope-owner-b", "owner-b", {
      requires: { shared: { source: shared, select: ["skills/scope-shared"] } },
    });
    const sharedDest = join(workspace, ".agents", "skills", "scope-shared", "SKILL.md");

    await runCli(["add", rootA, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", rootB, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);
    const before = manifestEntry(await readCodexManifest(workspace), ".agents/skills/scope-shared");
    expect(before.owners.filter((owner: string) => owner.includes("scope-owner-"))).toHaveLength(2);

    await writeSkillManifest(rootA, "scope-owner-a");
    await runCli(["install", "scope-owner-a", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);

    await expect(readFile(sharedDest, "utf8")).resolves.toContain("shared-v1");
    const after = manifestEntry(await readCodexManifest(workspace), ".agents/skills/scope-shared");
    expect(after.owners.some((owner: string) => owner.includes("scope-owner-a"))).toBe(false);
    expect(after.owners.some((owner: string) => owner.includes("scope-owner-b"))).toBe(true);

    await runCli(["uninstall", "scope-owner-a", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(sharedDest, "utf8")).resolves.toContain("shared-v1");
    await runCli(["uninstall", "scope-owner-b", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(sharedDest, "utf8")).rejects.toThrow();
  });

  it("installs and uninstalls local meta-packages through selected dependencies", async () => {
    const workspace = await tempRoot();
    const dep = await skillPackageFixture("dep", "dep");
    const meta = await metaPackageFixture("meta-pack", {
      dep: { source: dep, select: ["skills/dep"] },
    });
    const depDest = join(workspace, ".agents", "skills", "dep", "SKILL.md");
    const before = await runtimeFiles(workspace);

    await runCli(["install", meta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--yes"]);
    await expect(readFile(depDest, "utf8")).resolves.toContain("# dep");
    const manifest = await readCodexManifest(workspace);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([".agents/skills/dep"]);

    await runCli(["uninstall", "meta-pack", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(depDest, "utf8")).rejects.toThrow();
    expect(await runtimeFiles(workspace)).toEqual(before);
  });

  it("scoped install preserves out-of-scope merge update hashes until full install", async () => {
    const workspace = await tempRoot();
    const alpha = await packageFixture("scope-update-a");
    const beta = await mcpPackageFixture("scope-update-b", "scope-update-v1");
    const configPath = join(workspace, ".codex", "config.toml");

    await runCli(["add", alpha, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    const before = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v1"');

    await writeMcpPackage(beta, "scope-update-b", "scope-update-v2");
    await runCli(["install", "scope-update-a", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v1"');
    expect(await readFile(configPath, "utf8")).not.toContain("scope-update-v2");
    const scoped = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(scoped.hash).toBe(before.hash);
    expect(scoped.sourceHash).toBe(before.sourceHash);

    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v2"');
    const full = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(full.sourceHash).not.toBe(before.sourceHash);
  });

  it("scoped install does not let out-of-scope drift block or disappear", async () => {
    const workspace = await tempRoot();
    const alpha = await skillPackageFixture("scope-drift-a", "alpha");
    const beta = await skillPackageFixture("scope-drift-b", "beta");
    const betaDest = join(workspace, ".agents", "skills", "scope-drift-b", "SKILL.md");

    await runCli(["add", alpha, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await writeFile(betaDest, "# local drift\n", "utf8");

    const scoped = await runCli(["install", "scope-drift-a", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(scoped.stdout).toContain("Applied codex");
    await expect(runCli(["plan", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace])).rejects.toMatchObject({
      stdout: expect.stringContaining("DRIFT"),
    });
  });

  it("scoped install preserves out-of-scope removals until full install", async () => {
    const workspace = await tempRoot();
    const alpha = await skillPackageFixture("scope-remove-a", "alpha");
    const beta = await skillPackageFixture("scope-remove-b", "beta");
    const betaDest = join(workspace, ".agents", "skills", "scope-remove-b", "SKILL.md");

    await runCli(["add", alpha, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await removeConfiguredPackage(workspace, "scope-remove-b");

    await runCli(["install", "scope-remove-a", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta");
    expect(manifestEntry(await readCodexManifest(workspace), ".agents/skills/scope-remove-b")).toBeTruthy();

    await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).rejects.toThrow();
    expect((await readCodexManifest(workspace)).entries.some((entry: { path: string }) => entry.path === ".agents/skills/scope-remove-b")).toBe(false);
  });

  it("keeps status read-only even when configured packages have untrusted dependencies", async () => {
    const workspace = await tempRoot();
    const dep = await skillPackageFixture("status-dep", "dep");
    const source = await packageFixture("status-root", {
      requires: { dep: { source: dep, select: ["skills/status-dep"] } },
    });
    await runCli(["add", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    const status = await runCli(["status", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    expect(status.stdout).toContain("Status for codex/local");
    expect(status.stdout).toContain("status-root");
    expect(status.stdout).toContain("Install manifest: missing");
    expect(status.stdout).toContain("Pending install work:");
  });

  it("does not report foreign kept artifacts as pending status work", async () => {
    const ownerWorkspace = await tempRoot("agentwheel-status-owner-");
    const observerWorkspace = await tempRoot("agentwheel-status-observer-");
    const target = await tempRoot("agentwheel-status-target-");
    const source = await skillPackageFixture("status-foreign", "foreign");
    const config = {
      schemaVersion: 1,
      packages: [{
        name: "status-foreign",
        source,
        driver: "local",
        adapter: "codex",
        installationType: "local",
        mode: "tracking",
      }],
      registry: {},
      trust: {},
      agents: {
        lab: { adapter: "codex", root: target, transport: "local", installationType: "local" },
      },
      profiles: {
        all: { runtimes: [{ agent: "lab" }] },
      },
    };
    for (const root of [ownerWorkspace, observerWorkspace]) {
      await mkdir(join(root, ".agentwheel"), { recursive: true });
      await writeFile(join(root, ".agentwheel", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }

    await runCli(["install", "--profile", "all", "--target-root", ownerWorkspace]);
    const dryRun = await runCli(["install", "--profile", "all", "--target-root", observerWorkspace, "--dry-run"]);
    expect(dryRun.stdout).toContain("KEEP");

    const status = await runCli(["status", "--profile", "all", "--target-root", observerWorkspace]);

    expect(status.stdout).toContain("Install manifest: 1 entries");
    expect(status.stdout).toContain("Pending install work: none");
    expect(status.stdout).not.toContain("Pending install work: 1 operations");
  });

  it("reports profile status with profile runtime adapter config and graph lock state", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-profile-status-target-");
    const source = await markdownRulePackageFixture("profile-status-rule", "profile-status");
    const adapterConfig = join(workspace, "profile-adapter.json");
    await writeFile(adapterConfig, `${JSON.stringify({
      name: "profile-status",
      displayName: "Profile Status",
      targets: {
        rules: {
          local: { enabled: true, dest: ".profile/rules" },
        },
      },
    }, null, 2)}\n`, "utf8");
    await mkdir(join(workspace, ".agentwheel"), { recursive: true });
    await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify({
      schemaVersion: 1,
      packages: [{
        name: "profile-status-rule",
        source,
        driver: "local",
        adapter: "openclaw",
        installationType: "local",
        mode: "tracking",
      }],
      registry: {},
      trust: {},
      agents: {
        lab: { adapter: "openclaw", root: target, transport: "local", installationType: "local" },
      },
      profiles: {
        all: {
          runtimes: [{ agent: "lab", adapterConfig }],
        },
      },
    }, null, 2)}\n`, "utf8");

    await runCli(["install", "--profile", "all", "--target-root", workspace]);
    const status = await runCli(["status", "--profile", "all", "--target-root", workspace]);
    const allStatus = await runCli(["status", "--all", "--target-root", workspace]);

    expect(status.stdout).toContain("Status for profile-status/local");
    expect(status.stdout).toContain("Install manifest: 1 entries");
    expect(status.stdout).toContain("Graph lock:");
    expect(status.stdout).toContain("Pending install work: none");
    expect(status.stdout).not.toContain("unavailable");
    expect(allStatus.stdout).toContain("Status for profile-status/local");
    expect(allStatus.stdout).toContain("Pending install work: none");
    expect(allStatus.stdout).not.toContain("unavailable");

    await writeFile(join(source, "rules", "profile-status-rule.md"), "# profile-status-v2\n", "utf8");
    const update = await runCli(["update", "profile-status-rule", "--all", "--target-root", workspace]);
    expect(update.stdout).toContain("UPDATE");
    await expect(readFile(join(target, ".profile", "rules", "profile-status-rule.md"), "utf8")).resolves.toContain("profile-status-v2");
  });

  it("runs configured runtime reload commands after executed profile plugin changes", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-profile-reload-target-");
    const source = await openClawPluginPackageFixture("profile-reload-plugin");
    const bin = await tempRoot("agentwheel-profile-reload-bin-");
    const log = join(workspace, "reload-log.jsonl");
    await writeFakeExecutable(join(bin, "openclaw"), "openclaw");
    await writeFakeExecutable(join(bin, "agentwheel-test-reload"), "reload");
    await mkdir(join(workspace, ".agentwheel"), { recursive: true });
    await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify({
      schemaVersion: 1,
      packages: [{
        name: "profile-reload-plugin",
        source,
        driver: "local",
        adapter: "openclaw",
        installationType: "local",
        mode: "tracking",
        select: ["plugins/profile-reload-plugin"],
      }],
      registry: {},
      trust: {},
      agents: {
        lab: {
          adapter: "openclaw",
          root: target,
          transport: "local",
          installationType: "local",
          reloadCommands: [["agentwheel-test-reload", "lab"]],
        },
      },
      profiles: {
        all: { runtimes: [{ agent: "lab" }] },
      },
    }, null, 2)}\n`, "utf8");

    const { stdout } = await runCli([
      "install",
      "--profile",
      "all",
      "--target-root",
      workspace,
      "--execute-plugins",
      "--reload-runtimes",
    ], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AGENTWHEEL_TEST_RELOAD_LOG: log,
      },
    });

    expect(stdout).toContain("Reloaded runtime via agentwheel-test-reload lab.");
    const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        name: "openclaw",
        args: ["plugins", "install", "--force", expect.stringContaining("profile-reload-plugin")],
      },
      {
        name: "reload",
        args: ["lab"],
      },
    ]);
  });

  it("rejects conflicting uninstall --keep-files and --force flags", async () => {
    await expect(runCli(["uninstall", "anything", "--keep-files", "--force", "--target-root", await tempRoot()])).rejects.toMatchObject({
      stderr: expect.stringContaining("--keep-files cannot be combined with --force."),
    });
  });

  it("does not persist a new source when install source preflight is offline", async () => {
    const workspace = await tempRoot();
    const repo = await gitPackageFixture("offline-new");

    await expect(runCli(["install", `git:${repo}#main`, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--offline"])).rejects.toMatchObject({
      stderr: expect.stringContaining("requires cached git checkout"),
    });
    await expect(readFile(join(workspace, ".agentwheel", "config.json"), "utf8")).rejects.toThrow();
  });

  it("scopes --skill selectors to an only-source install source", async () => {
    const workspace = await tempRoot();
    const unrelated = await packageFixture("agent-core-toolkit-private");
    const source = await gitSkillPackageFixture("agent-mesh", "agent-tmux");

    await runCli(["add", unrelated, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    const { stdout } = await runCli([
      "install",
      `git:${source}#main`,
      "--adapter",
      "codex",
      "--installation-type",
      "local",
      "--target-root",
      workspace,
      "--skill",
      "agent-tmux",
      "--only-source",
      "--no-deps",
    ]);

    expect(stdout).toContain("Applied codex");
    await expect(readFile(join(workspace, ".agents", "skills", "agent-tmux", "SKILL.md"), "utf8")).resolves.toContain("agent-tmux");
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();

    const config = JSON.parse(await readFile(join(workspace, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages.map((pkg: { name: string }) => pkg.name)).toEqual(["agent-core-toolkit-private"]);
  });

  it("installs suggested companions only when requested and persists that choice", async () => {
    const companion = await skillPackageFixture("brainstorming", "Brainstorming");
    const source = await tempRoot("agentwheel-convergent-pack-");
    await mkdir(join(source, "skills", "convergent"), { recursive: true });
    await writeFile(
      join(source, "skills", "convergent", "SKILL.md"),
      "---\nname: convergent\ndescription: Fixture convergent skill.\n---\n\n# Convergent\n",
      "utf8",
    );
    await writeFile(join(source, "openpack.json"), `${JSON.stringify({
      schemaVersion: 2,
      name: "convergent-pack",
      version: "1.0.0",
      suggests: {
        brainstorm: {
          source: companion,
          select: ["skills/brainstorming"],
          reason: "Generate options before converging.",
        },
      },
      provides: [
        {
          type: "skills",
          path: "skills",
          items: {
            convergent: { suggests: ["brainstorm"] },
          },
        },
      ],
    }, null, 2)}\n`, "utf8");

    const defaultWorkspace = await tempRoot();
    await runCli(["install", source, "--adapter", "codex", "--installation-type", "local", "--target-root", defaultWorkspace, "--skill", "convergent"]);
    await expect(readFile(join(defaultWorkspace, ".agents", "skills", "convergent", "SKILL.md"), "utf8")).resolves.toContain("Convergent");
    await expect(readFile(join(defaultWorkspace, ".agents", "skills", "brainstorming", "SKILL.md"), "utf8")).rejects.toThrow();
    const defaultConfig = JSON.parse(await readFile(join(defaultWorkspace, ".agentwheel", "config.json"), "utf8"));
    expect(defaultConfig.packages[0]?.withSuggestions).toBeUndefined();

    const suggestedWorkspace = await tempRoot();
    await runCli(["install", source, "--adapter", "codex", "--installation-type", "local", "--target-root", suggestedWorkspace, "--skill", "convergent", "--with-suggestions", "--yes"]);
    await expect(readFile(join(suggestedWorkspace, ".agents", "skills", "convergent", "SKILL.md"), "utf8")).resolves.toContain("Convergent");
    await expect(readFile(join(suggestedWorkspace, ".agents", "skills", "brainstorming", "SKILL.md"), "utf8")).resolves.toContain("Brainstorming");
    const suggestedConfig = JSON.parse(await readFile(join(suggestedWorkspace, ".agentwheel", "config.json"), "utf8"));
    expect(suggestedConfig.packages[0]?.withSuggestions).toBe(true);
  });

  it("uninstall --keep-files removes management state but leaves runtime files alone", async () => {
    const workspace = await tempRoot();
    const source = await packageFixture("keep-files");
    await runCli(["install", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);

    await runCli(["uninstall", "keep-files", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--keep-files"]);
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toContain("keep-files");
    const config = JSON.parse(await readFile(join(workspace, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages).toEqual([]);

    const followUp = await runCli(["install", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(followUp.stdout).toContain("No packages configured");
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toContain("keep-files");
  });

  it("lists and aborts a pending apply journal for a resolved runtime target", async () => {
    const workspace = await tempRoot();
    const source = await packageFixture("journal-cli");
    await runCli(["install", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    const metadataRoot = join(workspace, ".agentwheel");
    const stateKey = (await readdir(metadataRoot))
      .find((entry) => entry.startsWith("codex.local.") && entry.endsWith(".install-manifest.json"))
      ?.replace(".install-manifest.json", "");
    if (!stateKey) throw new Error("Codex state key not found");
    await writeFile(join(metadataRoot, `${stateKey}.apply-journal.json`), `${JSON.stringify({
      version: 1,
      adapter: "codex",
      installationType: "local",
      stateKey,
      targetRoot: workspace,
      baseRevision: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
      operations: [],
      completed: [],
      manifest: {
        version: 2,
        adapter: "codex",
        installationType: "local",
        stateKey,
        targetRoot: workspace,
        generatedAt: "2026-07-10T00:00:00.000Z",
        revision: "pending-apply-0000",
        legacy: false,
        entries: [],
      },
    }, null, 2)}\n`, "utf8");

    const listed = await runCli(["journal", "list", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(listed.stdout).toContain("PENDING codex/local");
    expect(listed.stdout).toContain(`stateKey: ${stateKey}`);

    const aborted = await runCli(["journal", "abort", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(aborted.stdout).toContain("Archived codex/local pending journal:");
    await expect(stat(join(metadataRoot, `${stateKey}.apply-journal.json`))).rejects.toThrow();
    const archives = await readdir(join(metadataRoot, "archive"));
    expect(archives.some((entry) => entry.startsWith(`${stateKey}.apply-journal.failed-`))).toBe(true);

    const clean = await runCli(["journal", "list", "--adapter", "codex", "--installation-type", "local", "--target-root", workspace]);
    expect(clean.stdout).toContain("No pending apply journals.");
  });
});

async function runCli(args: string[], options: { env?: Record<string, string> } = {}) {
  try {
    return await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env, HOME: cliHome },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw error as { stdout: string; stderr: string; code: number };
  }
}

async function tempRoot(prefix = "agentwheel-cli-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function cleanCliHomeState(): Promise<void> {
  await Promise.all([
    rm(join(cliHome, ".agentwheel"), { recursive: true, force: true }),
    rm(join(cliHome, ".agents"), { recursive: true, force: true }),
    rm(join(cliHome, ".copilot"), { recursive: true, force: true }),
    rm(join(cliHome, ".codex"), { recursive: true, force: true }),
    rm(join(cliHome, ".claude"), { recursive: true, force: true }),
  ]);
}

async function packageFixture(name: string, options: { requires?: unknown } = {}): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "instructions"), { recursive: true });
  await writeFile(join(root, "instructions", "AGENTS.md"), `# ${name}\n`, "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires: options.requires,
    provides: [{ type: "instructions", path: "instructions/AGENTS.md" }],
  }, null, 2)}\n`, "utf8");
  return root;
}

async function openClawPluginPackageFixture(name: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "plugins", name), { recursive: true });
  await writeFile(join(root, "plugins", name, "plugin.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides: [{ type: "plugins", path: "plugins" }],
  }, null, 2)}\n`, "utf8");
  return root;
}

async function writeFakeExecutable(path: string, name: string): Promise<void> {
  await writeFile(path, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const log = process.env.AGENTWHEEL_TEST_RELOAD_LOG;",
    "if (log) fs.appendFileSync(log, JSON.stringify({ name: process.argv[1].split('/').pop() === 'openclaw' ? 'openclaw' : '" + name + "', args: process.argv.slice(2) }) + '\\n');",
  ].join("\n"), "utf8");
  await chmod(path, 0o755);
}

async function markdownRulePackageFixture(name: string, content: string, options: { requires?: unknown } = {}): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", `${name}.md`), `# ${content}\n`, "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires: options.requires,
    provides: [{ type: "rules", path: "rules" }],
  }, null, 2)}\n`, "utf8");
  return root;
}

async function skillPackageFixture(name: string, content: string, options: { requires?: unknown } = {}): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await writeSkillPackage(root, name, content, options);
  return root;
}

async function writeSkillPackage(root: string, name: string, content: string, options: { requires?: unknown } = {}): Promise<void> {
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(join(root, "skills", name, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Fixture skill for ${name}.`,
    "---",
    "",
    `# ${content}`,
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires: options.requires,
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`, "utf8");
}

async function metaPackageFixture(name: string, requires: unknown): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires,
  }, null, 2)}\n`, "utf8");
  return root;
}

async function writeSkillManifest(root: string, name: string, options: { requires?: unknown } = {}): Promise<void> {
  await writeSkillPackage(root, name, name, options);
}

async function mcpPackageFixture(name: string, command: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await writeMcpPackage(root, name, command);
  return root;
}

async function writeMcpPackage(root: string, name: string, command: string): Promise<void> {
  await mkdir(join(root, "mcp"), { recursive: true });
  await writeFile(join(root, "mcp", "server.json"), JSON.stringify({
    mcpServers: { [name]: { command } },
  }, null, 2), "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides: [{ type: "mcp", path: "mcp" }],
  }, null, 2)}\n`, "utf8");
}

async function gitPackageFixture(label: string): Promise<string> {
  const root = await packageFixture(label);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", label]);
  return root;
}

async function gitSkillPackageFixture(name: string, skillName: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "skills", skillName), { recursive: true });
  await writeFile(
    join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Fixture skill for tests.\n---\n\n# ${skillName}\n`,
    "utf8",
  );
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`, "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", name]);
  return root;
}

async function updateGitSkill(root: string, skillName: string, content: string): Promise<void> {
  await writeFile(
    join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Fixture skill for tests.\n---\n\n# ${content}\n`,
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", content]);
}

async function addSkillToPackage(root: string, skillName: string, content: string): Promise<void> {
  await mkdir(join(root, "skills", skillName), { recursive: true });
  await writeFile(
    join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Fixture skill for tests.\n---\n\n# ${content}\n`,
    "utf8",
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd });
}

type TestManifestEntry = {
  path: string;
  hash: string;
  sourceHash: string;
  owners: string[];
};

type TestManifest = {
  entries: TestManifestEntry[];
};

async function readCodexManifest(workspace: string): Promise<TestManifest> {
  const metadata = join(workspace, ".agentwheel");
  const file = (await readdir(metadata))
    .filter((entry) => entry.startsWith("codex.local.") && entry.endsWith(".install-manifest.json"))
    .sort()[0];
  if (!file) throw new Error("Codex local install manifest not found");
  return JSON.parse(await readFile(join(metadata, file), "utf8")) as TestManifest;
}

async function lockedPackageSourceHash(workspace: string, packageName: string): Promise<string> {
  const locksRoot = join(workspace, ".agentwheel", "locks");
  const lockPath = (await filesBelow(locksRoot)).find((path) => path.endsWith(".graph-lock.json"));
  if (!lockPath) throw new Error("Graph lock not found");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    canonical: { nodes: Array<{ name: string; sourceHash: string }> };
  };
  const node = lock.canonical.nodes.find((candidate) => candidate.name === packageName);
  if (!node) throw new Error(`Locked package not found: ${packageName}`);
  return node.sourceHash;
}

async function lockedRootNormalizedSource(workspace: string, rootId: string): Promise<string> {
  const locksRoot = join(workspace, ".agentwheel", "locks");
  const lockPath = (await filesBelow(locksRoot)).find((path) => path.endsWith(".graph-lock.json"));
  if (!lockPath) throw new Error("Graph lock not found");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    canonical: { roots: Array<{ rootId: string; normalizedSource: string }> };
  };
  const root = lock.canonical.roots.find((candidate) => candidate.rootId === rootId);
  if (!root) throw new Error(`Locked root not found: ${rootId}`);
  return root.normalizedSource;
}

type TestGraphLock = {
  canonical: {
    targetFingerprint?: string;
    roots: Array<Record<string, unknown> & { rootId: string; graphNodeId: string }>;
    nodes: Array<Record<string, unknown> & { id: string; name: string; requiredBy: string[] }>;
    edges: Array<Record<string, unknown> & { from: string; to: string }>;
    includeEdges: Array<Record<string, unknown> & { fromNodeId: string; toNodeId: string }>;
    artifacts: Array<Record<string, unknown> & { graphNodeId: string; owners: string[] }>;
    namespacing: Array<Record<string, unknown> & { graphNodeId: string }>;
    overrides: Array<Record<string, unknown> & { rootId: string; graphNodeId: string; overriddenGraphNodeId: string }>;
    plainNameIncumbents: Array<Record<string, unknown> & { graphNodeId: string }>;
  };
};

async function readTestGraphLock(workspace: string): Promise<TestGraphLock> {
  const locksRoot = join(workspace, ".agentwheel", "locks");
  const lockPath = (await filesBelow(locksRoot)).find((path) => path.endsWith(".graph-lock.json"));
  if (!lockPath) throw new Error("Graph lock not found");
  return JSON.parse(await readFile(lockPath, "utf8")) as TestGraphLock;
}

function nonSelectedCanonicalGraph(lock: TestGraphLock, selectedRootName: string): Record<string, unknown> {
  const nodesById = new Map(lock.canonical.nodes.map((node) => [node.id, node]));
  const selectedRoots = lock.canonical.roots.filter((root) => nodesById.get(root.graphNodeId)?.name === selectedRootName);
  const selectedRootIds = new Set(selectedRoots.map((root) => root.rootId));
  const selectedClosureIds = new Set(selectedRoots.map((root) => root.graphNodeId));
  const queue = [...selectedClosureIds];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const edge of lock.canonical.edges) {
      if (edge.from !== from || selectedClosureIds.has(edge.to)) continue;
      selectedClosureIds.add(edge.to);
      queue.push(edge.to);
    }
  }
  return {
    targetFingerprint: lock.canonical.targetFingerprint,
    roots: lock.canonical.roots.filter((root) => !selectedRootIds.has(root.rootId) && !selectedClosureIds.has(root.graphNodeId)),
    nodes: lock.canonical.nodes.filter((node) => !selectedClosureIds.has(node.id)),
    edges: lock.canonical.edges.filter((edge) => !selectedClosureIds.has(edge.from) && !selectedClosureIds.has(edge.to)),
    includeEdges: lock.canonical.includeEdges.filter((edge) => !selectedClosureIds.has(edge.fromNodeId) && !selectedClosureIds.has(edge.toNodeId)),
    artifacts: lock.canonical.artifacts.filter((artifact) => !selectedClosureIds.has(artifact.graphNodeId)),
    namespacing: lock.canonical.namespacing.filter((entry) => !selectedClosureIds.has(entry.graphNodeId)),
    overrides: lock.canonical.overrides.filter((entry) => !selectedRootIds.has(entry.rootId)
      && !selectedClosureIds.has(entry.graphNodeId) && !selectedClosureIds.has(entry.overriddenGraphNodeId)),
    plainNameIncumbents: lock.canonical.plainNameIncumbents.filter((entry) => !selectedClosureIds.has(entry.graphNodeId)),
  };
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

function manifestEntry(manifest: TestManifest, path: string): TestManifestEntry {
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Missing manifest entry: ${path}`);
  return entry;
}

async function runtimeFiles(root: string, prefix = ""): Promise<string[]> {
  const dir = join(root, prefix);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = (prefix ? join(prefix, entry.name) : entry.name).replaceAll("\\", "/");
    if (relativePath === ".agentwheel" || relativePath.startsWith(".agentwheel/")) continue;
    if (entry.isDirectory()) {
      files.push(...await runtimeFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function removeConfiguredPackage(workspace: string, name: string): Promise<void> {
  const configPath = join(workspace, ".agentwheel", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    packages: Array<{ name: string; source: string }>;
  };
  config.packages = config.packages.filter((pkg) => pkg.name !== name && pkg.source !== name);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function cliBuildIsStale(): Promise<boolean> {
  try {
    const built = await stat(cli);
    return built.mtimeMs < await newestTypescriptMtime(join(process.cwd(), "src"));
  } catch {
    return true;
  }
}

async function newestTypescriptMtime(root: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestTypescriptMtime(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    }
  }
  return newest;
}
