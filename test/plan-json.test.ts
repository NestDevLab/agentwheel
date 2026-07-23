import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const cli = join(process.cwd(), "dist", "index.js");
let cliHome: string;

const actions = new Set(["create", "update", "skip", "remove", "keep", "drift", "conflict", "plugin", "program"]);
const channels = new Set(["managed", "overlay", "addition", "override", "ejected"]);
const dependencyRoles = new Set(["root", "direct", "transitive", "fragment"]);

beforeAll(async () => {
  cliHome = await mkdtemp(join(tmpdir(), "agentwheel-plan-json-home-"));
  await ensureCliBuild(cli);
});

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

afterAll(async () => {
  if (cliHome) await rm(cliHome, { recursive: true, force: true });
});

describe("plan JSON output", () => {
  it("prints the resolved plan schema as clean JSON", async () => {
    const workspace = await tempRoot();
    const source = await skillPackageFixture("json-schema-skill");

    const { stdout, stderr } = await runCli(["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps", "--json"]);
    const report = parseJsonReport(stdout);

    expect(stderr).toBe("");
    expect(report.schemaVersion).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({
      adapter: "codex",
      installationType: "local",
      targetRoot: workspace,
      hasBlockingChanges: false,
      summary: {
        create: 1,
        update: 0,
        skip: 0,
        remove: 0,
        keep: 0,
        drift: 0,
        conflict: 0,
        plugin: 0,
      },
    });
    expect(report.targets[0].graphLockDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.targets[0].operations).toHaveLength(1);
    expectOperationSchema(report.targets[0].operations[0]);
  });

  it("is byte-deterministic and keeps target and operation order stable", async () => {
    const workspace = await tempRoot();
    const source = await mixedPackageFixture("json-deterministic");

    const args = ["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps", "--json"];
    const first = await runCli(args);
    const second = await runCli(args);
    const report = parseJsonReport(first.stdout);

    expect(second.stdout).toBe(first.stdout);
    expect(report.targets.map((target) => `${target.adapter}:${target.installationType}:${target.targetRoot}`)).toEqual([...report.targets.map((target) => `${target.adapter}:${target.installationType}:${target.targetRoot}`)].sort());
    expect(report.targets[0].operations.map((operation) => operation.relativeDestPath)).toEqual([
      ".agents/skills/json-deterministic",
      "AGENTS.md",
    ]);
  });

  it("collects multiple profile targets for install dry-runs", async () => {
    const workspace = await tempRoot();
    const firstTarget = await tempRoot("agentwheel-plan-json-target-a-");
    const secondTarget = await tempRoot("agentwheel-plan-json-target-b-");
    const source = await skillPackageFixture("json-profile-skill");
    await writeWorkspace(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: {},
      packages: [{
        name: "json-profile-skill",
        source,
        driver: "local",
        adapter: "codex",
        installationType: "local",
        mode: "pinned",
      }],
      agents: {
        alpha: { adapter: "codex", root: firstTarget, transport: "local", installationType: "local" },
        beta: { adapter: "claude", root: secondTarget, transport: "local", installationType: "local" },
      },
      profiles: {
        matrix: { runtimes: [{ agent: "alpha" }, { agent: "beta" }] },
      },
    });

    const { stdout } = await runCli(["install", "--profile", "matrix", "--target-root", workspace, "--dry-run", "--json"]);
    const report = parseJsonReport(stdout);

    expect(report.targets).toHaveLength(2);
    expect(report.targets.map((target) => target.adapter)).toEqual(["claude", "codex"]);
    for (const target of report.targets) {
      expect(target.installationType).toBe("local");
      expect(target.graphLockDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(target.operations).toHaveLength(1);
      expectOperationSchema(target.operations[0]);
    }
  });

  it("--format json is byte-identical to --json", async () => {
    const workspace = await tempRoot();
    const source = await skillPackageFixture("format-json-skill");
    const baseArgs = ["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps"];

    const alias = await runCli([...baseArgs, "--json"]);
    const format = await runCli([...baseArgs, "--format", "json"]);

    expect(format.stdout).toBe(alias.stdout);
  });

  it("--format mermaid prints deterministic flowchart source", async () => {
    const workspace = await tempRoot();
    const firstTarget = await tempRoot("agentwheel-mermaid-target-a-");
    const secondTarget = await tempRoot("agentwheel-mermaid-target-b-");
    const source = await skillPackageFixture("render-profile-skill");
    await writeWorkspace(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: {},
      packages: [{
        name: "render-profile-skill",
        source,
        driver: "local",
        adapter: "codex",
        installationType: "local",
        mode: "pinned",
      }],
      agents: {
        alpha: { adapter: "codex", root: firstTarget, transport: "local", installationType: "local" },
        beta: { adapter: "claude", root: secondTarget, transport: "local", installationType: "local" },
      },
      profiles: {
        matrix: { runtimes: [{ agent: "alpha" }, { agent: "beta" }] },
      },
    });
    const args = ["install", "--profile", "matrix", "--target-root", workspace, "--dry-run", "--format", "mermaid"];

    const first = await runCli(args);
    const second = await runCli(args);

    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toMatch(/^flowchart LR\n/);
    expect(first.stdout).toContain('rt_0["claude/local"]');
    expect(first.stdout).toContain('rt_1["codex/local"]');
    expect(first.stdout).toContain('pkg_0["render-profile-skill"]');
    expect(first.stdout).toContain("classDef ok");
    expect(first.stdout).toContain("classDef pending");
    expect(first.stdout).toContain("pkg_0 edge_0@-->|1 op| rt_0");
    expect(first.stdout).toContain("pkg_0 edge_1@-->|1 op| rt_1");
  });

  it("--format html prints a deterministic self-contained snapshot", async () => {
    const workspace = await tempRoot();
    const source = await mixedPackageFixture("format-html-skill");
    const args = ["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps", "--format", "html"];

    const first = await runCli(args);
    const second = await runCli(args);

    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout.trim().startsWith("<!doctype html>")).toBe(true);
    expect(first.stdout.trim().endsWith("</html>")).toBe(true);
    expect(first.stdout).toContain("<table>");
    expect(first.stdout).toContain('<pre class="mermaid">');
    expect(first.stdout).toContain("prefers-color-scheme");
    expectNoExternalResourceRefs(first.stdout);
  });

  it("rejects unknown plan formats", async () => {
    await expect(runCli(["plan", "--adapter", "codex", "--target-root", await tempRoot(), "--format", "bogus"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown --format value: bogus. Valid formats: human, json, mermaid, html."),
    });
  });

  it("rejects --json with a non-json --format", async () => {
    await expect(runCli(["plan", "--adapter", "codex", "--target-root", await tempRoot(), "--json", "--format", "mermaid"])).rejects.toMatchObject({
      stderr: expect.stringContaining("--json conflicts with --format mermaid. Use --format json instead."),
    });
  });

  it("leaves the human plan path unchanged", async () => {
    const workspace = await tempRoot();
    const source = await skillPackageFixture("json-human-skill");

    const { stdout } = await runCli(["plan", source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps"]);

    expect(normalizeHumanPlan(stdout, workspace, source)).toMatchInlineSnapshot(`
      "Dependency graph
      RESOLVE json-human-skill@1.0.0+<source-hash> source=local:<source> selected=[skills/json-human-skill] requiredBy=[workspace:json-human-skill]
      LOCK    <workspace>/.agentwheel/locks/codex/codex/<fingerprint>.graph-lock.json (<digest>)
      Plan for codex/local at <workspace>
      CREATE   MANAGED  skills/json-human-skill <stage>/skills/json-human-skill -> .agents/skills/json-human-skill (destination missing)
      Summary: create 1, update 0, skip 0, remove 0, keep 0, drift 0, conflict 0, plugin 0"
    `);
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

async function tempRoot(prefix = "agentwheel-plan-json-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeWorkspace(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, ".agentwheel"), { recursive: true });
  await writeFile(join(root, ".agentwheel", "config.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function skillPackageFixture(name: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill for ${name}.\n---\n\n# ${name}\n`,
    "utf8",
  );
  await writeOpenPack(root, name, [{ type: "skills", path: "skills" }]);
  return root;
}

async function mixedPackageFixture(name: string): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(join(root, "instructions", "AGENTS.md"), `# ${name}\n`, "utf8");
  await writeFile(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill for ${name}.\n---\n\n# ${name}\n`,
    "utf8",
  );
  await writeOpenPack(root, name, [
    { type: "instructions", path: "instructions/AGENTS.md" },
    { type: "skills", path: "skills" },
  ]);
  return root;
}

async function writeOpenPack(root: string, name: string, provides: unknown[]): Promise<void> {
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides,
  }, null, 2)}\n`, "utf8");
}

function parseJsonReport(stdout: string): PlanJsonReport {
  const trimmed = stdout.trim();
  expect(trimmed.startsWith("{")).toBe(true);
  expect(trimmed.endsWith("}")).toBe(true);
  return JSON.parse(trimmed) as PlanJsonReport;
}

function expectOperationSchema(operation: PlanJsonOperation): void {
  expect(Object.keys(operation)).toEqual([
    "action",
    "channel",
    "artifactType",
    "artifactName",
    "logicalSelector",
    "relativeDestPath",
    "reason",
    "packageName",
    "owners",
    "graphNodeId",
    "dependencyRole",
    "blockedReason",
  ]);
  expect(actions.has(operation.action)).toBe(true);
  expect(channels.has(operation.channel)).toBe(true);
  expect(operation.dependencyRole === null || dependencyRoles.has(operation.dependencyRole)).toBe(true);
  expect(Array.isArray(operation.owners)).toBe(true);
  expect(operation.blockedReason).toBeNull();
}

function normalizeHumanPlan(value: string, workspace: string, source: string): string {
  return value
    .trim()
    .replaceAll(workspace, "<workspace>")
    .replaceAll(source, "<source>")
    .replace(/json-human-skill@1\.0\.0\+[a-f0-9]+/g, "json-human-skill@1.0.0+<source-hash>")
    .replace(/<workspace>\/\.agentwheel\/locks\/codex\/codex\/[a-f0-9]+\.graph-lock\.json/g, "<workspace>/.agentwheel/locks/codex/codex/<fingerprint>.graph-lock.json")
    .replace(/\([a-f0-9]{64}\)/g, "(<digest>)")
    .replace(/\/tmp\/agentwheel-stage-[^/]+/g, "<stage>");
}

function expectNoExternalResourceRefs(value: string): void {
  expect(value).not.toMatch(/\b(?:src|href)=["']https?:\/\//i);
  expect(value).not.toMatch(/url\(\s*["']?https?:\/\//i);
}

interface PlanJsonReport {
  schemaVersion: number;
  targets: PlanJsonTarget[];
  warnings: string[];
}

interface PlanJsonTarget {
  adapter: string;
  installationType: string;
  targetRoot: string;
  graphLockDigest: string | null;
  hasBlockingChanges: boolean;
  summary: Record<string, number>;
  operations: PlanJsonOperation[];
}

interface PlanJsonOperation {
  action: string;
  channel: string;
  artifactType: string;
  artifactName: string;
  logicalSelector: string | null;
  relativeDestPath: string;
  reason: string;
  packageName: string | null;
  owners: string[];
  graphNodeId: string | null;
  dependencyRole: string | null;
  blockedReason: string | null;
}
