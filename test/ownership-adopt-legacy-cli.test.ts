import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "dist", "index.js");
const tempRoots: string[] = [];
const agent = "fixture-claude";
const legacyPath = ".claude/skills/fixture-skill";

beforeAll(async () => {
  await ensureCliBuild(cli);
}, 120_000);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ownership adopt-legacy CLI", () => {
  it("plans desired coverage with the package adapter configuration install uses", async () => {
    const fixture = await createFixture();

    await configureNested(fixture, [{ name: "fixture-pack", adapterConfig: await writeAdapterConfig(fixture, "moved.json", ".claude/alt-skills") }]);
    const planned = await runCli(["install", "--agent", agent, "--dry-run", "--format", "json"], fixture);
    expect(JSON.parse(planned.stdout).targets[0].operations.map((operation: { relativeDestPath: string }) => operation.relativeDestPath))
      .toEqual([".claude/alt-skills/fixture-skill"]);
    const stateBefore = await runtimeStateFiles(fixture);
    const moved = await runCli(adoptArgs(fixture), fixture, { allowFailure: true });
    expect(moved.code).not.toBe(0);
    expect(moved.stderr).toMatch(/Nothing to adopt: no entry owned by .* is desired by this workspace/);
    expect(await runtimeStateFiles(fixture)).toEqual(stateBefore);

    await configureNested(fixture, [{ name: "fixture-pack", adapterConfig: await writeAdapterConfig(fixture, "same.json", ".claude/skills") }]);
    const plan = JSON.parse((await runCli([...adoptArgs(fixture), "--json"], fixture)).stdout);
    expect(plan.selected).toMatchObject([{ path: legacyPath, action: "adopt", drift: false }]);
    await runCli(shellWords(plan.applyCommand).slice(1), fixture);
    expect(await runtimeStateFiles(fixture)).toEqual([`${plan.destination.stateKey}.install-manifest.json`]);

    const install = JSON.parse((await runCli(["install", "--agent", agent, "--dry-run", "--format", "json"], fixture)).stdout);
    expect(install.targets).toHaveLength(1);
    expect(install.targets[0].hasBlockingChanges).toBe(false);
    expect(install.targets[0].operations.map((operation: { relativeDestPath: string; action: string }) =>
      [operation.relativeDestPath, operation.action])).toEqual([[legacyPath, "skip"]]);
    await runCli(["install", "--agent", agent], fixture);
    expect((await runtimeStateFiles(fixture)).filter((name) => name.endsWith(".install-manifest.json")))
      .toEqual([`${plan.destination.stateKey}.install-manifest.json`]);
  }, 60_000);

  it("refuses when packages resolve to more than one adapter configuration", async () => {
    const fixture = await createFixture();
    await configureNested(fixture, [
      { name: "fixture-pack" },
      { name: "fixture-pack-moved", adapterConfig: await writeAdapterConfig(fixture, "moved.json", ".claude/alt-skills") },
    ]);
    const result = await runCli(adoptArgs(fixture), fixture, { allowFailure: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/resolve to 2 adapter configurations for local/);
  }, 60_000);

  it("refuses packages with more than one installation type, with or without --installation-type", async () => {
    const fixture = await createFixture([{ name: "fixture-pack" }, { name: "second-pack", skill: "second-skill" }]);
    await configureNested(fixture, [
      { name: "fixture-pack" },
      { name: "second-pack", skill: "second-skill", installationType: "user" },
    ]);
    const before = await stateSnapshot(fixture);
    for (const extra of [[], ["-i", "local"], ["-i", "user"]]) {
      const result = await runCli([...adoptArgs(fixture), ...extra, "--json"], fixture, { allowFailure: true });
      const variant = extra.join(" ") || "without --installation-type";
      expect.soft(result.code, variant).not.toBe(0);
      expect.soft(result.stderr, variant).toMatch(/Configured packages use installation types local, user, each with its own install state/);
      expect.soft(result.stderr, variant).not.toMatch(/pass --installation-type/);
    }
    expect(await stateSnapshot(fixture)).toEqual(before);
  }, 60_000);

  it("refuses an installation type other than the one install uses for the packages", async () => {
    const fixture = await createFixture();
    await configureNested(fixture, [{ name: "fixture-pack" }]);
    const before = await stateSnapshot(fixture);
    const refused = await runCli([...adoptArgs(fixture), "-i", "user"], fixture, { allowFailure: true });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/--installation-type user does not match installation type local/);
    expect(await stateSnapshot(fixture)).toEqual(before);

    const plan = JSON.parse((await runCli([...adoptArgs(fixture), "-i", "local", "--json"], fixture)).stdout);
    expect(plan.selected).toMatchObject([{ path: legacyPath, action: "adopt" }]);
  }, 60_000);
});

interface CliFixture {
  root: string;
  home: string;
  pack: string;
  scratch: string;
  nested: string;
  runtime: string;
  legacyKey: string;
}

async function createFixture(scratchPackages: FixturePackage[] = [{ name: "fixture-pack" }]): Promise<CliFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentwheel-adopt-cli-")));
  tempRoots.push(root);
  const fixture = {
    root,
    home: join(root, "home"),
    pack: join(root, "pack"),
    scratch: join(root, "scratch"),
    nested: join(root, "nested"),
    runtime: join(root, "runtime"),
    legacyKey: "",
  };
  await mkdir(fixture.home, { recursive: true });
  await mkdir(join(fixture.pack, "skills", "fixture-skill"), { recursive: true });
  await writeFile(join(fixture.pack, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture/adopt-cli",
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`);
  await writeFile(join(fixture.pack, "skills", "fixture-skill", "SKILL.md"), [
    "---",
    "name: fixture-skill",
    "description: Fixture skill for legacy ownership adoption.",
    "---",
    "",
    "Fixture body.",
    "",
  ].join("\n"));
  await mkdir(join(fixture.pack, "skills", "second-skill"), { recursive: true });
  await writeFile(join(fixture.pack, "skills", "second-skill", "SKILL.md"), [
    "---",
    "name: second-skill",
    "description: Second fixture skill for legacy ownership adoption.",
    "---",
    "",
    "Second body.",
    "",
  ].join("\n"));
  await writeWorkspaceConfig(fixture, fixture.scratch, scratchPackages);
  await runCli(["install", "--agent", agent], { ...fixture, nested: fixture.scratch });

  // rewrite the scratch install into the layout older releases wrote: state and lock keyed by target fingerprint
  const metadata = join(fixture.runtime, ".agentwheel");
  const manifestName = (await readdir(metadata)).find((name) => name.endsWith(".install-manifest.json"))!;
  const locks = join(fixture.scratch, ".agentwheel", "locks", agent, "claude");
  const lockName = (await readdir(locks)).find((name) => name.endsWith(".graph-lock.json"))!;
  const lockBytes = await readFile(join(locks, lockName));
  const fingerprint = JSON.parse(lockBytes.toString("utf8")).canonical.targetFingerprint as string;
  const state = JSON.parse(await readFile(join(metadata, manifestName), "utf8"));
  state.stateKey = `claude.local.${fingerprint}`;
  await writeFile(join(metadata, `${state.stateKey}.install-manifest.json`), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(join(locks, `${fingerprint}.graph-lock.json`), lockBytes);
  for (const name of await readdir(metadata)) {
    if (name !== `${state.stateKey}.install-manifest.json`) await unlink(join(metadata, name));
  }
  await unlink(join(locks, lockName));
  return { ...fixture, legacyKey: state.stateKey };
}

interface FixturePackage {
  name: string;
  adapterConfig?: string;
  installationType?: string;
  skill?: string;
}

async function configureNested(fixture: CliFixture, packages: FixturePackage[]): Promise<void> {
  await writeWorkspaceConfig(fixture, fixture.nested, packages);
}

async function writeWorkspaceConfig(
  fixture: CliFixture,
  workspace: string,
  packages: FixturePackage[],
): Promise<void> {
  await mkdir(join(workspace, ".agentwheel"), { recursive: true });
  await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify({
    schemaVersion: 4,
    agents: { [agent]: { adapter: "claude", root: fixture.runtime, transport: "local" } },
    packages: packages.map((pkg) => ({
      name: pkg.name,
      source: fixture.pack,
      driver: "local",
      mode: "pinned",
      select: [`skills/${pkg.skill ?? "fixture-skill"}`],
      ...(pkg.adapterConfig ? { adapterConfig: pkg.adapterConfig } : {}),
      ...(pkg.installationType ? { installationType: pkg.installationType } : {}),
    })),
  }, null, 2)}\n`);
}

async function writeAdapterConfig(fixture: CliFixture, name: string, skillsDest: string): Promise<string> {
  await mkdir(fixture.nested, { recursive: true });
  const path = join(fixture.nested, name);
  await writeFile(path, `${JSON.stringify({
    name: "claude",
    targets: { skills: { local: { enabled: true, dest: skillsDest, root: "target" } } },
  }, null, 2)}\n`);
  return path;
}

function adoptArgs(fixture: CliFixture): string[] {
  return [
    "ownership", "adopt-legacy",
    "--agent", agent,
    "--source-state-key", fixture.legacyKey,
    "--from-workspace-root", fixture.scratch,
  ];
}

async function runtimeStateFiles(fixture: CliFixture): Promise<string[]> {
  return (await readdir(join(fixture.runtime, ".agentwheel"))).filter((name) => !name.startsWith(".")).sort();
}

async function stateSnapshot(fixture: CliFixture): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const pending = [fixture.runtime, join(fixture.scratch, ".agentwheel"), join(fixture.nested, ".agentwheel")];
  while (pending.length > 0) {
    const path = pending.pop()!;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else snapshot[child] = await readFile(child, "utf8");
    }
  }
  return snapshot;
}

async function runCli(
  args: string[],
  fixture: Pick<CliFixture, "home" | "nested">,
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: fixture.nested,
      env: {
        ...process.env,
        HOME: fixture.home,
        XDG_CONFIG_HOME: join(fixture.home, ".config"),
        XDG_CACHE_HOME: join(fixture.home, ".cache"),
        XDG_STATE_HOME: join(fixture.home, ".local", "state"),
        AGENTWHEEL_TEST_HOME: "",
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number };
    if (!options.allowFailure) throw error;
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | "\"" | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}
