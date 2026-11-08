import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseNewPinCollisions } from "../src/lifecycle/pin-preflight.js";
import { pinConfiguredPackages, workspaceConfigPath } from "../src/model/workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeSkillPackage(root: string, name: string, skills: Record<string, string>, version = "1.0.0"): Promise<void> {
  await writeText(join(root, "openpack.json"), JSON.stringify({ schemaVersion: 2, version, name, provides: [{ type: "skills", path: "skills" }] }));
  for (const [skill, body] of Object.entries(skills)) {
    await writeText(join(root, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture skill for tests.\n---\n${body}\n`);
  }
}

async function commitAll(repo: string, message: string): Promise<string> {
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "commit", "-qm", message]);
  return (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

// `right` gains skills/shared in its second commit, and `left` always has it.
async function fixture(rightBody: string, profiles: Record<string, unknown>, leftFields: Record<string, unknown> = {}, rightFields: Record<string, unknown> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "agentwheel-pin-preflight-"));
  tempRoots.push(workspace);
  const left = join(workspace, "left");
  const right = join(workspace, "right");
  await writeSkillPackage(left, "fixture/left", { shared: "left" });
  await writeSkillPackage(right, "fixture/right", { other: "other" });
  await execFileAsync("git", ["init", "-q", "-b", "main", right]);
  await execFileAsync("git", ["-C", right, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", right, "config", "user.email", "test@example.test"]);
  const before = await commitAll(right, "first");
  await writeSkillPackage(right, "fixture/right", { other: "other", shared: rightBody });
  const after = await commitAll(right, "second");
  const configPath = workspaceConfigPath(workspace);
  const config = {
    schemaVersion: 3,
    profiles,
    packages: [
      { name: "left", source: left, mode: "pinned", ...leftFields },
      { name: "right", source: `git:${right}`, mode: "pinned", requestedRef: before, ...rightFields },
    ],
  };
  await writeText(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { workspace, configPath, after, before };
}

const claudeProfile = { everything: { runtimes: [{ adapter: "claude" }] } };

function pin(workspace: string, commit: string, warnings: string[] = [], dryRun = false) {
  return pinConfiguredPackages(workspace, [{ alias: "right", commit }], {
    dryRun,
    beforeWrite: (proposed) => refuseNewPinCollisions(workspace, proposed, (message) => warnings.push(message)),
  });
}

describe("pin collision preflight", () => {
  it("refuses a pin that brings a different artifact onto an installed name, before writing", async () => {
    const { workspace, configPath, after } = await fixture("right", claudeProfile);
    const before = await readFile(configPath, "utf8");

    await expect(pin(workspace, after)).rejects.toThrow(/nothing was written.*everything.*skills\/shared/is);
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(pin(workspace, after, [], true)).rejects.toThrow(/skills\/shared/);
  });

  it("accepts a pin whose new artifact is byte-identical", async () => {
    const { workspace, configPath, after } = await fixture("left", claudeProfile);

    await pin(workspace, after);

    expect(await readFile(configPath, "utf8")).toContain(after);
  });

  it("does not compare packages that never reach the same runtime", async () => {
    const { workspace, configPath, after } = await fixture(
      "right",
      { claude: { runtimes: [{ adapter: "claude" }] }, codex: { runtimes: [{ adapter: "codex" }] } },
      { runtimes: ["codex"] },
      { runtimes: ["claude"] },
    );

    await pin(workspace, after);

    expect(await readFile(configPath, "utf8")).toContain(after);
  });

  it("names only the profiles the new collision reaches", async () => {
    const { workspace, after } = await fixture(
      "right",
      { claude: { runtimes: [{ adapter: "claude" }] }, codex: { runtimes: [{ adapter: "codex" }] } },
      { runtimes: ["codex"] },
    );

    const refusal = await pin(workspace, after).catch((error: Error) => error.message);

    expect(refusal).toMatch(/profile codex/);
    expect(refusal).not.toMatch(/profile claude/);
  });

  it("still lets a pin through when the collision was already there", async () => {
    const { workspace, configPath, after, before } = await fixture("right", claudeProfile);
    const warnings: string[] = [];
    await pinConfiguredPackages(workspace, [{ alias: "right", commit: after }]);
    const right = join(workspace, "right");
    await writeSkillPackage(right, "fixture/right", { other: "changed", shared: "right" });
    const later = await commitAll(right, "third");

    await pin(workspace, later, warnings);

    expect(warnings.join("\n")).toMatch(/existing collision/);
    expect(await readFile(configPath, "utf8")).toContain(later);
    expect(await readFile(configPath, "utf8")).not.toContain(before);
  });

  it("warns instead of refusing when a source cannot be resolved", async () => {
    const { workspace, configPath, after } = await fixture("right", claudeProfile);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.packages[0].source = join(workspace, "missing");
    await writeText(configPath, JSON.stringify(config));
    const warnings: string[] = [];

    await pin(workspace, after, warnings);

    expect(warnings.join("\n")).toMatch(/could not finish/);
    expect(await readFile(configPath, "utf8")).toContain(after);
  });

  async function overrideFixture(selector: string) {
    const made = await fixture("left", claudeProfile, { overrides: [selector] });
    const left = join(made.workspace, "left");
    const right = join(made.workspace, "right");
    await writeSkillPackage(left, "fixture/left", { shared: "left", other: "left" });
    await writeSkillPackage(right, "fixture/right", { other: "other", shared: "left" }, "2.0.0");
    return { ...made, bumped: await commitAll(right, "bump") };
  }

  it("refuses a pin that leaves an override matching nothing", async () => {
    const { workspace, configPath, bumped } = await overrideFixture("fixture/right@1.0.0:skills/other");
    const before = await readFile(configPath, "utf8");

    await expect(pin(workspace, bumped)).rejects.toThrow(/nothing was written.*fixture\/right@1\.0\.0:skills\/other.*source::type\/name/s);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("accepts a pin when the override does not name a version", async () => {
    const { workspace, configPath, bumped } = await overrideFixture("fixture/right:skills/other");

    await pin(workspace, bumped);

    expect(await readFile(configPath, "utf8")).toContain(bumped);
  });

  it("still lets a pin through when the override already matched nothing", async () => {
    const { workspace, configPath, bumped } = await overrideFixture("fixture/right@9.9.9:skills/other");
    const warnings: string[] = [];

    await pin(workspace, bumped, warnings);

    expect(warnings.join("\n")).toMatch(/existing collision.*fixture\/right@9\.9\.9/s);
    expect(await readFile(configPath, "utf8")).toContain(bumped);
  });

  it("never downloads a registry to run the check", async () => {
    const { workspace, configPath, after } = await fixture("right", claudeProfile);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const index = join(workspace, "registry.json");
    await writeText(index, JSON.stringify({
      schemaVersion: 1,
      entries: [{ name: "left-pack", source: config.packages[0].source, type: "package", description: "Left" }],
    }));
    config.packages[0].source = "left-pack";
    await writeText(configPath, JSON.stringify(config));
    vi.stubEnv("AGENTWHEEL_REGISTRY", index);
    const warnings: string[] = [];

    await pin(workspace, after, warnings);

    expect(warnings.join("\n")).toMatch(/could not finish.*local registry cache/);
    expect(await readFile(configPath, "utf8")).toContain(after);
  });
});
