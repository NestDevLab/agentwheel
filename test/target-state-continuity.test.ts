import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCombinedInstallPlan } from "../src/install/index.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

const tempRoots: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();

const testAdapter: AdapterConfig = {
  name: "fixture-runtime",
  targets: {
    skills: {
      local: { enabled: true, dest: ".agents/skills" },
    },
  },
};

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("target state continuity", () => {
  it("keeps manifest identity stable when adapter code evolves in the same contribution scope", async () => {
    const fixture = await continuityFixture();
    const first = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, "a".repeat(64)));
    await applyFixturePlan(fixture, first);

    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, "b".repeat(64)));

    expect(evolved.plan.stateKey).toBe(first.plan.stateKey);
    expect(evolved.plan.hasBlockingChanges).toBe(false);
    expect(evolved.plan.operations.map((operation) => operation.action)).toEqual(["skip"]);
  });

  it("reuses the graph lock for a frozen plan after same-scope adapter evolution", async () => {
    const fixture = await continuityFixture();
    const first = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, "a".repeat(64)));
    await applyFixturePlan(fixture, first);

    const evolved = await graphPlan(
      fixture,
      fingerprintParts(fixture.targetRoot, "b".repeat(64)),
      { frozenLock: true },
    );

    expect(evolved.graphLockPath).toBe(first.graphLockPath);
    expect(evolved.plan.operations.map((operation) => operation.action)).toEqual(["skip"]);
  });

  it("keeps different contribution scopes partitioned for an identical runtime target", async () => {
    const fixture = await continuityFixture();
    const nestedWorkspace = join(fixture.workspaceRoot, "profiles", "specialized");
    await mkdir(nestedWorkspace, { recursive: true });
    const parts = fingerprintParts(fixture.targetRoot, "a".repeat(64));

    const rootPlan = await graphPlan(fixture, parts);
    const nestedPlan = await graphPlan(
      { ...fixture, workspaceRoot: nestedWorkspace },
      parts,
    );

    expect(nestedPlan.plan.stateKey).not.toBe(rootPlan.plan.stateKey);
  });

  it("keeps different physical targets partitioned within one contribution scope", async () => {
    const fixture = await continuityFixture();
    const otherTarget = await tempRoot("agentwheel-continuity-other-target-");

    const rootPlan = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, "a".repeat(64)));
    const otherTargetPlan = await graphPlan(
      { ...fixture, targetRoot: otherTarget },
      fingerprintParts(otherTarget, "a".repeat(64)),
    );

    expect(otherTargetPlan.targetFingerprint).not.toBe(rootPlan.targetFingerprint);
    expect(otherTargetPlan.plan.stateKey).not.toBe(rootPlan.plan.stateKey);
  });
});

interface ContinuityFixture {
  sourceRoot: string;
  workspaceRoot: string;
  targetRoot: string;
  globalRoot: string;
  transport: TargetTransport;
}

async function continuityFixture(): Promise<ContinuityFixture> {
  const sourceRoot = await tempRoot("agentwheel-continuity-source-");
  const workspaceRoot = await tempRoot("agentwheel-continuity-workspace-");
  const targetRoot = await tempRoot("agentwheel-continuity-target-");
  const globalRoot = await tempRoot("agentwheel-continuity-home-");
  isolateProcessRoots(globalRoot);
  await mkdir(join(sourceRoot, "skills", "continuity-fixture"), { recursive: true });
  await writeFile(join(sourceRoot, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture/target-state-continuity",
    version: "1.0.0",
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`, "utf8");
  await writeFile(join(sourceRoot, "skills", "continuity-fixture", "SKILL.md"), [
    "---",
    "name: continuity-fixture",
    "description: Fixture for target state continuity tests.",
    "---",
    "",
    "# Target state continuity fixture",
    "",
  ].join("\n"), "utf8");
  return {
    sourceRoot,
    workspaceRoot,
    targetRoot,
    globalRoot,
    transport: guardedFixtureTransport([sourceRoot, workspaceRoot, targetRoot, globalRoot]),
  };
}

function fingerprintParts(targetRoot: string, adapterCodeHash: string | undefined) {
  return {
    adapter: "fixture-runtime",
    fleetId: "delivery",
    installationType: "local",
    adapterConfig: adapterCodeHash ? "adapters/runtime.jsonc" : undefined,
    adapterModule: undefined,
    adapterCodeHash,
    agentName: "runtime-agent",
    targetRoot,
    transport: "local",
    ssh: undefined,
    stateKey: undefined,
  };
}

async function graphPlan(
  fixture: ContinuityFixture,
  targetFingerprintParts: unknown,
  options: { frozenLock?: boolean } = {},
) {
  return createGraphSourcePlan({
    roots: [{ rootId: "fixture", source: fixture.sourceRoot, mode: "pinned" }],
    targetRoot: fixture.targetRoot,
    workspaceRoot: fixture.workspaceRoot,
    globalRoot: fixture.globalRoot,
    adapter: testAdapter,
    transport: fixture.transport,
    installationType: "local",
    fleetId: "delivery",
    targetKey: "runtime-agent",
    targetFingerprintParts,
    trustStorePath: join(fixture.globalRoot, ".agentwheel", "trust.json"),
    readOnly: true,
    isTTY: false,
    frozenLock: options.frozenLock,
  });
}

async function applyFixturePlan(
  fixture: ContinuityFixture,
  result: Awaited<ReturnType<typeof graphPlan>>,
): Promise<void> {
  expect(resolve(result.plan.targetRoot)).toBe(resolve(fixture.targetRoot));
  assertInsideFixture(result.graphLockPath, [fixture.workspaceRoot]);
  await applyCombinedInstallPlan(result.plan, {
    transport: fixture.transport,
    graphLockDigest: result.graphLockDigest,
    graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
  });
}

function guardedFixtureTransport(allowedRoots: string[]): TargetTransport {
  const assertWrite = (path: string) => assertInsideFixture(path, allowedRoots);
  return {
    ...localTransport,
    description: "guarded fixture local filesystem",
    async mkdirExclusive(path) {
      assertWrite(path);
      await localTransport.mkdirExclusive(path);
    },
    async writeFileAtomic(path, content) {
      assertWrite(path);
      await localTransport.writeFileAtomic(path, content);
    },
    async writeJsonAtomic(path, data) {
      assertWrite(path);
      await localTransport.writeJsonAtomic(path, data);
    },
    async atomicCopy(source, dest, kind) {
      assertWrite(dest);
      await localTransport.atomicCopy(source, dest, kind);
    },
    async rm(path) {
      assertWrite(path);
      await localTransport.rm(path);
    },
    async execFile(command) {
      throw new Error(`Fixture transport refuses process execution: ${command}`);
    },
  };
}

function assertInsideFixture(path: string, allowedRoots: string[]): void {
  const candidate = resolve(path);
  if (allowedRoots.some((root) => {
    const child = relative(resolve(root), candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  })) return;
  throw new Error(`Fixture refused write outside isolated roots: ${candidate}`);
}

function isolateProcessRoots(globalRoot: string): void {
  const roots: Record<string, string> = {
    HOME: join(globalRoot, "home"),
    XDG_CONFIG_HOME: join(globalRoot, "xdg-config"),
    XDG_CACHE_HOME: join(globalRoot, "xdg-cache"),
    XDG_STATE_HOME: join(globalRoot, "xdg-state"),
    AGENTWHEEL_TEST_HOME: join(globalRoot, "home"),
    AGENTWHEEL_TRUST_STORE: join(globalRoot, "agentwheel", "trust.json"),
    AGENTWHEEL_AUTH_CONFIG: join(globalRoot, "agentwheel", "auth.json"),
    AGENTWHEEL_MUTATION_STATE_ROOT: join(globalRoot, "agentwheel", "mutations"),
  };
  for (const [key, value] of Object.entries(roots)) {
    if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
