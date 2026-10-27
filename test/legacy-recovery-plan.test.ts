import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath, stateKeyFor } from "../src/install/paths.js";
import { desiredManagedInstructionBlockHash, writeManagedInstructionBlock } from "../src/install/instructions-block.js";
import { planLegacyRecovery, type HistoricalLock } from "../src/lifecycle/legacy-recovery-plan.js";
import type { GraphSourcePlanResult } from "../src/lifecycle/source-plan.js";
import { localTransport } from "../src/transport/index.js";
import type { TargetTransport } from "../src/transport/index.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-recovery-test-"));
  roots.push(root);
  const path = ".agents/skills/example/SKILL.md";
  const full = join(root, path);
  await mkdir(join(root, ".agents/skills/example"), { recursive: true });
  await writeFile(full, "current\n");
  const hash = await localTransport.hashPath(full);
  const fingerprint = "e".repeat(64);
  const boundStateKey = stateKeyFor("codex", { installationType: "user", targetFingerprint: fingerprint, fleetId: "fixture" });
  const graphPlan = {
    graphLockDigest: "current-lock",
    graphLockPath: join(root, ".agentwheel/locks/sample-codex/codex/current.graph-lock.json"),
    targetFingerprint: "f".repeat(64), warnings: [],
    graph: { nodes: [{ id: "node-a", sourceHash: "source-current", selected: ["skills/example"] }], edges: [],
      roots: [{ rootId: "root", source: "fixture", graphNodeId: "node-a", selected: ["skills/example"] }] },
    bundle: { graphLock: { canonical: { nodes: [{ id: "node-a", sourceHash: "source-current", selected: ["skills/example"] }], edges: [] } } },
    plan: { stateKey: "codex.user.current", operations: [{ action: "skip", destPath: full, desiredHash: hash, graphNodeId: "node-a" }] },
  } as unknown as GraphSourcePlanResult;
  const makeClaim = async (stateKey: string, patch: Record<string, unknown> = {}, manifestPatch: Record<string, unknown> = {}) => {
    await writeInstallManifest({
      version: 2, adapter: "codex", installationType: "user", stateKey, targetRoot: root,
      generatedAt: "2026-09-18T00:00:00.000Z", revision: "fixture-revision-123", legacy: false,
      entries: [{
        path, artifactType: "skills", artifactName: "example", installName: "example",
        logicalSelector: "skills/example", graphNodeId: "node-a", kind: "file", hash,
        sourceHash: "a".repeat(64), updatedAt: "2026-09-18T00:00:00.000Z", channel: "managed",
        dependencyRole: "root", owners: ["old-root"], refCount: 1,
        workspaceOwner: workspaceOwnerForRoot(root, "fixture"), graphLockDigest: "old-lock", ...patch,
      }], ...manifestPatch,
    });
  };
  const lock = { path: join(root, `.agentwheel/locks/sample-codex/codex/${fingerprint}.graph-lock.json`), digest: "old-lock", lock: {
    canonical: { targetFingerprint: fingerprint, artifacts: [{ graphNodeId: "node-a", logicalSelector: "skills/example", hash: "a".repeat(64) }] },
  } } as HistoricalLock;
  const run = (locks: HistoricalLock[] = [lock]) => planLegacyRecovery({
    graphPlan, installRoot: root, workspaceRoot: root, fleetId: "fixture", targetKey: "sample-codex",
    adapter: "codex", installationType: "user", historicalLocks: locks,
    transport: localTransport,
  });
  return { root, path, full, hash, graphPlan, makeClaim, lock, run, boundStateKey };
}

describe("read-only legacy recovery evidence", () => {
  it("keeps a missing historical lock unresolved and leaves runtime bytes unchanged", async () => {
    const f = await fixture();
    await f.makeClaim("codex.user.old");
    const before = await stat(f.full);
    const report = await f.run([]);
    expect(report.paths[0]).toMatchObject({ category: "unresolved", currentHash: f.hash, liveHash: f.hash });
    expect(report.paths[0]?.currentGraphStatus).toBe("exact-match");
    expect(report.paths[0]?.claims[0]?.evidence).toContain("historical graph-lock digest has no matching lock");
    expect(await readFile(f.full, "utf8")).toBe("current\n");
    expect((await stat(f.full)).mtimeMs).toBe(before.mtimeMs);
  });

  it("exposes roots and optional resolution warnings with complete=false", async () => {
    const f = await fixture();
    f.graphPlan.warnings.push("optional dependency skipped: fixture source unavailable");
    const report = await f.run();
    expect(report.roots).toMatchObject([{ rootId: "root", source: "fixture" }]);
    expect(report.resolutionWarnings).toEqual(["optional dependency skipped: fixture source unavailable"]);
    expect(report.complete).toBe(false);
    expect(report.currentGraphCounts["exact-match"]).toBe(1);
    expect(report.paths[0]?.category).toBe("unresolved");
  });

  it("does not treat an intentionally excluded runtime as an incomplete graph", async () => {
    const f = await fixture();
    f.graphPlan.warnings.push("skip artifact example:commands/other (selected but not targeted: runtimes=[hermes])");
    f.graphPlan.warnings.push("skip dependency example:hooks/other (not targeted: runtimes=[claude])");
    const report = await f.run();
    expect(report.resolutionWarnings).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.paths[0]?.category).toBe("current-graph-exact-match");
  });

  it("checks a managed block rather than the enclosing file hash", async () => {
    const f = await fixture();
    const source = join(f.root, "source.md");
    await writeFile(source, "owned content\n");
    await writeFile(f.full, "unmanaged preface\n");
    await writeManagedInstructionBlock(source, f.full, "skills/example", localTransport);
    const desiredHash = await desiredManagedInstructionBlockHash(source);
    f.graphPlan.plan.operations[0] = { ...f.graphPlan.plan.operations[0]!, mode: "managed-block",
      logicalSelector: "skills/example", desiredHash, sourcePath: source };
    const report = await f.run();
    expect(report.paths[0]?.currentGraphStatus).toBe("exact-match");
    expect(report.paths[0]?.liveHash).not.toBe(desiredHash);
  });

  it("checks a merged contribution and binds lock artifact hash to sourceHash", async () => {
    const f = await fixture();
    const source = join(f.root, "source.json");
    await writeFile(source, '{"managed":true}\n');
    await writeFile(f.full, '{"managed":true,"unmanaged":"kept"}\n');
    const sourceHash = await localTransport.hashPath(source);
    const liveHash = await localTransport.hashPath(f.full);
    f.graphPlan.plan.operations[0] = { ...f.graphPlan.plan.operations[0]!, mergeStrategy: "json-deep",
      desiredHash: sourceHash, sourcePath: source };
    await f.makeClaim(f.boundStateKey, { hash: liveHash, sourceHash, mergeStrategy: "json-deep",
      mergeRemoval: { managed: true } });
    const lock = { ...f.lock, lock: { ...f.lock.lock, canonical: { ...f.lock.lock.canonical,
      artifacts: [{ graphNodeId: "node-a", logicalSelector: "skills/example", hash: sourceHash }] } } } as HistoricalLock;
    const report = await f.run([lock]);
    expect(report.paths[0]?.currentGraphStatus).toBe("exact-match");
    expect(report.paths[0]?.claims[0]).toMatchObject({ scope: "same-target", evidence: [] });
    expect(report.paths[0]?.liveHash).not.toBe(sourceHash);
  });

  it("separates foreign owner, type, and root claims and rejects an unbound state key", async () => {
    const f = await fixture();
    await f.makeClaim("codex.user.foreign-owner", { workspaceOwner: workspaceOwnerForRoot("/foreign") });
    await f.makeClaim("codex.local.foreign-type", {}, { installationType: "local" });
    await f.makeClaim("codex.user.foreign-root");
    const rootPath = installManifestPath(f.root, "codex", { stateKey: "codex.user.foreign-root" });
    const raw = JSON.parse(await readFile(rootPath, "utf8"));
    raw.targetRoot = "/different-runtime";
    await writeFile(rootPath, JSON.stringify(raw));
    await f.makeClaim("codex.user.unbound-key");
    const report = await f.run();
    expect(report.paths[0]?.foreignClaims).toHaveLength(3);
    expect(report.paths[0]?.claims).toMatchObject([{ scope: "unbound" }]);
    expect(report.paths[0]?.category).toBe("unresolved");
  });

  it("marks divergent same-owner claims unresolved", async () => {
    const f = await fixture();
    await f.makeClaim("codex.user.old-a");
    await f.makeClaim("codex.user.old-b", { hash: "b".repeat(64) });
    const report = await f.run();
    expect(report.paths[0]?.category).toBe("unresolved");
    expect(report.paths[0]?.reasons).toContain("competing same-target claims diverge");
    expect(report.paths[0]?.claims).toHaveLength(2);
  });

  it("does not infer provenance from a different historical lock digest", async () => {
    const f = await fixture();
    await f.makeClaim("codex.user.old", { graphLockDigest: "1".repeat(64) });
    const report = await f.run([{ ...f.lock, digest: "2".repeat(64) }]);
    expect(report.paths[0]?.category).toBe("unresolved");
    expect(report.paths[0]?.claims[0]?.lockPaths).toEqual([]);
  });

  it("rejects a lock whose filename fingerprint does not match its graph", async () => {
    const f = await fixture();
    await f.makeClaim(f.boundStateKey);
    const wrong = { ...f.lock, path: f.lock.path.replace("e".repeat(64), "d".repeat(64)) };
    const report = await f.run([wrong]);
    expect(report.paths[0]?.claims[0]?.scope).toBe("unbound");
    expect(report.paths[0]?.claims[0]?.evidence).toContain("graph-lock fingerprint, filename, or state key does not bind claim");
  });

  it("uses the planner's exact destination, including Codex's .agents mapping", async () => {
    const f = await fixture();
    const report = await f.run();
    expect(report.paths).toMatchObject([{ path: f.path, category: "current-graph-exact-match" }]);
    expect(report.paths[0]?.currentSourceHashes).toEqual(["source-current"]);
  });

  it("does not silently drop a selected dependency when its destination is absent", async () => {
    const f = await fixture();
    f.graphPlan.graph.nodes.push({ id: "node-dependency", sourceHash: "source-dependency", selected: ["skills/dependency"] } as never);
    await expect(f.run()).rejects.toThrow(/omitted selected node or dependency/);
  });

  it("uses only read operations on the target transport", async () => {
    const f = await fixture();
    const forbidden = async () => { throw new Error("runtime mutation attempted"); };
    const transport = { ...localTransport, mkdirExclusive: forbidden, writeFileAtomic: forbidden,
      writeJsonAtomic: forbidden, atomicCopy: forbidden, rm: forbidden } as TargetTransport;
    const report = await planLegacyRecovery({ graphPlan: f.graphPlan, installRoot: f.root,
      workspaceRoot: f.root, fleetId: "fixture",
      targetKey: "sample-codex", adapter: "codex", installationType: "user", historicalLocks: [], transport });
    expect(report.counts["current-graph-exact-match"]).toBe(1);
  });
});
