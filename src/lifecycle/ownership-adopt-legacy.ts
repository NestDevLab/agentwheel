import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { commitManifestMetadataJournal } from "../install/apply.js";
import {
  computeInstallManifestInventoryRevision,
  listInstallManifests,
  readInstallManifest,
  type DiscoveredInstallManifest,
} from "../install/manifest.js";
import { installManifestPath } from "../install/paths.js";
import type { InstallPlan } from "../install/plan.js";
import {
  acquireApplyLock,
  listAllApplyJournals,
  mutationMetadataForApplyJournal,
  writeApplyJournal,
  type ApplyJournal,
} from "../install/transaction.js";
import { listRegisteredFleets, resolveWorkspaceOwnershipScope } from "../model/fleet.js";
import { legacyUnownedWorkspaceOwner, type InstallManifestEntry, type InstallManifestV2 } from "../model/manifest.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import { pathExists } from "../utils/fs.js";
import { findLegacyNamedLocks, lockCoversEntry, type HistoricalLock } from "./legacy-recovery-plan.js";
import { containedArtifactPath, verifyManifestEntryRuntime } from "./ownership.js";
import { assertExpected, canonicalJson, entryDigest, exactStateKey, requireManifest } from "./ownership-retire-stale.js";

export interface AdoptLegacyDesiredArtifact {
  path: string;
  artifactType: string;
  artifactName: string;
  kind: string;
  packageName?: string;
}

export interface AdoptLegacyOwnershipRequest {
  targetRoot: string;
  adapter: string;
  installationType: string;
  sourceStateKey: string;
  destinationStateKey: string;
  fromWorkspaceRoot: string;
  workspaceRoot: string;
  destinationFleetId?: string;
  destinationGraphLockPath: string;
  desiredCoverage: AdoptLegacyDesiredArtifact[];
  carryDrift?: boolean;
  globalRoot?: string;
  planDigest?: string;
  expectedSourceRevision?: string;
  expectedDestinationRevision?: string;
  expectedInventoryRevision?: string;
  transport?: TargetTransport;
}

export type AdoptLegacySourceClass = "foreign-root" | "own-legacy-owner";

export interface AdoptLegacyOwnershipEntry {
  path: string;
  action: "adopt" | "retire-covered";
  sourceEntryDigest: string;
  destinationEntryDigest?: string;
  recordedHash: string;
  runtimeHash: string | null;
  drift: boolean;
}

export interface AdoptLegacyOwnershipPlan {
  adapter: string;
  installationType: string;
  targetRoot: string;
  source: {
    stateKey: string;
    manifestPath: string;
    revision: string;
    owner: string;
    class: AdoptLegacySourceClass;
    provenanceLock: { path: string; digest: string };
  };
  destination: {
    stateKey: string;
    manifestPath: string;
    revision: string | null;
    owner: string;
    workspaceRoot: string;
  };
  manifestInventoryRevision: string;
  selected: AdoptLegacyOwnershipEntry[];
  retained: Array<{ path: string; owner: string; reason: "other-owner" | "not-desired" }>;
  remainingDuplicates: Array<{ stateKey: string; path: string }>;
  desiredCoverage: Array<Pick<AdoptLegacyDesiredArtifact, "path" | "artifactType" | "artifactName" | "kind">>;
  planDigest: string;
}

export interface AdoptLegacyOwnershipResult extends AdoptLegacyOwnershipPlan {
  applied: true;
  adoptedEntries: number;
  retiredCoveredEntries: number;
  sourceManifestRemoved: boolean;
  retainedSourceEntries: number;
}

const absentRevision = "absent";

export function desiredCoverageFromPlan(plan: Pick<InstallPlan, "operations">): AdoptLegacyDesiredArtifact[] {
  return plan.operations
    .filter((operation) => operation.desiredHash && operation.action !== "remove" && operation.action !== "keep")
    .map((operation) => ({
      path: operation.relativeDestPath,
      artifactType: operation.artifactType,
      artifactName: operation.artifactName,
      kind: operation.kind,
      ...(operation.packageName ? { packageName: operation.packageName } : {}),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function planAdoptLegacyOwnership(request: AdoptLegacyOwnershipRequest): Promise<AdoptLegacyOwnershipPlan> {
  return observe(request, request.transport ?? localTransport);
}

export async function applyAdoptLegacyOwnership(request: AdoptLegacyOwnershipRequest): Promise<AdoptLegacyOwnershipResult> {
  assertApplyPreconditions(request);
  const transport = request.transport ?? localTransport;
  const targetRoot = resolve(request.targetRoot);
  const installationType = request.installationType.trim();
  // apply lock is per root + adapter + installation type, so it covers both state keys
  const lock = await acquireApplyLock(targetRoot, request.adapter, transport, {}, {
    installationType,
    stateKey: request.destinationStateKey,
  });
  try {
    await assertNoPendingJournals(targetRoot, request.adapter, transport);
    const current = await observe(request, transport);
    assertExpected(request.planDigest!, current.planDigest, "plan digest");
    assertExpected(request.expectedSourceRevision!, current.source.revision, "source manifest revision");
    assertExpected(request.expectedDestinationRevision!, current.destination.revision ?? absentRevision, "destination manifest revision");
    assertExpected(request.expectedInventoryRevision!, current.manifestInventoryRevision, "manifest inventory revision");

    const identity = { targetRoot, adapter: request.adapter, installationType };
    const source = await requireManifest(identity, current.source.stateKey, transport, "source");
    const destination = await readDestination(identity, current.destination.stateKey, transport);
    const selectedByDigest = new Map(current.selected.map((entry) => [entry.sourceEntryDigest, entry]));
    const adopted: InstallManifestEntry[] = [];
    const retained: InstallManifestEntry[] = [];
    for (const entry of source.entries) {
      const selected = selectedByDigest.get(entryDigest(entry));
      if (!selected) retained.push(entry);
      else if (selected.action === "adopt") adopted.push({ ...entry, workspaceOwner: current.destination.owner });
    }
    if (source.entries.length - retained.length !== current.selected.length) {
      throw new Error("Source manifest selection changed while locked; replan required.");
    }

    const now = new Date().toISOString();
    // destination first, a crash between the commits only leaves duplicate claims that a rerun retires
    if (adopted.length > 0) {
      declareMutationPath(current.destination.manifestPath);
      const base: InstallManifestV2 = destination ?? {
        version: 2,
        adapter: request.adapter,
        installationType,
        stateKey: current.destination.stateKey,
        targetRoot,
        generatedAt: now,
        revision: "pending-apply-0000",
        legacy: false,
        entries: [],
      };
      await commitMetadata({
        ...base,
        entries: [...base.entries, ...adopted].sort((left, right) => left.path.localeCompare(right.path)),
      }, destination?.revision ?? null, now, transport);
    }
    declareMutationPath(current.source.manifestPath);
    await commitMetadata({ ...source, entries: retained }, source.revision, now, transport);
    return {
      ...current,
      applied: true,
      adoptedEntries: adopted.length,
      retiredCoveredEntries: current.selected.length - adopted.length,
      sourceManifestRemoved: retained.length === 0,
      retainedSourceEntries: retained.length,
    };
  } finally {
    await lock.release();
  }
}

async function commitMetadata(
  manifest: InstallManifestV2,
  baseRevision: string | null,
  now: string,
  transport: TargetTransport,
): Promise<void> {
  const mutation = mutationMetadataForApplyJournal();
  const journal: ApplyJournal = {
    version: mutation ? 2 : 1,
    ...(mutation ? { mutation } : {}),
    mode: "uninstall",
    adapter: manifest.adapter,
    installationType: manifest.installationType,
    stateKey: manifest.stateKey,
    targetRoot: manifest.targetRoot,
    baseRevision,
    createdAt: now,
    updatedAt: now,
    operations: [],
    completed: [],
    manifest,
  };
  await writeApplyJournal(journal, transport);
  await commitManifestMetadataJournal(journal, transport);
}

interface NormalizedRequest {
  targetRoot: string;
  adapter: string;
  installationType: string;
  sourceStateKey: string;
  destinationStateKey: string;
  fingerprint: string;
  sourceRoot: string;
  sourceOwner: string;
  workspaceRoot: string;
  destinationOwner: string;
  sourceClass: AdoptLegacySourceClass;
}

async function observe(request: AdoptLegacyOwnershipRequest, transport: TargetTransport): Promise<AdoptLegacyOwnershipPlan> {
  if (transport.kind === "ssh") {
    throw new Error("Legacy ownership adoption does not support SSH targets; legacy SSH state does not prove its endpoint.");
  }
  const input = await normalizeRequest(request);
  const { targetRoot, adapter, installationType } = input;
  await assertNoPendingJournals(targetRoot, adapter, transport);

  const identity = { targetRoot, adapter, installationType };
  if (!(await readInstallManifest(targetRoot, adapter, transport, { installationType, stateKey: input.sourceStateKey }))) {
    throw new Error(`Nothing to adopt: no source install manifest for state key ${input.sourceStateKey}.`);
  }
  const source = await requireManifest(identity, input.sourceStateKey, transport, "source");
  const destination = await readDestination(identity, input.destinationStateKey, transport);
  if (!destination && await pathExists(request.destinationGraphLockPath)) {
    throw new Error(
      `Destination has a stable graph lock without a stable manifest at ${request.destinationGraphLockPath}; reconcile it before adopting legacy ownership.`,
    );
  }
  const desiredByPath = new Map<string, AdoptLegacyDesiredArtifact[]>();
  for (const item of request.desiredCoverage) desiredByPath.set(item.path, [...desiredByPath.get(item.path) ?? [], item]);
  const { entries: selectedEntries, retained, provenance } = await selectLegacySource(
    input,
    input.sourceStateKey,
    input.fingerprint,
    source,
    desiredByPath,
  );
  const selectedPaths = new Set(selectedEntries.map((entry) => entry.path));
  const selected: AdoptLegacyOwnershipEntry[] = [];
  for (const entry of selectedEntries) {
    const runtimePath = containedArtifactPath(targetRoot, entry.path);
    const runtimeHash = await transport.pathExists(runtimePath) ? await transport.hashPath(runtimePath) : null;
    const drift = runtimeHash !== entry.hash;
    if (drift && request.carryDrift !== true) {
      throw new Error(
        runtimeHash === null
          ? `Managed artifact is missing at ${entry.path}; pass --carry-drift to keep the recorded hash.`
          : `Managed artifact is drifted at ${entry.path}: manifest ${entry.hash}, current ${runtimeHash}; pass --carry-drift to keep the recorded hash.`,
      );
    }
    const atPath = destination?.entries.filter((candidate) => candidate.path === entry.path) ?? [];
    let destinationEntryDigest: string | undefined;
    if (atPath.length > 0) {
      const covering = atPath.length === 1 ? atPath[0]! : undefined;
      if (!covering || !coversSourceEntry(covering, entry, input.destinationOwner)) {
        throw new Error(`Destination state at ${entry.path} is not an exact copy of the source claim owned by this workspace.`);
      }
      if (!drift) await verifyManifestEntryRuntime(targetRoot, covering, transport);
      destinationEntryDigest = entryDigest(covering);
    }
    selected.push({
      path: entry.path,
      action: destinationEntryDigest ? "retire-covered" : "adopt",
      sourceEntryDigest: entryDigest(entry),
      ...(destinationEntryDigest ? { destinationEntryDigest } : {}),
      recordedHash: entry.hash,
      runtimeHash,
      drift,
    });
  }

  const remainingDuplicates: AdoptLegacyOwnershipPlan["remainingDuplicates"] = [];
  const selectedByPath = new Map(selectedEntries.map((entry) => [entry.path, entry]));
  for (const item of await listInstallManifests(targetRoot, adapter, transport)) {
    if (item.stateKey === input.destinationStateKey) continue;
    const duplicatePaths: string[] = [];
    for (const entry of item.manifest.entries) {
      if (!selectedPaths.has(entry.path)) continue;
      const owner = "workspaceOwner" in entry ? entry.workspaceOwner : legacyUnownedWorkspaceOwner;
      if (owner !== input.sourceOwner) {
        throw new Error(`${entry.path} is also claimed by ${owner} in ${item.fileName}; legacy ownership cannot be adopted.`);
      }
      if (item.stateKey !== input.sourceStateKey) duplicatePaths.push(entry.path);
    }
    if (duplicatePaths.length === 0) continue;
    await assertRetirableDuplicate(input, item, duplicatePaths, selectedByPath, desiredByPath, transport);
    for (const path of duplicatePaths) remainingDuplicates.push({ stateKey: item.stateKey, path });
  }

  const withoutDigest = {
    adapter,
    installationType,
    targetRoot,
    source: {
      stateKey: input.sourceStateKey,
      manifestPath: installManifestPath(targetRoot, adapter, { installationType, stateKey: input.sourceStateKey }),
      revision: source.revision,
      owner: input.sourceOwner,
      class: input.sourceClass,
      provenanceLock: { path: provenance.path, digest: provenance.digest },
    },
    destination: {
      stateKey: input.destinationStateKey,
      manifestPath: installManifestPath(targetRoot, adapter, { installationType, stateKey: input.destinationStateKey }),
      revision: destination?.revision ?? null,
      owner: input.destinationOwner,
      workspaceRoot: input.workspaceRoot,
    },
    manifestInventoryRevision: await computeInstallManifestInventoryRevision(targetRoot, adapter, transport),
    selected: selected.sort((left, right) => left.path.localeCompare(right.path)),
    retained: retained.sort((left, right) => left.path.localeCompare(right.path) || left.owner.localeCompare(right.owner)),
    remainingDuplicates: remainingDuplicates.sort((left, right) =>
      left.stateKey.localeCompare(right.stateKey) || left.path.localeCompare(right.path)),
    // identity only, so a newer package revision doesn't invalidate a reviewed plan
    desiredCoverage: request.desiredCoverage
      .filter((item) => selectedPaths.has(item.path))
      .map(({ path, artifactType, artifactName, kind }) => ({ path, artifactType, artifactName, kind }))
      .sort((left, right) => left.path.localeCompare(right.path)
        || left.artifactType.localeCompare(right.artifactType)
        || left.artifactName.localeCompare(right.artifactName)),
  };
  return { ...withoutDigest, planDigest: createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex") };
}

async function normalizeRequest(request: AdoptLegacyOwnershipRequest): Promise<NormalizedRequest> {
  if (request.destinationFleetId !== undefined) {
    throw new Error("Legacy ownership adoption targets a nested workspace; a Fleet target uses fleet normalize or ownership retire-stale.");
  }
  const targetRoot = resolve(request.targetRoot);
  const installationType = request.installationType.trim();
  const sourceStateKey = exactStateKey(request.adapter, request.sourceStateKey, installationType, "source");
  const destinationStateKey = exactStateKey(request.adapter, request.destinationStateKey, installationType, "destination");
  const fingerprint = legacyFingerprint(request.adapter, installationType, sourceStateKey);
  if (!fingerprint) {
    throw new Error(`The source must be a legacy state key of the form ${request.adapter}.${installationType}.<64-hex target fingerprint>.`);
  }
  if (sourceStateKey === destinationStateKey) throw new Error("Source and destination state keys must differ.");

  const scope = await resolveWorkspaceOwnershipScope(request.workspaceRoot, { globalRoot: request.globalRoot });
  const destinationOwner = workspaceOwnerForRoot(scope.root, scope.fleetId);
  const workspaceRoot = await realpath(request.workspaceRoot);
  const sourceRoot = resolve(request.fromWorkspaceRoot);
  const sourceOwner = workspaceOwnerForRoot(sourceRoot);
  let sourceClass: AdoptLegacySourceClass;
  if (sourceRoot === workspaceRoot || sourceRoot === resolve(request.workspaceRoot)) {
    if (sourceOwner === destinationOwner) {
      throw new Error(`${sourceOwner} is already the destination owner; ordinary install migration handles its legacy state.`);
    }
    sourceClass = "own-legacy-owner";
  } else {
    const sourceForms = [sourceRoot, ...await realpath(sourceRoot).then((path) => [path], () => [])];
    const workspaceForms = [workspaceRoot, resolve(request.workspaceRoot), scope.root];
    if (sourceForms.some((source) => workspaceForms.some((workspace) =>
      containsPath(source, workspace) || containsPath(workspace, source)))) {
      throw new Error(`Source root ${sourceRoot} contains or is contained by the destination workspace; it cannot be adopted as a foreign root.`);
    }
    for (const fleet of await listRegisteredFleets({ globalRoot: request.globalRoot })) {
      const fleetForms = [resolve(fleet.root), ...await realpath(fleet.root).then((path) => [path], () => [])];
      if (sourceForms.some((source) => fleetForms.some((root) => containsPath(root, source)))) {
        throw new Error(`Source root ${sourceRoot} is inside registered Fleet '${fleet.id}'; use fleet normalize or ownership retire-stale.`);
      }
    }
    sourceClass = "foreign-root";
  }
  return {
    targetRoot,
    adapter: request.adapter,
    installationType,
    sourceStateKey,
    destinationStateKey,
    fingerprint,
    sourceRoot,
    sourceOwner,
    workspaceRoot,
    destinationOwner,
    sourceClass,
  };
}

// A stable key is also <adapter>.<type>.<64 hex>, so the key shape alone never proves a legacy key;
// the proof is a lock in the owner root named by that fingerprint and recording it.
function legacyFingerprint(adapter: string, installationType: string, stateKey: string): string | undefined {
  const prefix = `${adapter}.${installationType}.`;
  const fingerprint = stateKey.startsWith(prefix) ? stateKey.slice(prefix.length) : "";
  return /^[a-f0-9]{64}$/u.test(fingerprint) ? fingerprint : undefined;
}

async function selectLegacySource(
  input: NormalizedRequest,
  stateKey: string,
  fingerprint: string,
  source: InstallManifestV2,
  desiredByPath: Map<string, AdoptLegacyDesiredArtifact[]>,
): Promise<{ entries: InstallManifestEntry[]; retained: AdoptLegacyOwnershipPlan["retained"]; provenance: HistoricalLock }> {
  if (source.adapterCode) {
    throw new Error(`The install manifest for ${stateKey} records programmatic adapter code; legacy ownership adoption refuses it.`);
  }
  if (source.entries.some((entry) => entry.workspaceOwner === input.destinationOwner)) {
    throw new Error(
      `Source state ${stateKey} has entries already owned by the destination owner; run a normal install to migrate them first.`,
    );
  }
  for (const entry of source.entries) {
    if (entry.workspaceOwner === input.sourceOwner) assertPlainEntry(entry, input.targetRoot);
  }

  const entries: InstallManifestEntry[] = [];
  const retained: AdoptLegacyOwnershipPlan["retained"] = [];
  for (const entry of source.entries) {
    if (entry.workspaceOwner !== input.sourceOwner) {
      retained.push({ path: entry.path, owner: entry.workspaceOwner, reason: "other-owner" });
      continue;
    }
    const desired = desiredByPath.get(entry.path) ?? [];
    if (desired.length === 0) {
      retained.push({ path: entry.path, owner: entry.workspaceOwner, reason: "not-desired" });
      continue;
    }
    if (!desired.some((item) => desiredCovers(item, entry))) {
      throw new Error(`The current graph plans a different artifact at ${entry.path}; legacy ownership cannot be adopted there.`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error(`Nothing to adopt: no entry owned by ${input.sourceOwner} in ${stateKey} is desired by this workspace.`);
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`Source state ${stateKey} has more than one entry at ${entry.path}.`);
    paths.add(entry.path);
  }
  return { entries, retained, provenance: await resolveProvenance(input, fingerprint, entries) };
}

// A same-owner claim left in another manifest is only safe to leave behind if a follow-up run on
// that key would retire it against the entry adopted now; otherwise the path ends with two owners.
async function assertRetirableDuplicate(
  input: NormalizedRequest,
  item: DiscoveredInstallManifest,
  paths: string[],
  selectedByPath: Map<string, InstallManifestEntry>,
  desiredByPath: Map<string, AdoptLegacyDesiredArtifact[]>,
  transport: TargetTransport,
): Promise<void> {
  const refuse = (path: string, reason: string) => new Error(
    `${path} is also claimed by ${input.sourceOwner} in ${item.fileName}, which a follow-up adopt-legacy run could not retire: ${reason}`,
  );
  const fingerprint = legacyFingerprint(input.adapter, input.installationType, item.stateKey);
  if (!fingerprint) throw refuse(paths[0]!, `${item.stateKey} is not a legacy fingerprint state key for ${input.adapter}/${input.installationType}.`);
  let duplicates: InstallManifestEntry[];
  try {
    const identity = { targetRoot: input.targetRoot, adapter: input.adapter, installationType: input.installationType };
    const manifest = await requireManifest(identity, item.stateKey, transport, "duplicate source");
    duplicates = (await selectLegacySource(input, item.stateKey, fingerprint, manifest, desiredByPath)).entries;
  } catch (error) {
    throw refuse(paths[0]!, error instanceof Error ? error.message : String(error));
  }
  for (const path of paths) {
    const duplicate = duplicates.find((entry) => entry.path === path);
    if (!duplicate || !sameRecordedArtifact(duplicate, selectedByPath.get(path)!)) {
      throw refuse(path, "its artifact identity or recorded hashes differ from the adopted entry.");
    }
  }
}

async function resolveProvenance(input: NormalizedRequest, fingerprint: string, entries: InstallManifestEntry[]): Promise<HistoricalLock> {
  const locks = await findLegacyNamedLocks(input.sourceRoot, input.adapter, fingerprint);
  if (locks.length === 0) {
    throw new Error(
      `Source root ${input.sourceRoot} has no legacy-named graph lock for ${input.adapter}/${fingerprint}; provenance cannot be proven.`,
    );
  }
  // own locks get rewritten by later installs, so no digest match here, the owner root is the proof
  if (input.sourceClass === "own-legacy-owner") return locks[0]!;
  if (locks.length !== 1) {
    throw new Error(`Source root ${input.sourceRoot} must have exactly one legacy-named graph lock for ${fingerprint}, found ${locks.length}.`);
  }
  const lock = locks[0]!;
  for (const entry of entries) {
    if (entry.graphLockDigest !== lock.digest) {
      throw new Error(`Recorded graph-lock digest for ${entry.path} does not match ${lock.path}.`);
    }
    if (!lockCoversEntry(lock.lock, entry)) {
      throw new Error(`Legacy graph lock ${lock.path} does not cover ${entry.path} with its recorded node, selector, and source hash.`);
    }
  }
  return lock;
}

async function readDestination(
  identity: { targetRoot: string; adapter: string; installationType: string },
  stateKey: string,
  transport: TargetTransport,
): Promise<InstallManifestV2 | undefined> {
  if (!(await readInstallManifest(identity.targetRoot, identity.adapter, transport, { installationType: identity.installationType, stateKey }))) {
    return undefined;
  }
  return requireManifest(identity, stateKey, transport, "destination");
}

function assertPlainEntry(entry: InstallManifestEntry, targetRoot: string): void {
  if (entry.mode || entry.mergeStrategy || entry.semanticPlugin || entry.semanticCommand || entry.executed) {
    throw new Error(`Legacy ownership adoption supports only plain file or directory entries; ${entry.path} is not one.`);
  }
  containedArtifactPath(targetRoot, entry.path);
}

function desiredCovers(item: AdoptLegacyDesiredArtifact, entry: InstallManifestEntry): boolean {
  return item.artifactType === entry.artifactType
    && item.artifactName === entry.artifactName
    && item.kind === entry.kind
    && (!item.packageName || !entry.packageName || item.packageName === entry.packageName);
}

function coversSourceEntry(destination: InstallManifestEntry, source: InstallManifestEntry, owner: string): boolean {
  return destination.workspaceOwner === owner
    && !destination.mode && !destination.mergeStrategy && !destination.semanticPlugin
    && sameRecordedArtifact(destination, source);
}

function sameRecordedArtifact(left: InstallManifestEntry, right: InstallManifestEntry): boolean {
  return left.artifactType === right.artifactType
    && left.artifactName === right.artifactName
    && left.kind === right.kind
    && left.hash === right.hash
    && left.sourceHash === right.sourceHash;
}

async function assertNoPendingJournals(targetRoot: string, adapter: string, transport: TargetTransport): Promise<void> {
  const pending = await listAllApplyJournals(targetRoot, adapter, transport);
  if (pending.length > 0) {
    throw new Error(`Cannot adopt legacy ownership while runtime apply journal(s) are pending: ${pending.map((item) => item.path).join(", ")}`);
  }
}

function assertApplyPreconditions(request: AdoptLegacyOwnershipRequest): void {
  for (const [label, value, allowAbsent] of [
    ["plan digest", request.planDigest, false],
    ["source manifest revision", request.expectedSourceRevision, false],
    ["destination manifest revision", request.expectedDestinationRevision, true],
    ["manifest inventory revision", request.expectedInventoryRevision, false],
  ] as const) {
    if (allowAbsent && value === absentRevision) continue;
    if (!value || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Applying legacy ownership adoption requires a reviewed lowercase SHA-256 ${label}${allowAbsent ? " or 'absent'" : ""}.`);
    }
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
