import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  await execFileAsync("pnpm", ["build"], { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
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
    expect(secondAlphaInstall.stdout).toContain("KEEP");
    await expect(readFile(alphaDest, "utf8")).resolves.toContain("alpha-v1");
    await expect(readFile(betaDest, "utf8")).resolves.toContain("beta-v1");
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

async function rulePackageFixture(name: string, content: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", `${name}.md`), `# ${content}\n`, "utf8");
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides: [{ type: "rules", path: "rules" }],
  }, null, 2)}\n`, "utf8");
  return root;
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
