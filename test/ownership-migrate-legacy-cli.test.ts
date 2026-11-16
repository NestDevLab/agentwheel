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
it("migrates a configured target state and makes the next install dry-run managed", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-migrate-cli-")); roots.push(root);
  const workspace = join(root, "workspace"), target = join(root, "target"), pack = join(root, "pack"), home = join(root, "home");
  for (const path of [join(workspace, ".agentwheel"), join(pack, "skills/example"), target, home]) await mkdir(path, { recursive: true });
  await writeFile(join(pack, "openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/migration", version: "1.0.0", provides: [{ type: "skills", path: "skills" }] }));
  await writeFile(join(pack, "skills/example/SKILL.md"), "---\nname: example\ndescription: Synthetic fixture\n---\nExample\n");
  await writeFile(join(workspace, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4,
    agents: { example: { adapter: "claude", root: target, transport: "local" } },
    packages: [{ name: "example", driver: "local", source: pack, mode: "pinned", select: ["skills/example"] }] }));
  const run = (args: string[]) => exec(process.execPath, [cli, ...args], { cwd: workspace,
    env: { ...process.env, HOME: home, AGENTWHEEL_MUTATION_STATE_ROOT: join(root, "receipts") }, maxBuffer: 10 * 1024 * 1024 });
  await run(["install", "--agent", "example"]);
  const metadata = join(target, ".agentwheel"), current = (await readdir(metadata)).find(path => path.endsWith(".install-manifest.json"))!;
  const currentPath = join(metadata, current), legacyKey = "claude.local.legacy";
  const manifest = JSON.parse(await readFile(currentPath, "utf8")); manifest.stateKey = legacyKey;
  await writeFile(currentPath, JSON.stringify(manifest));
  await rename(currentPath, join(metadata, `${legacyKey}.install-manifest.json`));
  const before = await readFile(join(target, ".claude/skills/example/SKILL.md"));
  const args = ["ownership", "migrate-legacy", "--agent", "example", "--source-state-key", legacyKey];
  const plan = JSON.parse((await run([...args, "--json"])).stdout);
  expect(plan.selected).toHaveLength(1);
  expect(plan.destination.stateKey).toBe(current.replace(".install-manifest.json", ""));
  await run([...args, "--plan-digest", plan.planDigest, "--expected-source-revision", plan.source.revision,
    "--expected-destination-revision", "absent", "--expected-inventory-revision", plan.manifestInventoryRevision, "--apply"]);
  expect(await readFile(join(target, ".claude/skills/example/SKILL.md"))).toEqual(before);
  const install = JSON.parse((await run(["install", "--agent", "example", "--dry-run", "--format", "json"])).stdout);
  expect(install.targets[0].hasBlockingChanges).toBe(false);
  expect(install.targets[0].operations[0].action).toBe("skip");
}, 60_000);
