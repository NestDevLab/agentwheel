import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { createSourcePlan } from "../src/lifecycle/source-plan.js";
import { RegistryClient, mergeIndexes, resolvePackageSource } from "../src/registry/client.js";
import { getSourceDriver } from "../src/source/index.js";
import { inferSourceDriverName } from "../src/source/identify.js";
import { stageSource } from "../src/staging/staging.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-registry-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeIndex(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, "utf8");
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Offline registry test skill for ${name}.`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"), "utf8");
}

async function writePackage(dir: string): Promise<void> {
  await mkdir(join(dir, "rules"), { recursive: true });
  await mkdir(join(dir, "skills", "demo-skill"), { recursive: true });
  await writeFile(join(dir, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "fixture/short-package",
    version: "0.1.0",
    provides: [
      { type: "instructions", path: "AGENTS.md" },
      { type: "rules", path: "rules" },
      { type: "skills", path: "skills" },
    ],
  }, null, 2), "utf8");
  await writeFile(join(dir, "AGENTS.md"), "# Fixture instructions\n", "utf8");
  await writeFile(join(dir, "rules", "core.md"), "# Fixture rule\n", "utf8");
  await writeFile(join(dir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Fixture skill for tests.\n---\n\n# Fixture skill\n", "utf8");
}

describe("registry client", () => {
  it("caches indexes and refreshes after TTL expiry", async () => {
    const root = await tempRoot();
    const indexPath = join(root, "index.json");
    const cachePath = join(root, "cache.json");
    await writeIndex(indexPath, [
      { name: "one", source: "skillkit:./one", type: "skill", description: "First entry" },
    ]);

    let now = new Date("2026-06-08T00:00:00.000Z");
    const client = new RegistryClient({ sources: [indexPath], cachePath, ttlMs: 1000, now: () => now });
    expect((await client.getIndex()).entries.map((entry) => entry.name)).toEqual(["one"]);

    await writeIndex(indexPath, [
      { name: "two", source: "skillkit:./two", type: "skill", description: "Second entry" },
    ]);
    expect((await client.getIndex()).entries.map((entry) => entry.name)).toEqual(["one"]);

    now = new Date("2026-06-08T00:00:02.000Z");
    const refreshed = await client.getIndex();
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.entries.map((entry) => entry.name)).toEqual(["two"]);
  });

  it("merges multiple indexes with earlier sources taking precedence", () => {
    const entries = mergeIndexes([
      [
        { name: "shared", source: "skillkit:./first", type: "skill", description: "First wins", tags: [] },
        { name: "only-first", source: "git:./first", type: "package", description: "Only first", tags: [] },
      ],
      [
        { name: "shared", source: "skillkit:./second", type: "skill", description: "Second loses", tags: [] },
        { name: "only-second", source: "vercel:owner/repo", type: "skill", description: "Only second", tags: [] },
      ],
    ]);

    expect(entries.map((entry) => `${entry.name}:${entry.source}`)).toEqual([
      "only-first:git:./first",
      "only-second:vercel:owner/repo",
      "shared:skillkit:./first",
    ]);
  });

  it("resolves a short-name to its source and syncs via the delegated driver", async () => {
    const root = await tempRoot();
    const source = join(root, "skill-source");
    const target = join(root, "target");
    await writeSkill(join(source, "demo"), "demo");
    await writeIndex(join(root, "index.json"), [
      { name: "demo-skill", source: `skillkit:${source}`, type: "skill", description: "Demo skill", tags: ["demo"] },
    ]);
    await mkdir(join(root, ".agentwheel"), { recursive: true });
    await writeFile(join(root, ".agentwheel", "config.json"), JSON.stringify({
      schemaVersion: 1,
      packages: [],
      registry: { sources: [join(root, "index.json")] },
    }, null, 2));

    const resolved = await resolvePackageSource("demo-skill", root);
    expect(resolved.source).toBe(`skillkit:${source}`);
    expect(resolved.registryEntry?.name).toBe("demo-skill");

    const driver = getSourceDriver(inferSourceDriverName(resolved.source));
    const bundle = await stageSource(driver, resolved.source);
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    await applyInstallPlan(plan, bundle.sourceLock);

    await expect(stat(join(target, "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("plans a package source from a registry short-name like add does", async () => {
    const root = await tempRoot();
    const source = join(root, "package-source");
    const target = join(root, "target");
    await writePackage(source);
    await writeIndex(join(root, "index.json"), [
      { name: "short-package", source, type: "package", description: "Short package", tags: ["test"] },
    ]);
    await mkdir(join(target, ".agentwheel"), { recursive: true });
    await writeFile(join(target, ".agentwheel", "config.json"), JSON.stringify({
      schemaVersion: 1,
      packages: [],
      registry: { sources: [join(root, "index.json")] },
    }, null, 2));

    const result = await createSourcePlan({
      source: "short-package",
      targetRoot: target,
      adapter: claudeAdapter,
    });

    expect(result.resolvedSource).toBe(source);
    expect(result.registryEntryName).toBe("short-package");
    expect(result.plan.operations.map((operation) => `${operation.action}:${operation.relativeDestPath}`)).toEqual([
      "create:.claude/rules/core.md",
      "create:.claude/skills/demo-skill",
      "create:CLAUDE.md",
    ]);
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("reads registry indexes from a local git repository without network", async () => {
    const repo = await tempRoot("agentwheel-registry-git-");
    const cacheRoot = await tempRoot("agentwheel-registry-cache-");
    await writeIndex(join(repo, "index.json"), [
      { name: "git-entry", source: "vercel:owner/repo", type: "skill", description: "From git index" },
    ]);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "registry-test"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "index"]);

    const client = new RegistryClient({
      sources: [`git:${repo}#main`],
      cachePath: join(cacheRoot, "registry-cache.json"),
      ttlMs: 1000,
    });
    expect((await client.getIndex({ refresh: true })).entries[0]?.name).toBe("git-entry");
  });

  it("bypasses the registry for explicit sources", async () => {
    const root = await tempRoot();
    await writeIndex(join(root, "index.json"), [
      { name: "skillkit:./explicit", source: "git:./wrong", type: "skill", description: "Should not be used" },
    ]);

    const explicit = await resolvePackageSource("skillkit:./explicit", root);
    expect(explicit.source).toBe("skillkit:./explicit");
    expect(explicit.registryEntry).toBeUndefined();

    const git = await resolvePackageSource("git:./explicit.git#main", root);
    expect(git.source).toBe("git:./explicit.git#main");
    expect(git.registryEntry).toBeUndefined();
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
