import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { listInstallManifests, type DiscoveredInstallManifest } from "../install/manifest.js";
import { stateKeyFor } from "../install/paths.js";
import { managedInstructionSelector, readManagedInstructionBlockState } from "../install/instructions-block.js";
import { assertExactMergeContribution, assertMergedSourceContribution, hasMergeRemovalContent } from "../install/merge-removal.js";
import { canonicalGraphLockJson, readGraphLock, type GraphLock } from "../model/graph-lock.js";
import { legacyUnownedWorkspaceOwner, type InstallManifestEntry, type InstallManifestV1Entry } from "../model/manifest.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import type { InstallOperation } from "../install/plan.js";
import type { GraphSourcePlanResult } from "./source-plan.js";
import type { TargetTransport } from "../transport/index.js";

export interface HistoricalLock { path: string; digest: string; lock: GraphLock }
export interface RecoveryClaim {
  scope: "same-target" | "unbound" | "foreign";
  manifestPath: string;
  stateKey: string;
  manifestStateKey?: string;
  installationType?: string;
  targetRoot: string;
  owner: string;
  hash: string;
  sourceHash: string;
  graphLockDigest?: string;
  graphNodeId?: string;
  logicalSelector?: string;
  owners: string[];
  lockPaths: string[];
  evidence: string[];
}
export interface RecoveryPath {
  path: string;
  category: "current-graph-exact-match" | "retirement-candidate" | "unresolved";
  currentGraphStatus: "exact-match" | "mismatch" | "absent" | "unverifiable";
  reasons: string[];
  currentHash: string | null;
  currentHashes: string[];
  currentSourceHashes: string[];
  currentNodeIds: string[];
  currentSelectors: string[];
  currentOwners: string[];
  liveHash: string | null;
  claims: RecoveryClaim[];
  foreignClaims: RecoveryClaim[];
}
export interface LegacyRecoveryReport {
  targetRoot: string;
  targetKey: string;
  adapter: string;
  installationType: string;
  currentGraphLockDigest: string;
  roots: Array<{ rootId: string; source: string; graphNodeId: string; selected: string[] }>;
  resolutionWarnings: string[];
  complete: boolean;
  paths: RecoveryPath[];
  counts: Record<RecoveryPath["category"], number>;
  currentGraphCounts: Record<RecoveryPath["currentGraphStatus"], number>;
}

export async function inventoryHistoricalLocks(fleetRoot: string): Promise<HistoricalLock[]> {
  const root = join(fleetRoot, ".agentwheel", "locks");
  const found: HistoricalLock[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".graph-lock.json")) {
        const lock = await readGraphLock(path);
        found.push({ path, digest: sha256(canonicalGraphLockJson(lock)), lock });
      }
    }
  }
  await visit(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export async function planLegacyRecovery(input: {
  graphPlan: GraphSourcePlanResult;
  installRoot: string;
  workspaceRoot: string;
  fleetId?: string;
  explicitStateKey?: string;
  targetKey: string;
  adapter: string;
  installationType: string;
  historicalLocks: HistoricalLock[];
  transport: TargetTransport;
}): Promise<LegacyRecoveryReport> {
  const { graphPlan, installRoot, targetKey, adapter, installationType, historicalLocks, transport } = input;
  assertCompleteGraphPlan(graphPlan);
  const binding = {
    targetLockDir: dirname(graphPlan.graphLockPath), stableLockPath: graphPlan.graphLockPath,
    stableStateKey: graphPlan.plan.stateKey, currentFingerprint: graphPlan.targetFingerprint,
    expectedOwner: workspaceOwnerForRoot(input.workspaceRoot, input.fleetId),
    installRoot, adapter, installationType, fleetId: input.fleetId, explicitStateKey: input.explicitStateKey,
    transportKind: transport.kind,
  };
  const manifests = await listInstallManifests(installRoot, adapter, transport);
  const paths = new Set<string>();
  const desired = new Map<string, InstallOperation[]>();
  const nodeHashes = new Map(graphPlan.bundle.graphLock.canonical.nodes.map((node) => [node.id, node.sourceHash]));
  for (const op of graphPlan.plan.operations) {
    if (!op.desiredHash || op.action === "remove" || op.action === "keep") continue;
    const path = relative(installRoot, op.destPath);
    if (path.startsWith("..") || path === "") throw new Error(`Planner destination escapes target: ${op.destPath}`);
    paths.add(path);
    const items = desired.get(path) ?? [];
    items.push(op);
    desired.set(path, items);
  }
  for (const item of manifests) for (const entry of item.manifest.entries) paths.add(entry.path);
  const resolutionWarnings = graphPlan.warnings.filter((warning) =>
    !/^skip (?:artifact|dependency) .+ \((?:selected but )?not targeted: runtimes=\[[^\]]+\]\)$/.test(warning));
  const complete = resolutionWarnings.length === 0;
  const output: RecoveryPath[] = [];
  for (const path of [...paths].sort()) {
    const allClaims = manifests.flatMap((item) => item.manifest.entries
      .filter((entry) => entry.path === path)
      .map((entry) => claimFor(item, entry, historicalLocks, binding)));
    const claims = allClaims.filter((claim) => claim.scope !== "foreign");
    const foreignClaims = allClaims.filter((claim) => claim.scope === "foreign");
    const current = desired.get(path) ?? [];
    const currentHashes = [...new Set(current.map((item) => item.desiredHash!))];
    const currentSourceHashes = [...new Set(current.map((item) => item.graphNodeId ? nodeHashes.get(item.graphNodeId) : undefined)
      .filter((value): value is string => Boolean(value)))].sort();
    const currentNodeIds = [...new Set(current.map((item) => item.graphNodeId).filter((value): value is string => Boolean(value)))].sort();
    const currentSelectors = [...new Set(current.map((item) => item.logicalSelector).filter((value): value is string => Boolean(value)))].sort();
    const currentOwners = [...new Set(current.flatMap((item) => item.owners ?? []))].sort();
    const livePath = resolve(installRoot, path);
    if (relative(installRoot, livePath).startsWith("..")) throw new Error(`Manifest path escapes target: ${path}`);
    const liveHash = await transport.pathExists(livePath) ? await transport.hashPath(livePath) : null;
    const reasons: string[] = [];
    const currentResults = await Promise.all(current.map((op) => verifyCurrentOperation(op, liveHash, transport)));
    const currentGraphStatus: RecoveryPath["currentGraphStatus"] = current.length === 0 ? "absent"
      : currentResults.every((result) => result === "exact-match") ? "exact-match"
        : currentResults.some((result) => result === "unverifiable") ? "unverifiable" : "mismatch";
    if (currentHashes.length > 1 && current.some((op) => !op.mergeStrategy && op.mode !== "managed-block")) {
      reasons.push("current graph has divergent hashes for the destination");
    }
    if (currentGraphStatus === "mismatch") reasons.push("live contribution differs from current source");
    if (currentGraphStatus === "unverifiable") reasons.push("current contribution could not be verified");
    if (current.some((op) => op.action === "conflict" || op.action === "drift")) reasons.push("install planner has a blocking operation");
    if (!complete) reasons.push("current source graph has resolution warnings; completeness unproven");
    if (claims.some((claim) => claim.scope === "unbound" || claim.evidence.length)) reasons.push("historical provenance unresolved");
    if (foreignClaims.length) reasons.push("foreign manifest claim conflicts with destination");
    if (new Set(claims.map((claim) => `${claim.owner}:${claim.hash}:${claim.sourceHash}:${claim.graphLockDigest ?? ""}`)).size > 1) {
      reasons.push("competing same-target claims diverge");
    }
    if (current.length === 0 && claims.length === 0) reasons.push("no same-target historical claim");
    if (current.length === 0) {
      for (const claim of claims) {
        if (claim.scope !== "same-target") continue;
        const item = manifests.find((manifest) => manifest.path === claim.manifestPath)!;
        const entry = item.manifest.entries.find((candidate) => candidate.path === path && candidate.sourceHash === claim.sourceHash)!;
        if (!await verifyHistoricalEntry(entry, livePath, liveHash, transport)) {
          reasons.push("live contribution differs from same-target historical claim");
          break;
        }
      }
    }
    const category: RecoveryPath["category"] = reasons.length
      ? "unresolved"
      : currentGraphStatus === "exact-match" ? "current-graph-exact-match" : "retirement-candidate";
    output.push({ path, category, reasons, currentHash: currentHashes.length === 1 ? currentHashes[0]! : null,
      currentHashes: currentHashes.sort(), currentSourceHashes,
      currentNodeIds, currentSelectors, currentOwners, currentGraphStatus, liveHash, claims, foreignClaims });
  }
  const counts = { "current-graph-exact-match": 0, "retirement-candidate": 0, unresolved: 0 };
  const currentGraphCounts = { "exact-match": 0, mismatch: 0, absent: 0, unverifiable: 0 };
  for (const path of output) counts[path.category]++;
  for (const path of output) currentGraphCounts[path.currentGraphStatus]++;
  return { targetRoot: installRoot, targetKey, adapter, installationType, currentGraphLockDigest: graphPlan.graphLockDigest,
    roots: graphPlan.graph.roots.map((root) => ({ rootId: root.rootId, source: root.source, graphNodeId: root.graphNodeId, selected: root.selected })),
    resolutionWarnings, complete, paths: output, counts, currentGraphCounts };
}

interface ClaimBinding {
  targetLockDir: string;
  stableLockPath: string;
  stableStateKey?: string;
  currentFingerprint: string;
  expectedOwner: string;
  installRoot: string;
  adapter: string;
  installationType: string;
  fleetId?: string;
  explicitStateKey?: string;
  transportKind: TargetTransport["kind"];
}

function claimFor(item: DiscoveredInstallManifest, entry: InstallManifestEntry | InstallManifestV1Entry, locks: HistoricalLock[], binding: ClaimBinding): RecoveryClaim {
  const digest = "graphLockDigest" in entry ? entry.graphLockDigest : undefined;
  const nodeId = "graphNodeId" in entry ? entry.graphNodeId : undefined;
  const selector = "logicalSelector" in entry ? entry.logicalSelector : undefined;
  const matches = locks.filter((candidate) => candidate.digest === digest);
  const evidence: string[] = [];
  const owner = "workspaceOwner" in entry ? entry.workspaceOwner : legacyUnownedWorkspaceOwner;
  const sameRoot = binding.transportKind === "ssh"
    ? posix.normalize(item.manifest.targetRoot) === posix.normalize(binding.installRoot)
    : resolve(item.manifest.targetRoot) === resolve(binding.installRoot);
  const inTargetDir = matches.filter((candidate) => resolve(dirname(candidate.path)) === resolve(binding.targetLockDir));
  const boundLocks = inTargetDir.filter((candidate) => lockBindsState(candidate, item, binding));
  if (owner !== binding.expectedOwner) evidence.push("workspace owner differs from selected Fleet target");
  if (item.manifest.version !== 2 || item.manifest.installationType !== binding.installationType) evidence.push("installation type differs or manifest is legacy v1");
  if (!sameRoot) evidence.push("manifest target root differs from selected Fleet target");
  if (item.manifest.version === 2 && (item.manifest.stateKey !== item.stateKey || item.manifest.adapter !== binding.adapter)) {
    evidence.push("manifest state key or adapter differs from filename");
  }
  if (!digest) evidence.push("historical graph-lock digest missing");
  else if (matches.length === 0) evidence.push("historical graph-lock digest has no matching lock");
  if (matches.length && !inTargetDir.length) evidence.push("claim belongs to another Fleet target graph");
  if (inTargetDir.length && !boundLocks.length) evidence.push("graph-lock fingerprint, filename, or state key does not bind claim");
  if (boundLocks.length && !boundLocks.some((candidate) => candidate.lock.canonical.artifacts.some((artifact) =>
    artifact.graphNodeId === nodeId && artifact.logicalSelector === selector))) {
    evidence.push("historical graph-lock selector/node does not cover claim");
  } else if (boundLocks.length && !boundLocks.some((candidate) => candidate.lock.canonical.artifacts.some((artifact) =>
    artifact.graphNodeId === nodeId && artifact.logicalSelector === selector && artifact.hash === entry.sourceHash))) {
    evidence.push("historical graph-lock artifact hash differs from manifest source hash");
  }
  const foreign = owner !== binding.expectedOwner || !sameRoot
    || item.manifest.version !== 2 || item.manifest.installationType !== binding.installationType
    || (item.manifest.version === 2 && (item.manifest.stateKey !== item.stateKey || item.manifest.adapter !== binding.adapter))
    || (matches.length > 0 && inTargetDir.length === 0);
  const scope: RecoveryClaim["scope"] = foreign ? "foreign" : boundLocks.length && evidence.length === 0 ? "same-target" : "unbound";
  return {
    scope, manifestPath: item.path, stateKey: item.stateKey,
    manifestStateKey: item.manifest.version === 2 ? item.manifest.stateKey : undefined,
    installationType: item.manifest.version === 2 ? item.manifest.installationType : undefined,
    targetRoot: item.manifest.targetRoot, owner,
    hash: entry.hash, sourceHash: entry.sourceHash, graphLockDigest: digest,
    graphNodeId: nodeId, logicalSelector: selector,
    owners: "owners" in entry ? entry.owners : [entry.packageName ?? "legacy"],
    lockPaths: matches.map((candidate) => candidate.path), evidence,
  };
}

function lockBindsState(candidate: HistoricalLock, manifest: DiscoveredInstallManifest, binding: ClaimBinding): boolean {
  const name = basename(candidate.path);
  if (!name.endsWith(".graph-lock.json")) return false;
  const fingerprint = name.slice(0, -".graph-lock.json".length);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) return false;
  const stable = resolve(candidate.path) === resolve(binding.stableLockPath);
  if (stable) {
    return manifest.stateKey === binding.stableStateKey
      && candidate.lock.canonical.targetFingerprint === binding.currentFingerprint;
  }
  return candidate.lock.canonical.targetFingerprint === fingerprint
    && manifest.stateKey === stateKeyFor(binding.adapter, {
      installationType: binding.installationType, stateKey: binding.explicitStateKey,
      targetFingerprint: fingerprint, fleetId: binding.fleetId,
    });
}

async function verifyCurrentOperation(op: InstallOperation, liveHash: string | null, transport: TargetTransport): Promise<"exact-match" | "mismatch" | "unverifiable"> {
  if (liveHash === null || !op.desiredHash) return "mismatch";
  if (op.semanticPlugin || op.programmaticOperation) return "unverifiable";
  if (op.mode === "managed-block") {
    const selector = managedInstructionSelector(op.logicalSelector, op.artifactType, op.artifactName);
    const state = await readManagedInstructionBlockState(op.destPath, selector, transport);
    return state.hasBlock && !state.drifted && state.hash === op.desiredHash ? "exact-match" : "mismatch";
  }
  if (op.mergeStrategy) {
    if (!op.sourcePath) return "unverifiable";
    try {
      await assertMergedSourceContribution(op.sourcePath, op.mergeStrategy, await transport.readFile(op.destPath));
      return "exact-match";
    } catch {
      return "mismatch";
    }
  }
  return liveHash === op.desiredHash ? "exact-match" : "mismatch";
}

async function verifyHistoricalEntry(
  entry: InstallManifestEntry | InstallManifestV1Entry,
  livePath: string,
  liveHash: string | null,
  transport: TargetTransport,
): Promise<boolean> {
  if (liveHash === null || entry.semanticPlugin) return false;
  if (entry.mode === "managed-block") {
    const selector = managedInstructionSelector("logicalSelector" in entry ? entry.logicalSelector : undefined,
      entry.artifactType, entry.artifactName);
    const state = await readManagedInstructionBlockState(livePath, selector, transport);
    return state.hasBlock && !state.drifted && state.hash === entry.hash;
  }
  if (entry.mergeStrategy) {
    if (!hasMergeRemovalContent(entry.mergeRemoval)) return false;
    try {
      assertExactMergeContribution(entry.mergeRemoval!, entry.mergeStrategy, await transport.readFile(livePath));
      return true;
    } catch {
      return false;
    }
  }
  return entry.hash === liveHash;
}

function assertCompleteGraphPlan(plan: GraphSourcePlanResult): void {
  const sourceNodes = plan.graph.nodes.filter((node) => node.selected.length > 0);
  const lockedNodes = new Map(plan.bundle.graphLock.canonical.nodes.map((node) => [node.id, node]));
  for (const node of sourceNodes) {
    const locked = lockedNodes.get(node.id);
    if (!locked || locked.sourceHash !== node.sourceHash || node.selected.some((selector) => !locked.selected.includes(selector))) {
      throw new Error(`Current source graph omitted selected node or dependency: ${node.id}`);
    }
  }
  for (const edge of plan.graph.edges) {
    if (!plan.bundle.graphLock.canonical.edges.some((locked) =>
      locked.from === edge.from && locked.to === edge.to && locked.alias === edge.alias)) {
      throw new Error(`Current source graph omitted dependency edge: ${edge.from} -> ${edge.to}`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
