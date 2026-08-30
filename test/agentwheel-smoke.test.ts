import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agentwheel-smoke workspace scope", () => {
  it.each([
    ["user", [".agents", "skills", "agentwheel-smoke"], "--user"],
    ["local", ["workspace", ".agents", "skills", "agentwheel-smoke"], "--local"],
  ])("defaults a %s installation to its explicit scope", async (_name, segments, expected) => {
    const fixture = await smokeFixture(segments);
    const report = await runSmoke(fixture);

    expect(report.agentwheel.status.args).toEqual([expected]);
    expect(report.agentwheel.status.ok).toBe(true);
  });

  it("passes an explicitly selected fleet to status", async () => {
    const fixture = await smokeFixture([".agents", "skills", "agentwheel-smoke"]);
    const report = await runSmoke(fixture, ["--fleet", "delivery"]);

    expect(report.agentwheel.status.args).toEqual(["--fleet", "delivery"]);
  });

  it.each([
    ["--agent", "ct107-codex"],
    ["--profile", "codex-standalone"],
  ])("keeps project config scope for %s", async (selector, value) => {
    const fixture = await smokeFixture([".agents", "skills", "agentwheel-smoke"], true);
    const report = await runSmoke(fixture, [selector, value]);

    expect(report.agentwheel.status.args).toEqual(["--fleet", "test-fleet", selector, value]);
    expect(report.agentwheel.status.ok).toBe(true);
  });
});

async function smokeFixture(skillSegments: string[], projectConfig = false) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-smoke-"));
  fixtures.push(root);
  const home = join(root, "home");
  const cwd = join(home, "workspace");
  const skillRoot = join(home, ...skillSegments);
  const script = join(skillRoot, "scripts", "smoke.mjs");
  const bin = join(root, "bin");
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await mkdir(join(home, ".agentwheel"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(join(process.cwd(), "skills", "agentwheel-smoke", "scripts", "smoke.mjs"), script);
  await writeFile(join(home, ".agentwheel", "config.json"), '{"schemaVersion":1,"packages":[]}\n');
  if (projectConfig) {
    await mkdir(join(cwd, ".agentwheel"), { recursive: true });
    await writeFile(join(cwd, ".agentwheel", "config.json"), '{"schemaVersion":3,"fleetId":"test-fleet","agents":{"ct107-codex":{}},"profiles":{"codex-standalone":{}}}\n');
  }
  await writeFile(
    join(bin, "agentwheel"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.18.0; else echo "Install manifest: /tmp/fake"; fi\n',
    { mode: 0o755 },
  );
  return { bin, cwd, home, script };
}

async function runSmoke(
  fixture: Awaited<ReturnType<typeof smokeFixture>>,
  args: string[] = [],
): Promise<{ agentwheel: { status: { args: string[]; ok: boolean } } }> {
  const { stdout } = await execFileAsync(process.execPath, [fixture.script, "--json", ...args], {
    cwd: fixture.cwd,
    env: { ...process.env, HOME: fixture.home, PATH: `${fixture.bin}:${process.env.PATH ?? ""}` },
  });
  return JSON.parse(stdout);
}
