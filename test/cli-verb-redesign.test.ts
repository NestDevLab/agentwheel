import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
});

async function runCli(args: string[]) {
  try {
    return await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: cliHome },
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
