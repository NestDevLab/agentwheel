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
});

afterAll(async () => {
  if (cliHome) await rm(cliHome, { recursive: true, force: true });
});

describe("CLI verb redesign", () => {
  it("ensures a new source with install <source> and hides the sync shim from top-level help", async () => {
    const root = await tempRoot();
    const source = await packageFixture("ensure");
    const { stdout } = await runCli(["install", source, "--adapter", "codex", "--target-root", root]);

    expect(stdout).toContain("Applied codex");
    expect(await readFile(join(root, ".codex", "AGENTS.md"), "utf8")).toContain("ensure");
    const config = JSON.parse(await readFile(join(root, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages[0].source).toBe(source);

    const help = await runCli(["--help"]);
    expect(help.stdout).toContain("install [options] [name-or-source]");
    expect(help.stdout).not.toContain(" sync ");
  });

  it("forwards the hidden sync shim with a deprecation warning", async () => {
    const root = await tempRoot();
    const source = await packageFixture("shim");
    const { stderr, stdout } = await runCli(["sync", source, "--adapter", "codex", "--target-root", root]);

    expect(stderr).toContain(`warning: 'agentwheel ${"sync"}' is deprecated`);
    expect(stdout).toContain("Applied codex");
    expect(await readFile(join(root, ".codex", "AGENTS.md"), "utf8")).toContain("shim");
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

    const { stdout } = await runCli(["plan", source, "--adapter", "codex", "--target-root", root, "--only-source", "--no-deps"]);
    expect(stdout).toContain("WARN    --no-deps ignored dependencies");
    expect(stdout).toContain("RESOLVE root@");
    expect(stdout).not.toContain("RESOLVE dep@");
  });

  it("uses the graph lock for install and re-resolves tracking packages on update", async () => {
    const workspace = await tempRoot();
    const repo = await gitPackageFixture("v1");
    await runCli(["add", `git:${repo}#main`, "--adapter", "codex", "--target-root", workspace, "--mode", "tracking"]);
    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    await writeFile(join(repo, "instructions", "AGENTS.md"), "# v2\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "v2"]);

    const install = await runCli(["install", "--adapter", "codex", "--target-root", workspace, "--dry-run"]);
    expect(install.stdout).toContain("SKIP");
    expect(install.stdout).not.toContain("UPDATE");

    const update = await runCli(["update", "--adapter", "codex", "--target-root", workspace, "--dry-run"]);
    expect(update.stdout).toContain("UPDATE");
  });

  it("scopes install <name> without installing or removing other configured packages", async () => {
    const workspace = await tempRoot();
    const alpha = await rulePackageFixture("scoped-alpha", "alpha-v1");
    const beta = await rulePackageFixture("scoped-beta", "beta-v1");
    const alphaDest = join(workspace, ".codex", "rules", "scoped-alpha.md");
    const betaDest = join(workspace, ".codex", "rules", "scoped-beta.md");

    await runCli(["add", alpha, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--target-root", workspace]);

    const alphaInstall = await runCli(["install", "scoped-alpha", "--adapter", "codex", "--target-root", workspace]);
    expect(alphaInstall.stdout).toContain("CREATE");
    await expect(readFile(alphaDest, "utf8")).resolves.toContain("alpha-v1");
    await expect(readFile(betaDest, "utf8")).rejects.toThrow();

    await runCli(["install", "scoped-beta", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta-v1");

    const secondAlphaInstall = await runCli(["install", "scoped-alpha", "--adapter", "codex", "--target-root", workspace]);
    expect(secondAlphaInstall.stdout).toContain("SKIP");
    await expect(readFile(alphaDest, "utf8")).resolves.toContain("alpha-v1");
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta-v1");
  });

  it("scoped install converges out-of-scope ownership without touching shared content", async () => {
    const workspace = await tempRoot();
    const shared = await rulePackageFixture("scope-shared", "shared-v1");
    const rootA = await rulePackageFixture("scope-owner-a", "owner-a", {
      requires: { shared: { source: shared, select: ["rules/scope-shared.md"] } },
    });
    const rootB = await rulePackageFixture("scope-owner-b", "owner-b", {
      requires: { shared: { source: shared, select: ["rules/scope-shared.md"] } },
    });
    const sharedDest = join(workspace, ".codex", "rules", "scope-shared.md");

    await runCli(["add", rootA, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["add", rootB, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--target-root", workspace, "--yes"]);
    const before = manifestEntry(await readCodexManifest(workspace), ".codex/rules/scope-shared.md");
    expect(before.owners.filter((owner: string) => owner.includes("scope-owner-"))).toHaveLength(2);

    await writeRuleManifest(rootA, "scope-owner-a");
    await runCli(["install", "scope-owner-a", "--adapter", "codex", "--target-root", workspace, "--yes"]);

    await expect(readFile(sharedDest, "utf8")).resolves.toContain("shared-v1");
    const after = manifestEntry(await readCodexManifest(workspace), ".codex/rules/scope-shared.md");
    expect(after.owners.some((owner: string) => owner.includes("scope-owner-a"))).toBe(false);
    expect(after.owners.some((owner: string) => owner.includes("scope-owner-b"))).toBe(true);

    await runCli(["uninstall", "scope-owner-a", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(sharedDest, "utf8")).resolves.toContain("shared-v1");
    await runCli(["uninstall", "scope-owner-b", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(sharedDest, "utf8")).rejects.toThrow();
  });

  it("installs and uninstalls local meta-packages through selected dependencies", async () => {
    const workspace = await tempRoot();
    const dep = await rulePackageFixture("dep", "dep");
    const meta = await metaPackageFixture("meta-pack", {
      dep: { source: dep, select: ["rules/dep.md"] },
    });
    const depDest = join(workspace, ".codex", "rules", "dep.md");
    const before = await runtimeFiles(workspace);

    await runCli(["install", meta, "--adapter", "codex", "--target-root", workspace, "--yes"]);
    await expect(readFile(depDest, "utf8")).resolves.toContain("# dep");
    const manifest = await readCodexManifest(workspace);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([".codex/rules/dep.md"]);

    await runCli(["uninstall", "meta-pack", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(depDest, "utf8")).rejects.toThrow();
    expect(await runtimeFiles(workspace)).toEqual(before);
  });

  it("scoped install preserves out-of-scope merge update hashes until full install", async () => {
    const workspace = await tempRoot();
    const alpha = await packageFixture("scope-update-a");
    const beta = await mcpPackageFixture("scope-update-b", "scope-update-v1");
    const configPath = join(workspace, ".codex", "config.toml");

    await runCli(["add", alpha, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    const before = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v1"');

    await writeMcpPackage(beta, "scope-update-b", "scope-update-v2");
    await runCli(["install", "scope-update-a", "--adapter", "codex", "--target-root", workspace]);

    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v1"');
    expect(await readFile(configPath, "utf8")).not.toContain("scope-update-v2");
    const scoped = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(scoped.hash).toBe(before.hash);
    expect(scoped.sourceHash).toBe(before.sourceHash);

    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    expect(await readFile(configPath, "utf8")).toContain('command = "scope-update-v2"');
    const full = manifestEntry(await readCodexManifest(workspace), ".codex/config.toml");
    expect(full.sourceHash).not.toBe(before.sourceHash);
  });

  it("scoped install does not let out-of-scope drift block or disappear", async () => {
    const workspace = await tempRoot();
    const alpha = await rulePackageFixture("scope-drift-a", "alpha");
    const beta = await rulePackageFixture("scope-drift-b", "beta");
    const betaDest = join(workspace, ".codex", "rules", "scope-drift-b.md");

    await runCli(["add", alpha, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    await writeFile(betaDest, "# local drift\n", "utf8");

    const scoped = await runCli(["install", "scope-drift-a", "--adapter", "codex", "--target-root", workspace]);
    expect(scoped.stdout).toContain("Applied codex");
    await expect(runCli(["plan", "--adapter", "codex", "--target-root", workspace])).rejects.toMatchObject({
      stdout: expect.stringContaining("DRIFT"),
    });
  });

  it("scoped install preserves out-of-scope removals until full install", async () => {
    const workspace = await tempRoot();
    const alpha = await rulePackageFixture("scope-remove-a", "alpha");
    const beta = await rulePackageFixture("scope-remove-b", "beta");
    const betaDest = join(workspace, ".codex", "rules", "scope-remove-b.md");

    await runCli(["add", alpha, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["add", beta, "--adapter", "codex", "--target-root", workspace]);
    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    await removeConfiguredPackage(workspace, "scope-remove-b");

    await runCli(["install", "scope-remove-a", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta");
    expect(manifestEntry(await readCodexManifest(workspace), ".codex/rules/scope-remove-b.md")).toBeTruthy();

    await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    await expect(readFile(betaDest, "utf8")).rejects.toThrow();
    expect((await readCodexManifest(workspace)).entries.some((entry: { path: string }) => entry.path === ".codex/rules/scope-remove-b.md")).toBe(false);
  });

  it("keeps status read-only even when configured packages have untrusted dependencies", async () => {
    const workspace = await tempRoot();
    const dep = await rulePackageFixture("status-dep", "dep");
    const source = await packageFixture("status-root", {
      requires: { dep: { source: dep, select: ["rules/status-dep.md"] } },
    });
    await runCli(["add", source, "--adapter", "codex", "--target-root", workspace]);

    const status = await runCli(["status", "--adapter", "codex", "--target-root", workspace]);

    expect(status.stdout).toContain("Status for codex");
    expect(status.stdout).toContain("status-root");
    expect(status.stdout).toContain("Install manifest: missing");
    expect(status.stdout).toContain("Pending install work:");
  });

  it("rejects conflicting uninstall --keep-files and --force flags", async () => {
    await expect(runCli(["uninstall", "anything", "--keep-files", "--force", "--target-root", await tempRoot()])).rejects.toMatchObject({
      stderr: expect.stringContaining("--keep-files cannot be combined with --force."),
    });
  });

  it("does not persist a new source when install source preflight is offline", async () => {
    const workspace = await tempRoot();
    const repo = await gitPackageFixture("offline-new");

    await expect(runCli(["install", `git:${repo}#main`, "--adapter", "codex", "--target-root", workspace, "--offline"])).rejects.toMatchObject({
      stderr: expect.stringContaining("requires cached git checkout"),
    });
    await expect(readFile(join(workspace, ".agentwheel", "config.json"), "utf8")).rejects.toThrow();
  });

  it("uninstall --keep-files removes management state but leaves runtime files alone", async () => {
    const workspace = await tempRoot();
    const source = await packageFixture("keep-files");
    await runCli(["install", source, "--adapter", "codex", "--target-root", workspace]);

    await runCli(["uninstall", "keep-files", "--adapter", "codex", "--target-root", workspace, "--keep-files"]);
    await expect(readFile(join(workspace, ".codex", "AGENTS.md"), "utf8")).resolves.toContain("keep-files");
    const config = JSON.parse(await readFile(join(workspace, ".agentwheel", "config.json"), "utf8"));
    expect(config.packages).toEqual([]);

    const followUp = await runCli(["install", "--adapter", "codex", "--target-root", workspace]);
    expect(followUp.stdout).toContain("No packages configured");
    await expect(readFile(join(workspace, ".codex", "AGENTS.md"), "utf8")).resolves.toContain("keep-files");
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

async function rulePackageFixture(name: string, content: string, options: { requires?: unknown } = {}): Promise<string> {
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

async function writeRuleManifest(root: string, name: string, options: { requires?: unknown } = {}): Promise<void> {
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    requires: options.requires,
    provides: [{ type: "rules", path: "rules" }],
  }, null, 2)}\n`, "utf8");
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
  return JSON.parse(await readFile(join(workspace, ".agentwheel", "codex.install-manifest.json"), "utf8")) as TestManifest;
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
