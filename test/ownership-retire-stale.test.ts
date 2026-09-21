import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { recoverPendingApply } from "../src/install/apply.js";
import { installManifestPath } from "../src/install/paths.js";
import { acquireApplyLock, applyJournalPath } from "../src/install/transaction.js";
import {
  applyRetireStaleOwnership,
  planRetireStaleOwnership,
  type RetireStaleOwnershipRequest,
} from "../src/lifecycle/ownership-retire-stale.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import { localTransport } from "../src/transport/index.js";
import type { TargetTransport } from "../src/transport/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stale ownership retirement", () => {
  it("retires exact same-Fleet duplicate ownership and keeps runtime bytes", async () => {
    const fixture = await createFixture({ sameFleet: true });
    const runtimeBefore = await readFile(fixture.runtimePath);
    const destinationBefore = await readFile(fixture.destinationManifestPath);
    const plan = await planRetireStaleOwnership(fixture.request);
    expect(plan.source.owner).toBe(workspaceOwnerForRoot(fixture.fromWorkspaceRoot, "delivery"));
    expect(plan.selected.map((item) => item.path)).toEqual(["config/managed.json"]);
    const result = await applyRetireStaleOwnership(applyRequest(fixture.request, plan));
    expect(result.sourceManifestRemoved).toBe(true);
    await expect(stat(fixture.sourceManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.destinationManifestPath)).toEqual(destinationBefore);
    expect(await readFile(fixture.runtimePath)).toEqual(runtimeBefore);
  });

  it("retains same-Fleet source-only ownership and refuses a wrong source Fleet", async () => {
    const fixture = await createFixture({ sameFleet: true, partial: true });
    await expect(planRetireStaleOwnership({ ...fixture.request, fromFleetId: "other" }))
      .rejects.toThrow(/same source and destination Fleet/i);
    const plan = await planRetireStaleOwnership(fixture.request);
    const result = await applyRetireStaleOwnership(applyRequest(fixture.request, plan));
    expect(result.sourceManifestRemoved).toBe(false);
    const source = await readInstallManifest(fixture.targetRoot, "codex", localTransport, {
      installationType: "user", stateKey: fixture.sourceStateKey,
    });
    expect(source?.version).toBe(2);
    if (!source || source.version !== 2) throw new Error("missing source manifest");
    expect(source.entries.map((item) => item.path).sort()).toEqual(["config/foreign.json", "config/source-only.json"]);
  });

  it("accepts only recursively exact JSON merge coverage by the destination", async () => {
    const fixture = await createFixture({
      sameFleet: true,
      runtimeContent: `${JSON.stringify({ a: { b: 1, c: 2 } })}\n`,
      sourcePatch: { mergeStrategy: "json-deep", mergeRemoval: { a: { b: 1 } } },
      destinationPatch: { mergeStrategy: "json-deep", mergeRemoval: { a: { b: 1, c: 2 } } },
    });
    const plan = await planRetireStaleOwnership(fixture.request);
    expect(plan.selected).toMatchObject([{ coverage: "exact" }]);
    const bad = await createFixture({
      sameFleet: true,
      runtimeContent: `${JSON.stringify({ a: { b: 1, c: 2 } })}\n`,
      sourcePatch: { mergeStrategy: "json-deep", mergeRemoval: { a: { b: 3 } } },
      destinationPatch: { mergeStrategy: "json-deep", mergeRemoval: { a: { b: 1, c: 2 } } },
    });
    await expect(planRetireStaleOwnership(bad.request)).rejects.toThrow(/does not exactly cover/i);
    const reorderedArray = await createFixture({
      sameFleet: true,
      runtimeContent: `${JSON.stringify({ items: [{ b: 2, a: 1 }] })}\n`,
      sourcePatch: { mergeStrategy: "json-deep", mergeRemoval: { items: [{ a: 1, b: 2 }] } },
      destinationPatch: { mergeStrategy: "json-deep", mergeRemoval: { items: [{ b: 2, a: 1 }] } },
    });
    // Preserve distinct array-object key order in the two on-disk manifests.
    // The normal manifest writer canonicalizes both, so write the raw v2 bodies.
    const rawSource = JSON.parse(await readFile(reorderedArray.sourceManifestPath, "utf8"));
    rawSource.entries[0].mergeRemoval = { items: [{ a: 1, b: 2 }] };
    await writeFile(reorderedArray.sourceManifestPath, JSON.stringify(rawSource));
    const rawDestination = JSON.parse(await readFile(reorderedArray.destinationManifestPath, "utf8"));
    rawDestination.entries[0].mergeRemoval = { items: [{ b: 2, a: 1 }] };
    await writeFile(reorderedArray.destinationManifestPath, JSON.stringify(rawDestination));
    await expect(planRetireStaleOwnership(reorderedArray.request))
      .rejects.toThrow(/does not exactly cover/i);
  });

  it("retires the same merge artifact across package revisions only with exact coverage", async () => {
    const source = {
      packageName: "fixture/pack",
      graphNodeId: "fixture/pack@1.0.0+aaaaaaaaaaaa",
      logicalSelector: "fixture/pack@1.0.0+aaaaaaaaaaaa:settings/managed.json",
      mergeStrategy: "json-deep",
      mergeRemoval: { a: { b: 1 } },
    };
    const destination = {
      ...source,
      graphNodeId: "fixture/pack@1.1.0+bbbbbbbbbbbb",
      logicalSelector: "fixture/pack@1.1.0+bbbbbbbbbbbb:settings/managed.json",
      mergeRemoval: { a: { b: 1, c: 2 } },
    };
    const fixture = await createFixture({
      sameFleet: true,
      runtimeContent: `${JSON.stringify({ a: { b: 1, c: 2 } })}\n`,
      sourcePatch: source,
      destinationPatch: destination,
    });
    const runtimeBefore = await readFile(fixture.runtimePath);
    const destinationBefore = await readFile(fixture.destinationManifestPath);
    const plan = await planRetireStaleOwnership(fixture.request);
    expect(plan.selected).toMatchObject([{ coverage: "exact" }]);
    await applyRetireStaleOwnership(applyRequest(fixture.request, plan));
    expect(await readFile(fixture.runtimePath)).toEqual(runtimeBefore);
    expect(await readFile(fixture.destinationManifestPath)).toEqual(destinationBefore);
    await expect(stat(fixture.sourceManifestPath)).rejects.toMatchObject({ code: "ENOENT" });

    for (const destinationPatch of [
      { ...destination, packageName: "fixture/other", graphNodeId: "fixture/other@1.1.0+bbbbbbbbbbbb", logicalSelector: "fixture/other@1.1.0+bbbbbbbbbbbb:settings/managed.json" },
      { ...destination, artifactName: "other.json", logicalSelector: "fixture/pack@1.1.0+bbbbbbbbbbbb:settings/other.json" },
      { ...destination, mergeRemoval: { a: { b: 3, c: 2 } } },
      { ...destination, logicalSelector: "arbitrary:settings/managed.json" },
    ]) {
      const bad = await createFixture({
        sameFleet: true,
        runtimeContent: `${JSON.stringify({ a: { b: 1, c: 2 } })}\n`,
        sourcePatch: source,
        destinationPatch,
      });
      await expect(planRetireStaleOwnership(bad.request))
        .rejects.toThrow(/does not identify the same source merge artifact|does not exactly cover/i);
    }
  });

  it("requires equal non-JSON merge contributions across revisions", async () => {
    const source = {
      packageName: "fixture/pack",
      graphNodeId: "fixture/pack@1.0.0+aaaaaaaaaaaa",
      logicalSelector: "fixture/pack@1.0.0+aaaaaaaaaaaa:mcp/managed.json",
      artifactType: "mcp",
      artifactName: "managed.json",
      mergeStrategy: "codex-toml-mcp",
      mergeRemoval: { mcpServers: { managed: { command: "old" } } },
    };
    const destination = {
      ...source,
      graphNodeId: "fixture/pack@1.1.0+bbbbbbbbbbbb",
      logicalSelector: "fixture/pack@1.1.0+bbbbbbbbbbbb:mcp/managed.json",
    };
    const runtimeContent = '[mcp_servers.managed]\ncommand = "old"\n';
    const fixture = await createFixture({ sameFleet: true, runtimeContent, sourcePatch: source, destinationPatch: destination });
    expect((await planRetireStaleOwnership(fixture.request)).selected).toMatchObject([{ coverage: "exact" }]);
    const changed = await createFixture({ sameFleet: true, runtimeContent, sourcePatch: source,
      destinationPatch: { ...destination, mergeRemoval: { mcpServers: { managed: { command: "new" } } } } });
    await expect(planRetireStaleOwnership(changed.request)).rejects.toThrow(/differs or is missing|does not exactly cover/i);
  });

  it("removes only exact stale source entries without touching runtime or destination", async () => {
    const fixture = await createFixture({ partial: true });
    const runtimeBefore = await readFile(fixture.runtimePath);
    const runtimeMtime = (await stat(fixture.runtimePath)).mtimeMs;
    const destinationBefore = await readFile(fixture.destinationManifestPath);
    const plan = await planRetireStaleOwnership(fixture.request);

    expect(plan.selected.map((entry) => entry.path)).toEqual(["config/managed.json"]);
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.manifestInventoryRevision).toMatch(/^[a-f0-9]{64}$/);

    const result = await applyRetireStaleOwnership(applyRequest(fixture.request, plan));
    expect(result.sourceManifestRemoved).toBe(false);
    expect(result.retainedSourceEntries).toBe(2);
    const source = await readInstallManifest(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    });
    expect(source?.version).toBe(2);
    if (!source || source.version !== 2) throw new Error("missing source manifest");
    expect(source.entries.map((entry) => entry.path).sort()).toEqual(["config/foreign.json", "config/source-only.json"]);
    expect(await readFile(fixture.destinationManifestPath)).toEqual(destinationBefore);
    expect(await readFile(fixture.runtimePath)).toEqual(runtimeBefore);
    expect((await stat(fixture.runtimePath)).mtimeMs).toBe(runtimeMtime);
  });

  it("removes only the empty source state after journal verification", async () => {
    const fixture = await createFixture();
    const plan = await planRetireStaleOwnership(fixture.request);
    const result = await applyRetireStaleOwnership(applyRequest(fixture.request, plan));
    expect(result.sourceManifestRemoved).toBe(true);
    await expect(stat(fixture.sourceManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.destinationManifestPath)).resolves.toBeTruthy();
    await expect(readFile(fixture.runtimePath, "utf8")).resolves.toBe("managed\n");
  });

  it("recovers idempotently after the source manifest write crashes", async () => {
    const fixture = await createFixture({ partial: true });
    const plan = await planRetireStaleOwnership(fixture.request);
    let injected = false;
    const transport: TargetTransport = {
      ...localTransport,
      writeJsonAtomic: async (path, value) => {
        await localTransport.writeJsonAtomic(path, value);
        if (!injected && path === fixture.sourceManifestPath) {
          injected = true;
          throw new Error("injected after source manifest write");
        }
      },
    };
    await expect(applyRetireStaleOwnership({ ...applyRequest(fixture.request, plan), transport }))
      .rejects.toThrow(/injected after source manifest write/i);
    await expect(stat(applyJournalPath(fixture.targetRoot, "codex", {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    }))).resolves.toBeTruthy();
    const recovered = await recoverPendingApply(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    });
    expect(recovered?.version).toBe(2);
    expect(recovered?.entries.map((item) => item.path).sort()).toEqual(["config/foreign.json", "config/source-only.json"]);
    expect(await recoverPendingApply(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    })).toBeUndefined();
  });

  it("recovers idempotently after complete source-state removal crashes", async () => {
    const fixture = await createFixture();
    const plan = await planRetireStaleOwnership(fixture.request);
    let injected = false;
    const transport: TargetTransport = {
      ...localTransport,
      rm: async (path) => {
        await localTransport.rm(path);
        if (!injected && path === fixture.sourceManifestPath) {
          injected = true;
          throw new Error("injected after source manifest removal");
        }
      },
    };
    await expect(applyRetireStaleOwnership({ ...applyRequest(fixture.request, plan), transport }))
      .rejects.toThrow(/injected after source manifest removal/i);
    await expect(stat(fixture.destinationManifestPath)).resolves.toBeTruthy();
    await expect(readFile(fixture.runtimePath, "utf8")).resolves.toBe("managed\n");
    const recovered = await recoverPendingApply(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    });
    expect(recovered?.entries).toEqual([]);
    await expect(stat(fixture.sourceManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverPendingApply(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    })).toBeUndefined();
  });

  it("fails closed when source, destination, or inventory changes after review", async () => {
    const fixture = await createFixture();
    const plan = await planRetireStaleOwnership(fixture.request);
    const source = await readInstallManifest(fixture.targetRoot, "codex", localTransport, {
      installationType: "user",
      stateKey: fixture.sourceStateKey,
    });
    if (!source || source.version !== 2) throw new Error("missing source manifest");
    await writeInstallManifest({ ...source, generatedAt: "2026-08-31T01:00:00.000Z" });
    await expect(applyRetireStaleOwnership(applyRequest(fixture.request, plan))).rejects.toThrow(/plan digest|source manifest revision|replan/i);

    const fresh = await planRetireStaleOwnership(fixture.request);
    await writeInstallManifest(manifest(
      fixture.targetRoot,
      "codex.user.unrelated",
      workspaceOwnerForRoot(fixture.fromWorkspaceRoot),
      [],
    ));
    await expect(applyRetireStaleOwnership(applyRequest(fixture.request, fresh))).rejects.toThrow(/plan digest|inventory revision|replan/i);
  });

  it("revalidates under the shared runtime lock against a TOCTOU mutation", async () => {
    const fixture = await createFixture();
    const plan = await planRetireStaleOwnership(fixture.request);
    let injected = false;
    const transport: TargetTransport = {
      ...localTransport,
      mkdirExclusive: async (path) => {
        await localTransport.mkdirExclusive(path);
        if (!injected && path.endsWith(".runtime-apply-lock")) {
          injected = true;
          const source = await readInstallManifest(fixture.targetRoot, "codex", localTransport, {
            installationType: "user",
            stateKey: fixture.sourceStateKey,
          });
          if (!source || source.version !== 2) throw new Error("missing source manifest");
          await writeInstallManifest({ ...source, generatedAt: "2026-08-31T02:00:00.000Z" });
        }
      },
    };
    await expect(applyRetireStaleOwnership({
      ...applyRequest(fixture.request, plan),
      transport,
    })).rejects.toThrow(/plan digest|source manifest revision|replan/i);
    await expect(stat(fixture.sourceManifestPath)).resolves.toBeTruthy();
  });

  it("blocks concurrent mutations and every pending journal state key", async () => {
    const fixture = await createFixture();
    const plan = await planRetireStaleOwnership(fixture.request);
    const lock = await acquireApplyLock(fixture.targetRoot, "codex", localTransport, {}, {
      installationType: "user",
      stateKey: fixture.destinationStateKey,
    });
    try {
      await expect(applyRetireStaleOwnership(applyRequest(fixture.request, plan))).rejects.toThrow(/lock|active|held/i);
    } finally {
      await lock.release();
    }

    await localTransport.writeJsonAtomic(applyJournalPath(fixture.targetRoot, "codex", {
      installationType: "local",
      stateKey: "codex.local.other",
    }), {
      version: 1,
      adapter: "codex",
      installationType: "local",
      stateKey: "codex.local.other",
      targetRoot: fixture.targetRoot,
      baseRevision: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      operations: [],
      completed: [],
      manifest: { ...manifest(fixture.targetRoot, "codex.local.other", "workspace-root:/other", []), installationType: "local" },
    });
    await expect(applyRetireStaleOwnership(applyRequest(fixture.request, plan))).rejects.toThrow(/journal.*pending/i);
  });

  it("rejects wrong owners, runtime mismatch, semantic state, and incomplete merges", async () => {
    const wrongOwner = await createFixture({ destinationOwner: "workspace-root:/wrong" });
    await expect(planRetireStaleOwnership(wrongOwner.request)).rejects.toThrow(/No stale source ownership entries match/i);

    const drifted = await createFixture();
    await writeFile(drifted.runtimePath, "drifted\n");
    await expect(planRetireStaleOwnership(drifted.request)).rejects.toThrow(/drifted/i);

    const semantic = await createFixture({ sourcePatch: { semanticCommand: ["fixture"] } });
    await expect(planRetireStaleOwnership(semantic.request)).rejects.toThrow(/semantic source ownership/i);

    const incomplete = await createFixture({
      runtimeContent: `${JSON.stringify({ destination: true }, null, 2)}\n`,
      sourcePatch: { mergeStrategy: "json-deep" },
      destinationPatch: { mergeStrategy: "json-deep" },
    });
    await expect(planRetireStaleOwnership(incomplete.request)).rejects.toThrow(/incomplete merge ownership/i);
    const abandonedPlan = await planRetireStaleOwnership({
      ...incomplete.request,
      abandonIncompleteMergeOwner: true,
    });
    expect(abandonedPlan.selected).toMatchObject([{
      path: "config/managed.json",
      coverage: "abandoned-incomplete-merge",
    }]);
    expect(abandonedPlan.selected[0]?.runtimeHash).toBe(await localTransport.hashPath(incomplete.runtimePath));

    const differentBlock = await createFixture({
      sourcePatch: { mode: "managed-block", logicalSelector: "instructions/source" },
      destinationPatch: { mode: "managed-block", logicalSelector: "instructions/destination" },
    });
    await expect(planRetireStaleOwnership(differentBlock.request)).rejects.toThrow(/does not exactly cover.*managed block/i);

    const differentMerge = await createFixture({
      sourcePatch: { mergeStrategy: "json-deep", mergeRemoval: { source: true } },
      destinationPatch: { mergeStrategy: "json-deep", mergeRemoval: { destination: true } },
    });
    await writeFile(differentMerge.runtimePath, `${JSON.stringify({ source: true, destination: true }, null, 2)}\n`);
    await expect(planRetireStaleOwnership(differentMerge.request)).rejects.toThrow(/does not exactly cover.*merge contribution/i);

    const plainToMerge = await createFixture({
      destinationPatch: { mergeStrategy: "json-deep", mergeRemoval: { destination: true } },
    });
    await expect(planRetireStaleOwnership(plainToMerge.request)).rejects.toThrow(/category merge cannot replace.*category plain/i);

    const mergeToPlain = await createFixture({
      sourcePatch: { mergeStrategy: "json-deep", mergeRemoval: { source: true } },
    });
    await expect(planRetireStaleOwnership(mergeToPlain.request)).rejects.toThrow(/category plain cannot replace.*category merge/i);

    const traversal = await createFixture({
      sourcePatch: { path: "../escape.json", mergeStrategy: "json-deep", mergeRemoval: { source: true } },
      destinationPatch: { path: "../escape.json", mergeStrategy: "json-deep", mergeRemoval: { destination: true } },
    });
    await expect(planRetireStaleOwnership(traversal.request)).rejects.toThrow(/escapes target root|unsafe managed artifact path/i);
  });
});

function applyRequest(request: RetireStaleOwnershipRequest, plan: Awaited<ReturnType<typeof planRetireStaleOwnership>>): RetireStaleOwnershipRequest {
  return {
    ...request,
    planDigest: plan.planDigest,
    expectedSourceRevision: plan.source.revision,
    expectedDestinationRevision: plan.destination.revision,
    expectedInventoryRevision: plan.manifestInventoryRevision,
  };
}

async function createFixture(options: {
  partial?: boolean;
  sameFleet?: boolean;
  destinationOwner?: string;
  sourcePatch?: Record<string, unknown>;
  destinationPatch?: Record<string, unknown>;
  runtimeContent?: string;
} = {}) {
  const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-retire-target-"));
  const fromWorkspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-retire-from-"));
  const toWorkspaceRoot = options.sameFleet
    ? fromWorkspaceRoot
    : await mkdtemp(join(tmpdir(), "agentwheel-retire-to-"));
  roots.push(targetRoot, fromWorkspaceRoot, toWorkspaceRoot);
  const sourceStateKey = "codex.user.legacy";
  const destinationStateKey = "codex.user.fleet-delivery.fixture";
  const runtimePath = join(targetRoot, "config", "managed.json");
  await mkdir(join(targetRoot, "config"), { recursive: true });
  await writeFile(runtimePath, options.runtimeContent ?? "managed\n");
  await writeFile(join(targetRoot, "config", "source-only.json"), "source-only\n");
  await writeFile(join(targetRoot, "config", "foreign.json"), "foreign\n");
  const hash = await localTransport.hashPath(runtimePath);
  const sourceOwner = workspaceOwnerForRoot(fromWorkspaceRoot, options.sameFleet ? "delivery" : undefined);
  const sourceEntries = [entry("config/managed.json", hash, sourceOwner, options.sourcePatch)];
  if (options.partial) {
    sourceEntries.push(entry("config/source-only.json", await localTransport.hashPath(join(targetRoot, "config", "source-only.json")), sourceOwner));
    sourceEntries.push(entry("config/foreign.json", await localTransport.hashPath(join(targetRoot, "config", "foreign.json")), "workspace-root:/foreign"));
  }
  await writeInstallManifest(manifest(targetRoot, sourceStateKey, sourceOwner, sourceEntries));
  await writeInstallManifest(manifest(targetRoot, destinationStateKey, options.destinationOwner ?? workspaceOwnerForRoot(toWorkspaceRoot, "delivery"), [
    entry("config/managed.json", hash, options.destinationOwner ?? workspaceOwnerForRoot(toWorkspaceRoot, "delivery"), options.destinationPatch),
  ]));
  return {
    targetRoot,
    fromWorkspaceRoot,
    toWorkspaceRoot,
    sourceStateKey,
    destinationStateKey,
    runtimePath,
    sourceManifestPath: installManifestPath(targetRoot, "codex", { installationType: "user", stateKey: sourceStateKey }),
    destinationManifestPath: installManifestPath(targetRoot, "codex", { installationType: "user", stateKey: destinationStateKey }),
    request: {
      targetRoot,
      adapter: "codex",
      installationType: "user",
      sourceStateKey,
      destinationStateKey,
      fromWorkspaceRoot,
      ...(options.sameFleet ? { fromFleetId: "delivery" } : {}),
      toWorkspaceRoot,
      toFleetId: "delivery",
    } satisfies RetireStaleOwnershipRequest,
  };
}

function manifest(targetRoot: string, stateKey: string, _owner: string, entries: ReturnType<typeof entry>[]) {
  return {
    version: 2 as const,
    adapter: "codex",
    installationType: "user",
    stateKey,
    targetRoot,
    generatedAt: "2026-08-31T00:00:00.000Z",
    revision: "pending-fixture-revision",
    legacy: false as const,
    entries,
  };
}

function entry(path: string, hash: string, workspaceOwner: string, patch: Record<string, unknown> = {}) {
  const name = path.split("/").at(-1)!;
  return {
    path,
    artifactType: "settings" as const,
    artifactName: name,
    installName: name,
    logicalSelector: `settings/${name}`,
    kind: "file" as const,
    hash,
    sourceHash: hash,
    updatedAt: "2026-08-31T00:00:00.000Z",
    channel: "managed" as const,
    dependencyRole: "root" as const,
    owners: [name],
    refCount: 1,
    workspaceOwner,
    ...patch,
  };
}
