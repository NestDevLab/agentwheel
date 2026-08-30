import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../src/install/index.js";
import { shouldUpdatePackage } from "../src/lifecycle/update.js";
import { GitSourceDriver } from "../src/source/git.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-life-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackage(root: string, options: { name?: string; coreRule?: string; ejectedRule?: string } = {}) {
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills", "demo-skill"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: options.name ?? "acme/core",
    version: "0.1.0",
    provides: [
      { type: "instructions", path: "instructions/AGENTS.md" },
      { type: "rules", path: "rules" },
      { type: "skills", path: "skills" },
    ],
  }, null, 2));
  await writeFile(join(root, "instructions", "AGENTS.md"), "# Upstream instructions\n");
  await writeFile(join(root, "rules", "core.md"), options.coreRule ?? "# Upstream core\n");
  await writeFile(join(root, "rules", "ejected.md"), options.ejectedRule ?? "# Upstream ejected\n");
  await writeFile(join(root, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Fixture skill for tests.\n---\n\n# Demo skill\n");
}

describe("lifecycle core", () => {
  it("reads canonical package manifests", async () => {
    const source = await tempRoot();
    await writePackage(source);
    const driver = new LocalSourceDriver();
    const resolved = await driver.resolve(source);
    const artifacts = await driver.list(resolved);

    expect(resolved.packageName).toBe("acme/core");
    expect(artifacts.map((artifact) => `${artifact.type}:${artifact.name}`).sort()).toEqual([
      "instructions:AGENTS.md",
      "rules:core.md",
      "rules:ejected.md",
      "skills:demo-skill",
    ]);
  });

  it("resolves git tracking refs and pinned commits from a local repo", async () => {
    const repo = await tempRoot("agentwheel-git-src-");
    await writePackage(repo, { coreRule: "# v1\n" });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const commit1 = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const workspace = await tempRoot("agentwheel-git-ws-");
    const driver = new GitSourceDriver();
    const first = await stageSource(driver, `git:${repo}#main`, {
      cacheRoot: join(workspace, ".agentwheel", "cache"),
      mode: "tracking",
    });
    expect(first.source.resolvedCommit).toBe(commit1);

    await writePackage(repo, { coreRule: "# v2\n" });
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);
    const commit2 = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const tracking = await stageSource(driver, `git:${repo}#main`, {
      cacheRoot: join(workspace, ".agentwheel", "cache"),
      mode: "tracking",
    });
    expect(tracking.source.resolvedCommit).toBe(commit2);

    const pinned = await stageSource(driver, `git:${repo}#${commit1}`, {
      cacheRoot: join(workspace, ".agentwheel", "cache-pinned"),
      mode: "pinned",
    });
    expect(pinned.source.resolvedCommit).toBe(commit1);
  });

  it("uses a filesystem lock around git cache mutation", async () => {
    const repo = await tempRoot("agentwheel-git-lock-src-");
    await writePackage(repo, { coreRule: "# locked\n" });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "locked"]);

    const workspace = await tempRoot("agentwheel-git-lock-ws-");
    const driver = new GitSourceDriver();
    const resolved = await driver.resolve(`git:${repo}#main`, {
      cacheRoot: join(workspace, ".agentwheel", "cache"),
      mode: "tracking",
      cacheLockTimeoutMs: 25,
    });
    await mkdir(`${resolved.resolvedPath}.lock`, { recursive: true });

    await expect(driver.fetch(resolved)).rejects.toThrow(/Timed out waiting for git cache lock/);
  });

  it("materializes snapshots without mutating a contaminated cache checkout", async () => {
    const repo = await tempRoot("agentwheel-git-dirty-src-");
    await writePackage(repo, { coreRule: "# v1\n" });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);

    const workspace = await tempRoot("agentwheel-git-dirty-ws-");
    const cacheRoot = join(workspace, ".agentwheel", "cache");
    const driver = new GitSourceDriver();
    const firstResolved = await driver.resolve(`git:${repo}#main`, { cacheRoot, mode: "tracking" });
    await driver.fetch(firstResolved);

    const collision = join(firstResolved.resolvedPath, "test", "fixtures", "compat", "parser.mjs");
    await mkdir(join(collision, ".."), { recursive: true });
    await writeFile(collision, "local cache contamination\n", "utf8");
    await mkdir(join(repo, "test", "fixtures", "compat"), { recursive: true });
    await writeFile(join(repo, "test", "fixtures", "compat", "parser.mjs"), "upstream content\n", "utf8");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "add colliding fixture"]);
    const expectedCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const fetched = await driver.fetch(await driver.resolve(`git:${repo}#main`, { cacheRoot, mode: "tracking" }));
    expect(fetched.resolvedCommit).toBe(expectedCommit);
    expect(await readFile(join(fetched.resolvedPath, "test", "fixtures", "compat", "parser.mjs"), "utf8"))
      .toBe("upstream content\n");
    expect(await readFile(collision, "utf8")).toBe("local cache contamination\n");
  });

  it("refuses to mutate a Git cache owned by another uid", async () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    const repo = await tempRoot("agentwheel-git-owner-src-");
    await writePackage(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "initial"]);
    const workspace = await tempRoot("agentwheel-git-owner-ws-");
    const driver = new GitSourceDriver();
    const resolved = await driver.resolve(`git:${repo}#main`, {
      cacheRoot: join(workspace, ".agentwheel", "cache"),
    });
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(currentUid + 1);
    try {
      await expect(driver.fetch(resolved)).rejects.toThrow(/owned by uid .* running as uid/);
    } finally {
      getuid.mockRestore();
    }
  });

  it("decides update behavior for pinned and tracking packages", () => {
    const pinned = {
      name: "pkg",
      source: "git:/repo#abc",
      driver: "git" as const,
      adapter: "openclaw",
      mode: "pinned" as const,
      requestedRef: "abc",
    };
    const lock = {
      version: 1 as const,
      driver: "git",
      source: "git:/repo#abc",
      resolvedPath: "/cache/repo",
      mode: "pinned" as const,
      requestedRef: "abc",
      generatedAt: new Date().toISOString(),
      artifacts: [],
    };

    expect(shouldUpdatePackage(pinned, lock).shouldUpdate).toBe(false);
    expect(shouldUpdatePackage({ ...pinned, requestedRef: "def" }, lock).shouldUpdate).toBe(true);
    expect(shouldUpdatePackage({ ...pinned, mode: "tracking" }, lock).shouldUpdate).toBe(true);
  });

  it("stages overlay, additions, overrides, and ejected artifacts distinctly", async () => {
    const source = await tempRoot();
    await writePackage(source);
    const workspace = await tempRoot();
    await mkdir(join(workspace, ".agentwheel", "overlays", "claude"), { recursive: true });
    await mkdir(join(workspace, ".agentwheel", "additions", "rules"), { recursive: true });
    await mkdir(join(workspace, ".agentwheel", "overrides", "acme", "core", "rules"), { recursive: true });
    await mkdir(join(workspace, ".agentwheel", "ejected", "acme", "core", "rules"), { recursive: true });
    await writeFile(join(workspace, ".agentwheel", "overlays", "claude", "instructions.local.md"), "Local memory survives.\n");
    await writeFile(join(workspace, ".agentwheel", "additions", "rules", "local.md"), "# Local additive rule\n");
    await writeFile(join(workspace, ".agentwheel", "overrides", "acme", "core", "rules", "core.md"), "# Overridden core\n");
    await writeFile(join(workspace, ".agentwheel", "ejected", "acme", "core", "rules", "ejected.md"), "# Local ejected\n");

    const bundle = await stageSource(new LocalSourceDriver(), source, {
      workspaceRoot: workspace,
      adapter: claudeAdapter,
    });
    const plan = await createInstallPlan(bundle, claudeAdapter, workspace);

    expect(plan.operations.map((operation) => `${operation.channel}:${operation.artifactType}:${operation.artifactName}`).sort()).toEqual([
      "addition:rules:local.md",
      "ejected:rules:ejected.md",
      "managed:skills:demo-skill",
      "overlay:instructions:AGENTS.md",
      "override:rules:core.md",
    ]);

    await applyInstallPlan(plan, bundle.sourceLock);
    const instructions = await readFile(join(workspace, "CLAUDE.md"), "utf8");
    expect(instructions).toContain("BEGIN agentwheel managed: upstream");
    expect(instructions).toContain("Local memory survives.");
    expect(await readFile(join(workspace, ".claude", "rules", "core.md"), "utf8")).toBe("# Overridden core\n");
    expect(await readFile(join(workspace, ".claude", "rules", "local.md"), "utf8")).toBe("# Local additive rule\n");

    await writePackage(source, { ejectedRule: "# Upstream changed ejected\n" });
    const updated = await stageSource(new LocalSourceDriver(), source, {
      workspaceRoot: workspace,
      adapter: claudeAdapter,
    });
    const updatePlan = await createInstallPlan(updated, claudeAdapter, workspace, await readInstallManifest(workspace, "claude"));
    const ejected = updatePlan.operations.find((operation) => operation.artifactName === "ejected.md");
    expect(ejected?.channel).toBe("ejected");
    expect(ejected?.action).toBe("skip");
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
