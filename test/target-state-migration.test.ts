import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCombinedInstallPlan,
  readInstallManifest,
  readSourceLock,
  recoverPendingApply,
  writeInstallManifest,
  writeSourceLock,
} from "../src/install/index.js";
import { installManifestPath, sourceLockPath, stateKeyFor } from "../src/install/paths.js";
import { applyJournalPath } from "../src/install/transaction.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import { readGraphLock, writeGraphLock } from "../src/model/graph-lock.js";
import type { InstallManifestV2, SourceLock } from "../src/model/manifest.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

const tempRoots: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();

const targetAdapter = adapterWithDestination(".agents/skills");

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("released target-state migration", () => {
  it("migrates a correlated legacy manifest, source lock, and graph lock exactly once", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
      adapterConfig: "adapters/runtime-a.jsonc",
      adapterModule: "adapters/runtime-a.mjs",
    }));
    const unrelatedStateKey = await seedUnrelatedManifest(fixture, legacy.manifest);

    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
      adapterConfig: "adapters/runtime-b.jsonc",
      adapterModule: "adapters/runtime-b.mjs",
    }));

    expect(evolved.plan.stateKey).not.toBe(legacy.stateKey);
    expect(evolved.plan.operations.map((operation) => operation.action)).toEqual(["skip"]);
    await applyFixturePlan(fixture, evolved);

    await expect(stat(installManifestPath(fixture.targetRoot, targetAdapter.name, legacy.scope))).rejects.toThrow();
    await expect(stat(sourceLockPath(fixture.targetRoot, targetAdapter.name, legacy.scope))).rejects.toThrow();
    await expect(stat(legacy.graphLockPath)).rejects.toThrow();
    await expect(stat(evolved.graphLockPath)).resolves.toBeDefined();
    expect(await readInstallManifest(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    })).toBeDefined();
    expect(await readSourceLock(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    })).toEqual(legacy.sourceLock);
    expect(await readInstallManifest(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: unrelatedStateKey,
    })).toBeDefined();

    const repeated = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
      adapterConfig: "adapters/runtime-b.jsonc",
      adapterModule: "adapters/runtime-b.mjs",
    }));
    expect(repeated.plan.operations.map((operation) => operation.action)).toEqual(["skip"]);
    await applyFixturePlan(fixture, repeated);
    await expect(stat(legacy.graphLockPath)).rejects.toThrow();
  });

  it("refuses two correlated legacy candidates before changing persistent state", async () => {
    const fixture = await migrationFixture();
    const first = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
      adapterConfig: "adapters/runtime-a.jsonc",
      adapterModule: "adapters/runtime-a.mjs",
    }));
    const secondDraft = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "c".repeat(64),
      adapterConfig: "adapters/runtime-c.jsonc",
      adapterModule: "adapters/runtime-c.mjs",
    }));
    const secondStateKey = legacyStateKey(secondDraft.targetFingerprint);
    const secondGraphLockPath = legacyGraphPath(fixture.workspaceRoot, secondDraft.targetFingerprint);
    const duplicateManifest: InstallManifestV2 = {
      ...first.manifest,
      stateKey: secondStateKey,
      revision: "pending-duplicate-state",
      entries: first.manifest.entries.map((entry) => ({
        ...entry,
        graphLockDigest: secondDraft.graphLockDigest,
      })),
    };
    await writeInstallManifest(duplicateManifest, fixture.transport);
    assertInsideFixture(secondGraphLockPath, [fixture.workspaceRoot]);
    await writeGraphLock(secondGraphLockPath, secondDraft.bundle.graphLock);
    const before = await persistentStateSnapshot([
      first.manifestPath,
      first.graphLockPath,
      installManifestPath(fixture.targetRoot, targetAdapter.name, { installationType: "local", stateKey: secondStateKey }),
      secondGraphLockPath,
    ]);

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
      adapterConfig: "adapters/runtime-b.jsonc",
      adapterModule: "adapters/runtime-b.mjs",
    }))).rejects.toThrow(/ambiguous.*legacy|multiple.*legacy/i);

    expect(await persistentStateSnapshot([...before.keys()])).toEqual(before);
  });

  it("preserves mixed foreign contributions and unrelated manifests byte for byte", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const foreignPath = join(fixture.targetRoot, ".agents", "skills", "foreign-contribution");
    const foreignFile = join(foreignPath, "SKILL.md");
    const foreignBytes = "# Foreign contribution\n\nPreserve these exact bytes.\n";
    await mkdir(foreignPath, { recursive: true });
    await writeFile(foreignFile, foreignBytes, "utf8");
    const foreignHash = await fixture.transport.hashPath(foreignPath);
    const foreignEntry = {
      ...legacy.manifest.entries[0]!,
      path: ".agents/skills/foreign-contribution",
      artifactName: "foreign-contribution",
      installName: "foreign-contribution",
      logicalSelector: "skills/foreign-contribution",
      hash: foreignHash,
      sourceHash: foreignHash,
      owners: ["foreign/package"],
      refCount: 1,
      workspaceOwner: "workspace-root:/fixture/foreign-scope|fleet-id:delivery",
      graphLockDigest: "e".repeat(64),
    };
    await writeInstallManifest({
      ...legacy.manifest,
      revision: "pending-mixed-state",
      entries: [...legacy.manifest.entries, foreignEntry],
    }, fixture.transport);
    const mixedManifest = await readInstallManifest(
      fixture.targetRoot,
      targetAdapter.name,
      fixture.transport,
      legacy.scope,
    );
    if (!mixedManifest || mixedManifest.version !== 2) throw new Error("missing mixed legacy manifest");
    const unrelatedStateKey = await seedUnrelatedManifest(fixture, mixedManifest);
    const unrelatedPath = installManifestPath(fixture.targetRoot, targetAdapter.name, {
      installationType: "local",
      stateKey: unrelatedStateKey,
    });
    const unrelatedBytes = await readFile(unrelatedPath, "utf8");

    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }));
    await applyFixturePlan(fixture, evolved);

    expect(await readFile(foreignFile, "utf8")).toBe(foreignBytes);
    expect(await readFile(unrelatedPath, "utf8")).toBe(unrelatedBytes);
    const migrated = await readInstallManifest(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    });
    if (!migrated || migrated.version !== 2) throw new Error("missing migrated manifest");
    expect(migrated.entries.find((entry) => entry.path === foreignEntry.path)).toMatchObject({
      hash: foreignHash,
      sourceHash: foreignHash,
      owners: foreignEntry.owners,
      workspaceOwner: foreignEntry.workspaceOwner,
      graphLockDigest: foreignEntry.graphLockDigest,
    });
  });

  it("fails closed when stable and legacy manifests coexist with different contribution state", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const stableDraft = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }));
    if (!stableDraft.plan.stateKey) throw new Error("missing stable state key");
    await writeInstallManifest({
      ...legacy.manifest,
      stateKey: stableDraft.plan.stateKey,
      revision: "pending-stable-state",
      entries: legacy.manifest.entries.map((entry) => ({
        ...entry,
        sourceHash: "d".repeat(64),
        graphLockDigest: stableDraft.graphLockDigest,
      })),
    }, fixture.transport);
    await writeGraphLock(stableDraft.graphLockPath, stableDraft.bundle.graphLock);
    const stableManifestPath = installManifestPath(fixture.targetRoot, targetAdapter.name, {
      installationType: "local",
      stateKey: stableDraft.plan.stateKey,
    });
    const before = await persistentStateSnapshot([
      legacy.manifestPath,
      legacy.graphLockPath,
      stableManifestPath,
      stableDraft.graphLockPath,
    ]);

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }))).rejects.toThrow(/stable.*legacy.*(coexist|disagree)|legacy.*stable.*(coexist|disagree)/i);

    expect(await persistentStateSnapshot([...before.keys()])).toEqual(before);
  });

  it("fails closed when a correlated manifest digest does not match its legacy graph lock", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    await writeInstallManifest({
      ...legacy.manifest,
      revision: "pending-mismatched-digest",
      entries: legacy.manifest.entries.map((entry) => ({ ...entry, graphLockDigest: "f".repeat(64) })),
    }, fixture.transport);
    const before = await persistentStateSnapshot([legacy.manifestPath, legacy.graphLockPath]);

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }))).rejects.toThrow(/graph.lock.*digest|digest.*graph.lock/i);

    expect(await persistentStateSnapshot([...before.keys()])).toEqual(before);
  });

  it("refuses a correlated manifest whose internal target root differs from the requested runtime", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const otherTargetRoot = await tempRoot("agentwheel-migration-other-target-");
    await fixture.transport.writeJsonAtomic(legacy.manifestPath, {
      ...legacy.manifest,
      targetRoot: otherTargetRoot,
      revision: "pending-mismatched-target",
      legacy: undefined,
    });
    const before = await persistentStateSnapshot([legacy.manifestPath, legacy.graphLockPath]);

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }))).rejects.toThrow(/target root|targetRoot/i);

    expect(await persistentStateSnapshot([...before.keys()])).toEqual(before);
  });

  it("does not search another target-key contribution directory for frozen state", async () => {
    const fixture = await migrationFixture();
    const draft = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const otherScopePath = join(
      fixture.workspaceRoot,
      ".agentwheel",
      "locks",
      "other-runtime-agent",
      targetAdapter.name,
      `${draft.targetFingerprint}.graph-lock.json`,
    );
    assertInsideFixture(otherScopePath, [fixture.workspaceRoot]);
    await writeGraphLock(otherScopePath, draft.bundle.graphLock);

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }), { frozenLock: true })).rejects.toThrow(/requires an existing graph lock/i);
    await expect(stat(otherScopePath)).resolves.toBeDefined();
  });

  it("does not interpret a graph lock whose canonical fingerprint disagrees with its filename", async () => {
    const fixture = await migrationFixture();
    const draft = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const path = legacyGraphPath(fixture.workspaceRoot, draft.targetFingerprint);
    assertInsideFixture(path, [fixture.workspaceRoot]);
    await writeGraphLock(path, {
      ...draft.bundle.graphLock,
      canonical: {
        ...draft.bundle.graphLock.canonical,
        targetFingerprint: "f".repeat(64),
      },
    });
    const before = await readFile(path, "utf8");

    await expect(graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }), { frozenLock: true })).rejects.toThrow(/fingerprint.*filename|filename.*fingerprint/i);

    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("uses a valid graph-only legacy candidate for frozen resolution without adopting manifest ownership", async () => {
    const fixture = await migrationFixture();
    const legacyDraft = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const legacyPath = legacyGraphPath(fixture.workspaceRoot, legacyDraft.targetFingerprint);
    assertInsideFixture(legacyPath, [fixture.workspaceRoot]);
    await writeGraphLock(legacyPath, legacyDraft.bundle.graphLock);

    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }), { frozenLock: true });

    expect(evolved.plan.baseRevision).toBeNull();
    expect(evolved.plan.operations.map((operation) => operation.action)).toEqual(["create"]);
    await applyFixturePlan(fixture, evolved);
    await expect(stat(legacyPath)).rejects.toThrow();
    await expect(stat(evolved.graphLockPath)).resolves.toBeDefined();
  });

  it("detects manifest inventory movement after planning before creating a journal", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }));
    await seedUnrelatedManifest(fixture, legacy.manifest);

    await expect(applyFixturePlan(fixture, evolved)).rejects.toThrow(/manifest inventory changed.*replan/i);
    await expect(stat(applyJournalPath(fixture.targetRoot, targetAdapter.name, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    }))).rejects.toThrow();
    await expect(stat(legacy.manifestPath)).resolves.toBeDefined();
    await expect(stat(legacy.graphLockPath)).resolves.toBeDefined();
  });

  it("recovers an interrupted legacy-state commit without losing contributions", async () => {
    const fixture = await migrationFixture();
    const legacy = await seedLegacyState(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
    }));
    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
    }));
    let injected = false;
    const faultingTransport: TargetTransport = {
      ...fixture.transport,
      description: "guarded fixture with one legacy-state removal fault",
      async rm(path) {
        if (!injected && resolve(path) === resolve(legacy.manifestPath)) {
          injected = true;
          throw new Error("fixture interrupted legacy-state removal");
        }
        await fixture.transport.rm(path);
      },
    };

    await expect(applyFixturePlan(fixture, evolved, faultingTransport)).rejects.toThrow(/interrupted legacy-state removal/i);
    const journalPath = applyJournalPath(fixture.targetRoot, targetAdapter.name, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    });
    await expect(stat(journalPath)).resolves.toBeDefined();

    await recoverPendingApply(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    });

    await expect(stat(journalPath)).rejects.toThrow();
    await expect(stat(legacy.manifestPath)).rejects.toThrow();
    await expect(stat(legacy.graphLockPath)).rejects.toThrow();
    expect(await readInstallManifest(fixture.targetRoot, targetAdapter.name, fixture.transport, {
      installationType: "local",
      stateKey: evolved.plan.stateKey,
    })).toBeDefined();
    await expect(readFile(join(fixture.targetRoot, ".agents", "skills", "continuity-fixture", "SKILL.md"), "utf8"))
      .resolves.toContain("Target state continuity fixture");
  });
});

describe("persistent target semantics", () => {
  it("keeps provenance-only config, module, and code evolution in one state", async () => {
    const fixture = await migrationFixture();
    const first = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "a".repeat(64),
      adapterConfig: "adapters/runtime-a.jsonc",
      adapterModule: "adapters/runtime-a.mjs",
    }));
    const evolved = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterCodeHash: "b".repeat(64),
      adapterConfig: "adapters/runtime-b.jsonc",
      adapterModule: "adapters/runtime-b.mjs",
    }));

    expect(evolved.targetFingerprint).not.toBe(first.targetFingerprint);
    expect(evolved.plan.stateKey).toBe(first.plan.stateKey);
    expect(evolved.graphLockPath).toBe(first.graphLockPath);
  });

  it("plans and applies an owned destination remap without orphaning the old artifact", async () => {
    const fixture = await migrationFixture();
    const first = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterConfig: "adapters/runtime-a.jsonc",
    }), { adapter: adapterWithDestination(".agents/skills") });
    await applyFixturePlan(fixture, first);

    const remapped = await graphPlan(fixture, fingerprintParts(fixture.targetRoot, {
      adapterConfig: "adapters/runtime-b.jsonc",
    }), { adapter: adapterWithDestination(".runtime/skills") });

    expect(remapped.plan.stateKey).toBe(first.plan.stateKey);
    expect(remapped.plan.operations.map((operation) => [operation.action, operation.relativeDestPath])).toEqual([
      ["remove", ".agents/skills/continuity-fixture"],
      ["create", ".runtime/skills/continuity-fixture"],
    ]);
    await applyFixturePlan(fixture, remapped);
    await expect(stat(join(fixture.targetRoot, ".agents", "skills", "continuity-fixture"))).rejects.toThrow();
    await expect(stat(join(fixture.targetRoot, ".runtime", "skills", "continuity-fixture"))).resolves.toBeDefined();
  });

  it("partitions a local home-root remap from the same requested target root", async () => {
    const fixture = await migrationFixture();
    const parts = fingerprintParts(fixture.targetRoot, {});
    const targetRootPlan = await graphPlan(fixture, parts, {
      adapter: adapterWithDestination(".agents/skills", "target"),
    });
    const homeRootPlan = await graphPlan(fixture, parts, {
      adapter: adapterWithDestination(".agents/skills", "home"),
    });

    expect(homeRootPlan.plan.targetRoot).not.toBe(targetRootPlan.plan.targetRoot);
    expect(homeRootPlan.plan.stateKey).not.toBe(targetRootPlan.plan.stateKey);
    expect(homeRootPlan.graphLockPath).not.toBe(targetRootPlan.graphLockPath);
  });

  it("partitions transport endpoints while ignoring cosmetic descriptions of the same endpoint", async () => {
    const fixture = await migrationFixture();
    const endpointA = fingerprintParts(fixture.targetRoot, {
      transport: "ssh",
      transportDescription: "primary alias",
      ssh: { host: "runtime-a.example", user: "agent", port: 22, identityFile: "/keys/first" },
    });
    const endpointARenamed = fingerprintParts(fixture.targetRoot, {
      transport: "ssh",
      transportDescription: "renamed alias",
      ssh: { host: "runtime-a.example", user: "agent", port: 22, identityFile: "/keys/second" },
    });
    const endpointB = fingerprintParts(fixture.targetRoot, {
      transport: "ssh",
      transportDescription: "other endpoint",
      ssh: { host: "runtime-b.example", user: "agent", port: 22, identityFile: "/keys/first" },
    });
    const transportA = sshFixtureTransport(fixture.transport, "ssh primary alias");
    const transportARenamed = sshFixtureTransport(fixture.transport, "ssh renamed alias");

    const first = await graphPlan(fixture, endpointA, { transport: transportA });
    const renamed = await graphPlan(fixture, endpointARenamed, { transport: transportARenamed });
    const other = await graphPlan(fixture, endpointB, { transport: transportA });

    expect(renamed.plan.stateKey).toBe(first.plan.stateKey);
    expect(renamed.graphLockPath).toBe(first.graphLockPath);
    expect(other.plan.stateKey).not.toBe(first.plan.stateKey);
    expect(other.graphLockPath).not.toBe(first.graphLockPath);
  });
});

interface MigrationFixture {
  sourceRoot: string;
  workspaceRoot: string;
  targetRoot: string;
  globalRoot: string;
  transport: TargetTransport;
}

interface LegacyState {
  stateKey: string;
  scope: { installationType: string; stateKey: string };
  manifestPath: string;
  manifest: InstallManifestV2;
  graphLockPath: string;
  sourceLock: SourceLock;
}

async function migrationFixture(): Promise<MigrationFixture> {
  const sourceRoot = await tempRoot("agentwheel-migration-source-");
  const workspaceRoot = await tempRoot("agentwheel-migration-workspace-");
  const targetRoot = await tempRoot("agentwheel-migration-target-");
  const globalRoot = await tempRoot("agentwheel-migration-home-");
  isolateProcessRoots(globalRoot);
  await mkdir(join(sourceRoot, "skills", "continuity-fixture"), { recursive: true });
  await writeFile(join(sourceRoot, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture/target-state-migration",
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

function adapterWithDestination(dest: string, root: "target" | "home" = "target"): AdapterConfig {
  return {
    name: "fixture-runtime",
    targets: {
      skills: {
        local: { enabled: true, dest, root },
      },
    },
  };
}

function fingerprintParts(
  targetRoot: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    adapter: "fixture-runtime",
    fleetId: "delivery",
    installationType: "local",
    adapterConfig: undefined,
    adapterModule: undefined,
    adapterCodeHash: undefined,
    agentName: "runtime-agent",
    targetRoot,
    transport: "local",
    ssh: undefined,
    stateKey: undefined,
    ...overrides,
  };
}

async function graphPlan(
  fixture: MigrationFixture,
  targetFingerprintParts: unknown,
  options: {
    adapter?: AdapterConfig;
    frozenLock?: boolean;
    transport?: TargetTransport;
  } = {},
) {
  return createGraphSourcePlan({
    roots: [{ rootId: "fixture", source: fixture.sourceRoot, mode: "pinned" }],
    targetRoot: fixture.targetRoot,
    workspaceRoot: fixture.workspaceRoot,
    globalRoot: fixture.globalRoot,
    adapter: options.adapter ?? targetAdapter,
    transport: options.transport ?? fixture.transport,
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

async function seedLegacyState(fixture: MigrationFixture, parts: unknown): Promise<LegacyState> {
  const draft = await graphPlan(fixture, parts);
  const stateKey = legacyStateKey(draft.targetFingerprint);
  const scope = { installationType: "local", stateKey };
  const graphLockPath = legacyGraphPath(fixture.workspaceRoot, draft.targetFingerprint);
  const legacyPlan = { ...draft.plan, stateKey, baseRevision: null };
  assertInsideFixture(graphLockPath, [fixture.workspaceRoot]);
  await applyCombinedInstallPlan(legacyPlan, {
    transport: fixture.transport,
    graphLockDigest: draft.graphLockDigest,
    graphLock: { path: graphLockPath, lock: draft.bundle.graphLock },
  });
  const sourceLock = sourceLockFixture(fixture);
  await writeSourceLock(fixture.targetRoot, targetAdapter.name, sourceLock, fixture.transport, scope);
  const manifest = await readInstallManifest(fixture.targetRoot, targetAdapter.name, fixture.transport, scope);
  if (!manifest || manifest.version !== 2) throw new Error("missing seeded legacy manifest");
  return {
    stateKey,
    scope,
    manifestPath: installManifestPath(fixture.targetRoot, targetAdapter.name, scope),
    manifest,
    graphLockPath,
    sourceLock,
  };
}

function legacyStateKey(targetFingerprint: string): string {
  return stateKeyFor(targetAdapter.name, {
    installationType: "local",
    targetFingerprint,
  });
}

function legacyGraphPath(workspaceRoot: string, targetFingerprint: string): string {
  return join(
    workspaceRoot,
    ".agentwheel",
    "locks",
    "runtime-agent",
    targetAdapter.name,
    `${targetFingerprint}.graph-lock.json`,
  );
}

function sourceLockFixture(fixture: MigrationFixture): SourceLock {
  return {
    version: 1,
    driver: "local",
    source: fixture.sourceRoot,
    resolvedPath: fixture.sourceRoot,
    packageName: "fixture/target-state-migration",
    packageVersion: "1.0.0",
    mode: "pinned",
    sourceHash: "a".repeat(64),
    generatedAt: "2026-09-14T00:00:00.000Z",
    artifacts: [{
      type: "skills",
      name: "continuity-fixture",
      relativePath: "skills/continuity-fixture",
      kind: "dir",
      hash: "b".repeat(64),
    }],
  };
}

async function seedUnrelatedManifest(
  fixture: MigrationFixture,
  source: InstallManifestV2,
): Promise<string> {
  const stateKey = `${targetAdapter.name}.local.other-scope`;
  await writeInstallManifest({
    ...source,
    stateKey,
    revision: "pending-unrelated-state",
    entries: source.entries.map((entry) => ({
      ...entry,
      path: ".agents/skills/other-scope",
      artifactName: "other-scope",
      installName: "other-scope",
      logicalSelector: "skills/other-scope",
      workspaceOwner: "workspace-root:/fixture/other-scope",
    })),
  }, fixture.transport);
  return stateKey;
}

async function applyFixturePlan(
  fixture: MigrationFixture,
  result: Awaited<ReturnType<typeof graphPlan>>,
  transport: TargetTransport = fixture.transport,
): Promise<void> {
  assertInsideFixture(result.plan.targetRoot, [fixture.targetRoot, fixture.globalRoot]);
  assertInsideFixture(result.graphLockPath, [fixture.workspaceRoot]);
  await applyCombinedInstallPlan(result.plan, {
    transport,
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

function sshFixtureTransport(base: TargetTransport, description: string): TargetTransport {
  return { ...base, kind: "ssh", description };
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

async function persistentStateSnapshot(paths: string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const)));
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
