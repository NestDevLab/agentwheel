import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";
const exec = promisify(execFile), cli = join(process.cwd(), "dist/index.js"), roots: string[] = [];
beforeAll(() => ensureCliBuild(cli), 120_000);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function graphLocks(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, item.name);
    if (item.isDirectory()) found.push(...await graphLocks(path));
    else if (item.name.endsWith(".graph-lock.json")) found.push(path);
  }
  return found;
}

/** Installs the selected skills, then moves their state under a legacy key with no stable graph lock left behind. */
async function legacyFixture(skills: string[]) {
  const root = await mkdtemp(join(tmpdir(), "aw-migrate-cli-")); roots.push(root);
  const workspace = join(root, "workspace"), target = join(root, "target"), pack = join(root, "pack"), home = join(root, "home");
  for (const path of [join(workspace, ".agentwheel"), target, home, ...skills.map(name => join(pack, "skills", name))]) await mkdir(path, { recursive: true });
  await writeFile(join(pack, "openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/migration", version: "1.0.0", provides: [{ type: "skills", path: "skills" }] }));
  for (const name of skills) await writeFile(join(pack, `skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Synthetic fixture\n---\nExample\n`);
  const configPath = join(workspace, ".agentwheel/config.json");
  const writeConfig = (select: string[]) => writeFile(configPath, JSON.stringify({ schemaVersion: 4, mutationPolicy: { reason: "required", journal: "required", revisioning: { mode: "off" } },
    agents: { example: { adapter: "claude", root: target, transport: "local" } },
    packages: [{ name: "example", driver: "local", source: pack, mode: "pinned", select }] }));
  await writeConfig(skills.map(name => `skills/${name}`));
  const run = (args: string[]) => exec(process.execPath, [cli, ...args, "--reason", "Verify synthetic migration CLI"], { cwd: workspace,
    env: { ...process.env, HOME: home, AGENTWHEEL_MUTATION_STATE_ROOT: join(root, "receipts") }, maxBuffer: 10 * 1024 * 1024 });
  await run(["install", "--agent", "example"]);
  const metadata = join(target, ".agentwheel"), current = (await readdir(metadata)).find(path => path.endsWith(".install-manifest.json"))!;
  const currentPath = join(metadata, current), legacyKey = "claude.local.legacy";
  const manifest = JSON.parse(await readFile(currentPath, "utf8")); manifest.stateKey = legacyKey;
  await writeFile(currentPath, JSON.stringify(manifest));
  await rename(currentPath, join(metadata, `${legacyKey}.install-manifest.json`));
  const locks = await graphLocks(join(workspace, ".agentwheel"));
  return { workspace, target, run, writeConfig, current, legacyKey, locks,
    args: ["ownership", "migrate-legacy", "--agent", "example", "--source-state-key", legacyKey] };
}

const applyArgs = (plan: { planDigest: string; source: { revision: string | null }; destination: { revision: string | null }; manifestInventoryRevision: string }) => [
  "--plan-digest", plan.planDigest, "--expected-source-revision", plan.source.revision ?? "absent",
  "--expected-destination-revision", plan.destination.revision ?? "absent", "--expected-inventory-revision", plan.manifestInventoryRevision, "--apply"];

it("migrates a configured target state and makes the next install dry-run managed", async () => {
  const { target, run, current, locks, args } = await legacyFixture(["example"]);
  expect(locks.length).toBeGreaterThan(0);
  await expect(run([...args, "--json"])).rejects.toThrow(/stable graph lock without a stable manifest/);
  for (const lock of locks) await rm(lock);
  const before = await readFile(join(target, ".claude/skills/example/SKILL.md"));
  const plan = JSON.parse((await run([...args, "--json"])).stdout);
  expect(plan.selected).toMatchObject([{ desired: true }]);
  expect(plan.desiredCoverage).toHaveLength(1);
  expect(plan.destination.stateKey).toBe(current.replace(".install-manifest.json", ""));
  expect(plan.applyCommand).toContain("--reason 'Verify synthetic migration CLI'");
  await run([...args, ...applyArgs(plan)]);
  expect(await readFile(join(target, ".claude/skills/example/SKILL.md"))).toEqual(before);
  const install = JSON.parse((await run(["install", "--agent", "example", "--dry-run", "--format", "json"])).stdout);
  expect(install.targets[0].hasBlockingChanges).toBe(false);
  expect(install.targets[0].operations[0].action).toBe("skip");
}, 60_000);

it("refuses entries the configured packages no longer install unless explicitly allowed", async () => {
  const { run, writeConfig, locks, args } = await legacyFixture(["example", "retired"]);
  for (const lock of locks) await rm(lock);
  await writeConfig(["skills/example"]);
  await expect(run([...args, "--json"])).rejects.toThrow(/no longer install \.claude\/skills\/retired/);
  const allowed = JSON.parse((await run([...args, "--allow-undesired", "--json"])).stdout);
  expect(allowed.allowUndesired).toBe(true);
  expect(allowed.selected.map((entry: { path: string; desired: boolean }) => [entry.path, entry.desired]))
    .toEqual([[".claude/skills/example", true], [".claude/skills/retired", false]]);
  expect(allowed.applyCommand).toContain("--allow-undesired");
  const strict = JSON.parse((await run([...args, "--path", ".claude/skills/example", "--json"])).stdout);
  expect(strict.planDigest).not.toBe(allowed.planDigest);
  await expect(run([...args, ...applyArgs({ ...strict, planDigest: allowed.planDigest }), "--path", ".claude/skills/example"])).rejects.toThrow(/Stale plan digest/);
  await run([...args, "--path", ".claude/skills/example", ...applyArgs(strict)]);
  const rerun = JSON.parse((await run([...args, "--path", ".claude/skills/example", "--json"])).stdout);
  expect(rerun.selected).toEqual([]);
  expect(rerun.alreadyMigrated).toMatchObject([{ path: ".claude/skills/example" }]);
  await run([...args, "--path", ".claude/skills/example", ...applyArgs(rerun)]);
}, 60_000);
