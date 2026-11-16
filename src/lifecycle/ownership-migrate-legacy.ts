import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { listInstallManifests, readInstallManifest, withManifestRevision } from "../install/manifest.js";
import { installManifestPath } from "../install/paths.js";
import { acquireApplyLock, assertNoSymlinkPath, assertOwnershipMetadataTransportSupported,
  listAllApplyJournals, observeOwnershipRuntime, type MetadataStateGuards } from "../install/transaction.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../model/manifest.js";
import { resolveWorkspaceOwnershipScope } from "../model/fleet.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import { commitOwnershipManifestMetadata } from "./ownership-adopt-legacy.js";
import { containedArtifactPath, verifyManifestEntryRuntime } from "./ownership.js";
import { assertExpected, canonicalJson, entryDigest, exactStateKey, ownershipRunAsEndpoint, requireManifest } from "./ownership-retire-stale.js";

export interface MigrateLegacyOwnershipRequest {
  targetRoot: string;
  adapter: string;
  installationType: string;
  sourceStateKey: string;
  destinationStateKey: string;
  workspaceRoot: string;
  globalRoot?: string;
  paths?: string[];
  transport?: TargetTransport;
  planDigest?: string;
  expectedSourceRevision?: string;
  expectedDestinationRevision?: string;
  expectedInventoryRevision?: string;
}

export interface MigrateLegacyOwnershipPlan {
  adapter: string;
  installationType: string;
  targetRoot: string;
  owner: string;
  source: { stateKey: string; manifestPath: string; revision: string | null };
  destination: { stateKey: string; manifestPath: string; revision: string | null };
  selected: Array<{ path: string; sourceEntryDigest: string; action: "migrate" | "retire-covered" }>;
  retained: Array<{ path: string; owner: string }>;
  manifestInventoryRevision: string;
  metadataGuards: MetadataStateGuards;
  transport?: ReturnType<typeof ownershipRunAsEndpoint>;
  planDigest: string;
}

/** An explicit old state key plus exact current ownership replaces graph-lock provenance.
 * The destination key is resolved by the CLI using the same identity as install. */
export async function planMigrateLegacyOwnership(request: MigrateLegacyOwnershipRequest): Promise<MigrateLegacyOwnershipPlan> {
  const transport = request.transport ?? localTransport;
  if (transport.kind === "ssh") throw new Error("Legacy state migration does not support SSH targets.");
  const targetRoot = resolve(request.targetRoot);
  const installationType = request.installationType;
  const sourceKey = exactStateKey(request.adapter, request.sourceStateKey, installationType, "source");
  const destinationKey = exactStateKey(request.adapter, request.destinationStateKey, installationType, "destination");
  if (sourceKey === destinationKey) throw new Error("Source and destination state keys must differ.");
  const scope = await resolveWorkspaceOwnershipScope(request.workspaceRoot, { globalRoot: request.globalRoot });
  const owner = workspaceOwnerForRoot(scope.root, scope.fleetId);
  const endpoint = ownershipRunAsEndpoint(transport, targetRoot);
  if ((await listAllApplyJournals(targetRoot, undefined, transport)).length) throw new Error("Pending runtime apply journals must be recovered before migration.");
  const identity = { targetRoot, adapter: request.adapter, installationType };
  const load = async (key: string) => await readInstallManifest(targetRoot, request.adapter, transport, { installationType, stateKey: key })
    ? requireManifest(identity, key, transport, "migration") : undefined;
  const source = await load(sourceKey), destination = await load(destinationKey);
  if (source?.adapterCode || destination?.adapterCode) throw new Error("Programmatic adapter state cannot be migrated.");
  const inventory = await listInstallManifests(targetRoot, undefined, transport);
  if (transport.kind === "local") {
    await assertNoSymlinkPath(targetRoot);
    for (const item of inventory) await assertNoSymlinkPath(item.path);
  }
  const requested = request.paths ? [...new Set(request.paths)].sort() : undefined;
  for (const path of requested ?? []) containedArtifactPath(targetRoot, path);
  const entries = source?.entries.filter(entry => entry.workspaceOwner === owner && (!requested || requested.includes(entry.path))) ?? [];
  // An absent source is an idempotent no-op. An existing source must prove every explicit selection.
  if (source && requested?.some(path => !entries.some(entry => entry.path === path))) {
    throw new Error("Every selected path must exist in the source and be owned by the current workspace.");
  }
  const selected: MigrateLegacyOwnershipPlan["selected"] = [];
  const runtime: MetadataStateGuards["runtime"] = [];
  for (const entry of entries) {
    if (entry.semanticPlugin || entry.semanticCommand || entry.executed) throw new Error(`Unsupported semantic claim at ${entry.path}.`);
    const path = containedArtifactPath(targetRoot, entry.path);
    if (path === targetRoot || path.startsWith(`${targetRoot}/.agentwheel/`) || path === `${targetRoot}/.agentwheel`) {
      throw new Error(`Runtime claim overlaps metadata at ${entry.path}.`);
    }
    const observation = await observeOwnershipRuntime(path, transport);
    if (observation.kind !== entry.kind) throw new Error(`Runtime kind differs at ${entry.path}.`);
    await verifyManifestEntryRuntime(targetRoot, entry, transport);
    let covered = false;
    for (const item of inventory) for (const other of item.manifest.entries) {
      const otherPath = containedArtifactPath(targetRoot, other.path);
      if (!(otherPath === path || otherPath.startsWith(`${path}/`) || path.startsWith(`${otherPath}/`))) continue;
      // Inventory objects are parsed separately: compare digests, and reject duplicate source entries below.
      if (item.stateKey === sourceKey && entryDigest(other as InstallManifestEntry) === entryDigest(entry)
        && source!.entries.filter(candidate => candidate.path === entry.path).length === 1) continue;
      if (item.stateKey === destinationKey && item.manifest.version === 2
        && entryDigest(other as InstallManifestEntry) === entryDigest(entry) && !covered) { covered = true; continue; }
      throw new Error(`Conflicting or overlapping ownership claim at ${entry.path} in ${item.stateKey}.`);
    }
    selected.push({ path: entry.path, sourceEntryDigest: entryDigest(entry), action: covered ? "retire-covered" : "migrate" });
    runtime.push({ path: entry.path, hash: await transport.hashPath(path), snapshotDigest: observation.snapshotDigest });
  }
  const selectedDigests = new Set(selected.map(entry => entry.sourceEntryDigest));
  const withoutDigest = {
    adapter: request.adapter, installationType, targetRoot, owner,
    source: { stateKey: sourceKey, manifestPath: installManifestPath(targetRoot, request.adapter, { stateKey: sourceKey }), revision: source?.revision ?? null },
    destination: { stateKey: destinationKey, manifestPath: installManifestPath(targetRoot, request.adapter, { stateKey: destinationKey }), revision: destination?.revision ?? null },
    selected: selected.sort((a, b) => a.path.localeCompare(b.path)),
    retained: (source?.entries ?? []).filter(entry => !selectedDigests.has(entryDigest(entry)))
      .map(entry => ({ path: entry.path, owner: entry.workspaceOwner })).sort((a, b) => a.path.localeCompare(b.path)),
    manifestInventoryRevision: createHash("sha256").update(JSON.stringify(inventory.map(item => [item.fileName, item.manifest.revision]))).digest("hex"),
    metadataGuards: { inventory: inventory.map(item => ({ stateKey: item.stateKey, revision: item.manifest.revision })), runtime: runtime.sort((a, b) => a.path.localeCompare(b.path)) },
    ...(endpoint ? { transport: endpoint } : {}),
  };
  return { ...withoutDigest, planDigest: createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex") };
}

export async function applyMigrateLegacyOwnership(request: MigrateLegacyOwnershipRequest) {
  for (const [label, value] of [["plan digest", request.planDigest], ["source revision", request.expectedSourceRevision],
    ["destination revision", request.expectedDestinationRevision], ["inventory revision", request.expectedInventoryRevision]] as const) {
    if (!value || (!/^[a-f0-9]{64}$/.test(value) && !(label.endsWith("revision") && !label.startsWith("inventory") && value === "absent"))) {
      throw new Error(`Applying legacy state migration requires reviewed ${label}.`);
    }
  }
  const transport = request.transport ?? localTransport;
  assertOwnershipMetadataTransportSupported(transport);
  const lock = await acquireApplyLock(request.targetRoot, request.adapter, transport, {}, { installationType: request.installationType, stateKey: request.destinationStateKey });
  try {
    const plan = await planMigrateLegacyOwnership(request);
    assertExpected(request.planDigest!, plan.planDigest, "plan digest");
    assertExpected(request.expectedSourceRevision!, plan.source.revision ?? "absent", "source revision");
    assertExpected(request.expectedDestinationRevision!, plan.destination.revision ?? "absent", "destination revision");
    assertExpected(request.expectedInventoryRevision!, plan.manifestInventoryRevision, "inventory revision");
    if (!plan.selected.length) return { ...plan, applied: true, migratedEntries: 0, retiredCoveredEntries: 0 };
    const identity = { targetRoot: plan.targetRoot, adapter: plan.adapter, installationType: plan.installationType };
    const source = await requireManifest(identity, plan.source.stateKey, transport, "source");
    const destination = plan.destination.revision ? await requireManifest(identity, plan.destination.stateKey, transport, "destination") : undefined;
    const selected = new Map(plan.selected.map(entry => [entry.sourceEntryDigest, entry.action]));
    const adopted = source.entries.filter(entry => selected.get(entryDigest(entry)) === "migrate");
    const now = new Date().toISOString();
    let guards = plan.metadataGuards;
    // Destination first. An interrupted transfer leaves exact duplicates, never unowned runtime.
    if (adopted.length) {
      const next: InstallManifestV2 = withManifestRevision({ ...(destination ?? { version: 2, adapter: plan.adapter,
        installationType: plan.installationType, targetRoot: plan.targetRoot, stateKey: plan.destination.stateKey, legacy: false,
        revision: "pending-migration", entries: [], generatedAt: now }), generatedAt: now,
        entries: [...destination?.entries ?? [], ...adopted].sort((a, b) => a.path.localeCompare(b.path)) });
      declareMutationPath(plan.destination.manifestPath);
      await commitOwnershipManifestMetadata(next, plan.destination.revision, now, transport, guards);
      guards = { ...guards, inventory: [...guards.inventory.filter(item => item.stateKey !== plan.destination.stateKey),
        { stateKey: plan.destination.stateKey, revision: next.revision }].sort((a, b) => a.stateKey.localeCompare(b.stateKey)) };
    }
    declareMutationPath(plan.source.manifestPath);
    await commitOwnershipManifestMetadata({ ...source, entries: source.entries.filter(entry => !selected.has(entryDigest(entry))) }, source.revision, now, transport, guards);
    return { ...plan, applied: true, migratedEntries: adopted.length, retiredCoveredEntries: plan.selected.length - adopted.length };
  } finally { await lock.release(); }
}
