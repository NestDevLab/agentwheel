import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execute = promisify(execFile);
const cli = join(process.cwd(), "dist/index.js");
const roots: string[] = [];
beforeAll(() => ensureCliBuild(cli), 120_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("ordinary install adoption", () => {
  it("adopts unmanaged skills and managed instruction blocks while preserving the user's prefix", async () => {
    const f = await fixture();
    const state = JSON.parse(await readFile(f.manifest, "utf8"));
    state.entries = [];
    await writeFile(f.manifest, JSON.stringify(state));
    const prefix = "# Local owner notes\n\nKeep this exact prefix.\n\n";
    const instructionBefore = prefix + await readFile(f.instructions, "utf8");
    await writeFile(f.instructions, instructionBefore);
    await writeFile(f.skill, "Unmanaged older body.\n");
    const configBefore = await readFile(f.config);
    const before = await files(f.target);
    const plain = await run(f, ["install", "--agent", "demo", "--dry-run", "--format", "json"], true);
    expect(plain.code).not.toBe(0);
    const plan = await run(f, ["plan", "--agent", "demo", "--adopt", "--format", "json"]);
    expect(JSON.parse(plan.stdout).targets[0].hasBlockingChanges).toBe(false);
    const preview = await run(f, ["install", "--agent", "demo", "--adopt", "--dry-run", "--format", "json"]);
    expect(JSON.parse(preview.stdout).targets[0].hasBlockingChanges).toBe(false);
    expect(await files(f.target)).toEqual(before);
    expect(await readFile(f.config)).toEqual(configBefore);
    await run(f, ["install", "--agent", "demo", "--adopt"]);
    expect(await readFile(f.instructions, "utf8")).toBe(instructionBefore);
    expect(await readFile(f.skill, "utf8")).toMatch(/Current source body/);
    const ordinary = JSON.parse((await run(f, ["install", "--agent", "demo", "--dry-run", "--format", "json"])).stdout);
    expect(ordinary.targets[0].hasBlockingChanges).toBe(false);
    expect(ordinary.targets[0].operations.map((item: { action: string }) => item.action)).toEqual(["skip", "skip"]);
  }, 60_000);

  it("adds an unmanaged instruction block without removing an existing plain prefix", async () => {
    const f = await fixture();
    const state = JSON.parse(await readFile(f.manifest, "utf8"));
    state.entries = [];
    await writeFile(f.manifest, JSON.stringify(state));
    const prefix = "Existing owner guidance.\n";
    await writeFile(f.instructions, prefix);
    await run(f, ["install", "--agent", "demo", "--adopt"]);
    const installed = await readFile(f.instructions, "utf8");
    expect(installed.startsWith(prefix)).toBe(true);
    expect(installed).toContain("Source instruction body.");
  }, 60_000);

  it("still rejects managed drift with --adopt", async () => {
    const f = await fixture();
    await writeFile(f.skill, "Managed local edit.\n");
    const before = await files(f.target);
    const result = await run(f, ["install", "--agent", "demo", "--adopt"], true);
    expect(result.code).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/drift/);
    expect(await files(f.target)).toEqual(before);
  }, 60_000);

  it("still rejects foreign ownership with --adopt", async () => {
    const f = await fixture();
    const state = JSON.parse(await readFile(f.manifest, "utf8"));
    for (const entry of state.entries) entry.workspaceOwner = `workspace-root:${join(f.root, "foreign-owner")}`;
    state.stateKey = "codex.local.foreign";
    await writeFile(join(f.target, ".agentwheel/codex.local.foreign.install-manifest.json"), JSON.stringify(state));
    await rm(f.manifest);
    const before = await files(f.target);
    const result = await run(f, ["install", "--agent", "demo", "--adopt"], true);
    expect(result.code).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/another workspace|foreign|owner/i);
    expect(await files(f.target)).toEqual(before);
  }, 60_000);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-install-adopt-")); roots.push(root);
  const workspace = join(root, "workspace"); const target = join(root, "target"); const home = join(root, "home"); const pack = join(root, "pack");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true }); await mkdir(home);
  await mkdir(join(pack, "skills/alpha"), { recursive: true }); await mkdir(join(pack, "instructions"));
  await writeFile(join(pack, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: Generic adoption fixture.\n---\nCurrent source body.\n");
  await writeFile(join(pack, "instructions/AGENTS.md"), "Source instruction body.\n");
  await writeFile(join(pack, "openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/adopt", version: "1.0.0", provides: [{ type: "skills", path: "skills" }, { type: "instructions", path: "instructions/AGENTS.md" }] }));
  const config = join(workspace, ".agentwheel/config.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 4, agents: { demo: { adapter: "codex", root: target, transport: "local" } }, packages: [{ name: "demo", driver: "local", source: pack, mode: "pinned" }] }));
  const initial = { root, workspace, target, home };
  await run(initial, ["install", "--agent", "demo"]);
  const stateName = (await readdir(join(target, ".agentwheel"))).find((name) => name.endsWith(".install-manifest.json"))!;
  return { ...initial, config, manifest: join(target, ".agentwheel", stateName), instructions: join(target, "AGENTS.md"), skill: join(target, ".agents/skills/alpha/SKILL.md") };
}
async function run(f: { workspace: string; home: string }, args: string[], allowFailure = false) {
  try {
    const result = await execute(process.execPath, [cli, "--no-update-check", ...args], {
      cwd: f.workspace,
      env: { ...process.env, HOME: f.home, AGENTWHEEL_TEST_HOME: "", XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache"), XDG_STATE_HOME: join(f.home, ".local/state"), AGENTWHEEL_MUTATION_STATE_ROOT: join(f.home, "mutations") },
      maxBuffer: 8 * 1024 * 1024,
    }); return { ...result, code: 0 };
  } catch (error) {
    if (!allowFailure) throw error;
    return error as unknown as { stdout: string; stderr: string; code: number };
  }
}
async function files(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else output[child] = (await readFile(child)).toString("base64");
    }
  }
  await visit(root); return output;
}
