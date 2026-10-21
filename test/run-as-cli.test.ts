import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "dist", "index.js");
const roots: string[] = [];

beforeAll(async () => { await ensureCliBuild(cli); }, 120_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ workspace: string; target: string; home: string; config: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), "aw-runas-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const target = join(root, "target");
  const home = join(root, "home");
  const pack = join(root, "pack");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true });
  await mkdir(target);
  await mkdir(home);
  await mkdir(join(pack, "skills", "fixture"), { recursive: true });
  await writeFile(join(pack, "openpack.json"), `${JSON.stringify({ schemaVersion: 2, name: "fixture/run-as-cli", version: "1.0.0", provides: [{ type: "skills", path: "skills" }] })}\n`);
  await writeFile(join(pack, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: Run-as CLI fixture.\n---\n\nFixture.\n");
  const config: Record<string, unknown> = {
    schemaVersion: 4,
    packages: [{ name: "fixture", source: pack, driver: "local", mode: "pinned", adapter: "openclaw", installationType: "local" }],
    agents: { service: { adapter: "openclaw", root: target, transport: "local", installationType: "local" } },
    profiles: { service: { runtimes: [{ agent: "service" }] } },
  };
  return { workspace, target, home, config };
}

async function runCli(workspace: string, home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, "--no-update-check", ...args], {
      cwd: workspace, env: { ...process.env, HOME: home }, maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function writeConfig(workspace: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify(config)}\n`);
}

describe("run-as CLI safeguards", () => {
  it("allows recovery-plan without --fleet for a nested non-Fleet workspace", async () => {
    const { workspace, target, home, config } = await fixture();
    await writeConfig(workspace, config);
    const report = join(workspace, "recovery.json");
    const result = await runCli(workspace, home, ["ownership", "recovery-plan", "--profile", "service", "--report", report]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ targetRoot: target });
  }, 60_000);

  it("requires --fleet when the resolved workspace is a Fleet", async () => {
    const { workspace, target, home, config } = await fixture();
    await writeConfig(workspace, { ...config, fleetId: "service-fleet" });
    const result = await runCli(workspace, home, ["ownership", "recovery-plan", "--profile", "service", "--report", join(workspace, "recovery.json")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--fleet <id>/);
    await mkdir(join(home, ".agentwheel"));
    await writeFile(join(home, ".agentwheel", "config.json"), `${JSON.stringify({
      schemaVersion: 4, fleets: { "service-fleet": { root: workspace, requiredPackages: ["fixture"] } },
    })}\n`);
    const report = join(workspace, "fleet-recovery.json");
    const selected = await runCli(workspace, home, ["ownership", "recovery-plan", "--fleet", "service-fleet", "--profile", "service", "--report", report]);
    expect(selected.code, selected.stderr).toBe(0);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ targetRoot: target });
  });

  it.skipIf(process.getuid?.() === 0)("refuses profile reload before touching a local-run-as target", async () => {
    const { workspace, target, home, config } = await fixture();
    config.agents = { service: { adapter: "openclaw", root: target, transport: "local-run-as", runAs: userInfo().username, installationType: "user" } };
    await writeConfig(workspace, config);
    const result = await runCli(workspace, home, ["install", "--profile", "service", "--reload-runtimes"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/local-run-as refuses.*reload/);
    expect(await readdir(target)).toEqual([]);
  });
});
