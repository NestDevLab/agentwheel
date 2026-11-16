import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { listInstallManifests, readInstallManifest, withManifestRevision } from "../install/manifest.js";
import { installManifestPath } from "../install/paths.js";
import { acquireApplyLock, assertNoSymlinkPath, assertOwnershipMetadataTransportSupported,
  listAllApplyJournals, observeOwnershipRuntime, type MetadataStateGuards } from "../install/transaction.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../model/manifest.js";
import { resolveWorkspaceOwnershipScope } from "../model/fleet.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { activeMutationMetadata } from "../mutation/coordinator.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import { assertNoOrphanDestinationGraphLock, commitOwnershipManifestMetadata, desiredCoverageIdentity, desiredCovers,
  type AdoptLegacyDesiredArtifact, type DesiredCoverageIdentity } from "./ownership-adopt-legacy.js";
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
  /** What a plain install of the configured packages would install now. */
  desiredCoverage: AdoptLegacyDesiredArtifact[];
  destinationGraphLockPath: string;
  /** Migrate entries the configured packages no longer install; the next install then removes them. */
  allowUndesired?: boolean;
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
  selected: Array<{ path: string; sourceEntryDigest: string; action: "migrate" | "retire-covered"; desired: boolean }>;
  alreadyMigrated: Array<{ path: string; destinationEntryDigest: string }>;
  retained: Array<{ path: string; owner: string }>;
  allowUndesired: boolean;
  desiredCoverage: DesiredCoverageIdentity[];
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
  await assertNoOrphanDestinationGraphLock(Boolean(destination), request.destinationGraphLockPath, "migrating legacy state");
  if (source?.adapterCode || destination?.adapterCode) throw new Error("Programmatic adapter state cannot be migrated.");
  const inventory = await listInstallManifests(targetRoot, undefined, transport);
  if (transport.kind === "local") {
    await assertNoSymlinkPath(targetRoot);
    for (const item of inventory) await assertNoSymlinkPath(item.path);
  }
  const requested = request.paths ? [...new Set(request.paths)].sort() : undefined;
  for (const path of requested ?? []) containedArtifactPath(targetRoot, path);
  const entries = source?.entries.filter(entry => entry.workspaceOwner === owner && (!requested || requested.includes(entry.path))) ?? [];
  // A path already moved by an earlier apply has left the source and sits, owned and unchanged, in the destination.
  const alreadyMigrated: MigrateLegacyOwnershipPlan["alreadyMigrated"] = [];
  for (const path of requested ?? []) {
    if (entries.some(entry => entry.path === path)) continue;
    const atPath = destination?.entries.filter(entry => entry.path === path) ?? [];
    if (!source?.entries.some(entry => entry.path === path) && atPath.length === 1 && atPath[0]!.workspaceOwner === owner) {
      await verifyManifestEntryRuntime(targetRoot, atPath[0]!, transport);
      alreadyMigrated.push({ path, destinationEntryDigest: entryDigest(atPath[0]!) });
    } else {
      throw new Error("Every selected path must exist in the source and be owned by the current workspace.");
    }
  }
  const desiredByPath = new Map<string, AdoptLegacyDesiredArtifact[]>();
  for (const item of request.desiredCoverage) desiredByPath.set(item.path, [...desiredByPath.get(item.path) ?? [], item]);
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
    const desiredAtPath = desiredByPath.get(entry.path) ?? [];
    // Retiring an exact duplicate leaves the destination, and so the next install, unchanged.
    if (!covered && desiredAtPath.length && !desiredAtPath.some(item => desiredCovers(item, entry))) {
      throw new Error(`The current graph plans a different artifact at ${entry.path}; legacy state cannot be migrated there.`);
    }
    if (!covered && !desiredAtPath.length && !request.allowUndesired) {
      throw new Error(`The configured packages no longer install ${entry.path}, so the next install would remove it after migration; `
        + "select only desired paths with --path, or pass --allow-undesired to migrate it anyway.");
    }
    selected.push({ path: entry.path, sourceEntryDigest: entryDigest(entry), action: covered ? "retire-covered" : "migrate", desired: desiredAtPath.length > 0 });
    runtime.push({ path: entry.path, hash: await transport.hashPath(path), snapshotDigest: observation.snapshotDigest });
  }
  const selectedDigests = new Set(selected.map(entry => entry.sourceEntryDigest));
  const withoutDigest = {
    adapter: request.adapter, installationType, targetRoot, owner,
    source: { stateKey: sourceKey, manifestPath: installManifestPath(targetRoot, request.adapter, { stateKey: sourceKey }), revision: source?.revision ?? null },
    destination: { stateKey: destinationKey, manifestPath: installManifestPath(targetRoot, request.adapter, { stateKey: destinationKey }), revision: destination?.revision ?? null },
    selected: selected.sort((a, b) => a.path.localeCompare(b.path)),
    alreadyMigrated,
    retained: (source?.entries ?? []).filter(entry => !selectedDigests.has(entryDigest(entry)))
      .map(entry => ({ path: entry.path, owner: entry.workspaceOwner })).sort((a, b) => a.path.localeCompare(b.path)),
    allowUndesired: request.allowUndesired === true,
    desiredCoverage: desiredCoverageIdentity(request.desiredCoverage, new Set(selected.map(entry => entry.path))),
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
  const mutation = activeMutationMetadata();
  if (!mutation || resolve(mutation.workspaceRoot) !== resolve(request.workspaceRoot)) {
    throw new Error("Legacy state migration requires a caller-owned durable mutation receipt for this workspace; configure mutationPolicy.journal as required before applying.");
  }
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
    const destination = await readInstallManifest(plan.targetRoot, plan.adapter, transport, { installationType: plan.installationType, stateKey: plan.destination.stateKey })
      ? await requireManifest(identity, plan.destination.stateKey, transport, "destination") : undefined;
    // The entries committed below come from this read, not from the plan.
    assertExpected(plan.source.revision ?? "absent", source.revision, "source revision");
    assertExpected(plan.destination.revision ?? "absent", destination?.revision ?? "absent", "destination revision");
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
