import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveAdapter } from "../adapters/resolve.js";
import { computeManifestRevision, withManifestRevision } from "../install/manifest.js";
import { installManifestPath, stateKeyFor } from "../install/paths.js";
import { acquireApplyLock, readApplyJournal, type ApplyLock } from "../install/transaction.js";
import { installRootForAdapterInstallationType } from "../model/adapter.js";
import { resolveWorkspaceScope, showRegisteredFleet, type WorkspaceScope } from "../model/fleet.js";
import { computeTargetFingerprint, readGraphLock, type GraphLock } from "../model/graph-lock.js";
import { installManifestSchema, type InstallManifestV2 } from "../model/manifest.js";
import { isCompositeWorkspaceProfile, resolveConfigPath, workspaceConfigPath, workspaceConfigSchema, type WorkspaceConfig, type WorkspacePackage } from "../model/workspace.js";
import { graphLockPathForTarget } from "./source-plan.js";
import { workspaceOwnerForRoot } from "./ownership.js";
import { hashPath, listFiles, pathExists, withFilesystemLock, writeJsonAtomic } from "../utils/fs.js";

export type FleetNormalizationSource = "user" | `fleet:${string}`;

export interface FleetNormalizationRequest {
  destinationFleet: string;
  from: FleetNormalizationSource;
  packages?: string[];
  artifacts?: string[];
  profile?: string;
  agent?: string;
  orphanedOwnerRoots?: string[];
  globalRoot?: string;
}

export interface FleetNormalizationApplyRequest extends FleetNormalizationRequest {
  apply?: boolean;
  planDigest?: string;
}

export interface FleetNormalizationPackage {
  name: string;
  declarationDigest: string;
}

export interface FleetNormalizationPlan {
  version: 1;
  request: FleetNormalizationRequest;
  source: { kind: "user" | "fleet"; root: string; fleetId?: string; configRevision: string };
  destination: { root: string; fleetId: string; configRevision: string };
  packages: FleetNormalizationPackage[];
  installedState: FleetNormalizationInstalledState;
  planDigest: string;
}

export interface FleetNormalizationInstalledState {
  graphLockDigests: string[];
  sourceManifestCount: number;
  destinationManifestCount: number;
  renderedPathCount: number;
  orphanedUnmanagedPaths: string[];
  sourceGraphLockPaths: string[];
  graphTransfers: FleetNormalizationGraphTransfer[];
  transfers: FleetNormalizationManifestTransfer[];
}

export interface FleetNormalizationGraphTransfer {
  sourceGraphLockPath: string;
  sourceGraphLockDigest: string;
  destinationGraphLockPath: string;
  destinationGraphLockDigest: string | null;
  destinationGraphLockAfterDigest: string;
  targetKey: string;
  adapter: string;
  targetFingerprint: string;
}

export interface FleetNormalizationManifestTransfer {
  sourceManifestPath: string;
  sourceManifestRevision: string;
  destinationManifestPath: string;
  destinationManifestRevision: string | null;
  destinationManifestAfterRevision: string | null;
  destinationTargetRoot: string;
  destinationStateKey: string;
  installationType: string;
  adapter: string;
  renderedPaths: string[];
  destinationRenderedPaths: string[];
  unmanagedSourceRenderedPaths: string[];
}

export interface FleetNormalizationResult {
  applied: true;
  planDigest: string;
  packages: string[];
}

interface JournalManifestState {
  path: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeRevision: string | null;
  afterRevision: string | null;
}

interface JournalGraphLockState {
  path: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeDigest: string | null;
  afterDigest: string | null;
}

interface NormalizeJournal {
  version: 1;
  planDigest: string;
  sourcePath: string;
  destinationPath: string;
  sourceBefore: WorkspaceConfig;
  sourceAfter: WorkspaceConfig;
  destinationBefore: WorkspaceConfig;
  manifests: JournalManifestState[];
  graphLocks: JournalGraphLockState[];
  phase: "prepared" | "destination-created" | "source-released" | "source-updated" | "rolled-back";
}

export interface FleetNormalizationApplyHooks {
  afterDestinationTransfer?(): void | Promise<void>;
  afterManifestTransfer?(): void | Promise<void>;
}

export interface FleetNormalizationRecoveryResult {
  recovered: true;
  sourceRestored: true;
  journalPath: string;
}

interface CollectedManifest {
  path: string;
  raw: Record<string, unknown>;
  manifest: InstallManifestV2;
}

export async function planFleetNormalization(request: FleetNormalizationRequest): Promise<FleetNormalizationPlan> {
  const normalizedRequest = normalizeRequest(request);
  const destinationScope = await resolveWorkspaceScope({
    fleet: normalizedRequest.destinationFleet,
    globalRoot: normalizedRequest.globalRoot,
  });
  const sourceScope = await resolveNormalizationSource(normalizedRequest.from, normalizedRequest.globalRoot);
  const legacySelfNormalization = isLegacySelfNormalizationRequest(normalizedRequest, sourceScope, destinationScope);
  if (sourceScope.root === destinationScope.root && !legacySelfNormalization) {
    throw new Error("Fleet normalization requires distinct source and destination scopes unless --from fleet:<destinationFleet> performs a legacy ownership-only handoff.");
  }

  const sourceByName = packageMap(sourceScope.config);
  const destinationByName = packageMap(destinationScope.config);
  const candidates = normalizedRequest.packages?.length
    ? normalizedRequest.packages
    : [...sourceByName.keys()].filter((name) => destinationByName.has(name)).sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) throw new Error("No eligible duplicate package declarations exist to normalize.");

  const packages: FleetNormalizationPackage[] = [];
  for (const name of candidates) {
    const sourcePackage = sourceByName.get(name);
    const destinationPackage = destinationByName.get(name);
    if (!sourcePackage || !destinationPackage) {
      throw new Error(`Package '${name}' must be an existing duplicate in both source and destination fleets.`);
    }
    const sourceDeclaration = canonicalJson(sourcePackage);
    const destinationDeclaration = canonicalJson(destinationPackage);
    if (sourceDeclaration !== destinationDeclaration) {
      throw new Error(
        `Package '${name}' has divergent declarations. Source, driver, adapter, adapter configuration, installation type, `
        + "version policy, selections, aliases, overrides, and suggestions must match before normalization.",
      );
    }
    packages.push({ name, declarationDigest: sha256(sourceDeclaration) });
  }

  if (!legacySelfNormalization) await assertSourceFleetPostcondition(normalizedRequest, sourceScope, candidates);

  if ((normalizedRequest.profile || normalizedRequest.agent || normalizedRequest.artifacts || normalizedRequest.orphanedOwnerRoots) && !legacySelfNormalization) {
    throw new Error("--profile, --agent, --artifact, and --orphaned-owner are supported only for legacy same-fleet ownership normalization.");
  }
  const installedState = legacySelfNormalization
    ? await inspectLegacySelfInstalledState(
        destinationScope,
        candidates,
        normalizedRequest.profile,
        normalizedRequest.agent,
        normalizedRequest.artifacts,
        normalizedRequest.orphanedOwnerRoots,
      )
    : await inspectInstalledState(sourceScope, destinationScope, candidates);

  const planWithoutDigest = {
    version: 1 as const,
    request: normalizedRequest,
    source: {
      kind: sourceScope.kind === "user" ? "user" as const : "fleet" as const,
      root: sourceScope.root,
      ...(sourceScope.fleetId ? { fleetId: sourceScope.fleetId } : {}),
      configRevision: configRevision(sourceScope.config),
    },
    destination: {
      root: destinationScope.root,
      fleetId: destinationScope.fleetId!,
      configRevision: configRevision(destinationScope.config),
    },
    packages,
    installedState,
  };
  return { ...planWithoutDigest, planDigest: sha256(canonicalJson(planWithoutDigest)) };
}

export async function applyFleetNormalization(
  request: FleetNormalizationApplyRequest,
  hooks: FleetNormalizationApplyHooks = {},
): Promise<FleetNormalizationResult> {
  if (!request.apply) throw new Error("Fleet normalization is dry-run by default; pass --apply with --plan-digest <digest>.");
  if (!request.planDigest) throw new Error("Applying fleet normalization requires --plan-digest <digest> from a reviewed dry-run.");
  assertDigest(request.planDigest);
  const normalizedRequest = normalizeRequest(request);
  const roots = await normalizationRoots(normalizedRequest);
  const ordered = [...new Set([roots.source, roots.destination])].sort((a, b) => a.localeCompare(b));

  return withOrderedLocks(ordered, async () => {
    const observed = await planFleetNormalization(normalizedRequest);
    assertCurrentDigest(request.planDigest!, observed.planDigest);
    const manifestLocks = await acquireManifestLocks(observed.installedState.transfers);
    try {
      const current = await planFleetNormalization(normalizedRequest);
      assertCurrentDigest(request.planDigest!, current.planDigest);
      return await applyLockedNormalization(current, hooks);
    } finally {
      await releaseLocks(manifestLocks);
    }
  });
}

async function applyLockedNormalization(
  current: FleetNormalizationPlan,
  hooks: FleetNormalizationApplyHooks,
): Promise<FleetNormalizationResult> {
  const sourcePath = workspaceConfigPath(current.source.root);
  const destinationPath = workspaceConfigPath(current.destination.root);
  const sourceBefore = await readExactConfig(sourcePath);
  const destinationBefore = await readExactConfig(destinationPath);
  if (configRevision(sourceBefore) !== current.source.configRevision
    || configRevision(destinationBefore) !== current.destination.configRevision) {
    throw new Error("Fleet normalization config changed after precondition validation; source state was not modified.");
  }
  const names = new Set(current.packages.map((entry) => entry.name));
  const ownershipOnly = isLegacySelfNormalizationPlan(current);
  const sourceAfter = ownershipOnly
    ? sourceBefore
    : workspaceConfigSchema.parse({
        ...sourceBefore,
        packages: sourceBefore.packages.filter((pkg) => !names.has(pkg.name)),
      });
  const manifests = await buildJournalManifestStates(current, names);
  const graphLocks = await buildJournalGraphLockStates(current);
  const finalObservation = await planFleetNormalization(current.request);
  assertCurrentDigest(current.planDigest, finalObservation.planDigest);
  const journalPath = normalizationJournalPath(current.source.root, current.destination.fleetId);
  if (await pathExists(journalPath)) {
    throw new Error(`A fleet normalization journal is already pending at ${journalPath}. Recover it before re-planning.`);
  }
  const journal: NormalizeJournal = {
    version: 1,
    planDigest: current.planDigest,
    sourcePath,
    destinationPath,
    sourceBefore,
    sourceAfter,
    destinationBefore,
    manifests,
    graphLocks,
    phase: "prepared",
  };
  await writeJsonAtomic(journalPath, journal);

  try {
    const destinationManifestPaths = new Set(current.installedState.transfers.map((transfer) => transfer.destinationManifestPath));
    const sourceManifestPaths = new Set(current.installedState.transfers.map((transfer) => transfer.sourceManifestPath));
    const destinationGraphPaths = new Set(current.installedState.graphTransfers.map((transfer) => transfer.destinationGraphLockPath));
    const sourceGraphPaths = new Set(current.installedState.graphTransfers.map((transfer) => transfer.sourceGraphLockPath));
    for (const manifest of manifests.filter((state) => destinationManifestPaths.has(state.path))) {
      if (!manifest.after) throw new Error(`Destination manifest handoff has no after state: ${manifest.path}`);
      await writeJsonAtomic(manifest.path, manifest.after);
    }
    for (const graphLock of graphLocks.filter((state) => destinationGraphPaths.has(state.path))) {
      if (!graphLock.after) throw new Error(`Destination graph handoff has no after state: ${graphLock.path}`);
      await writeJsonAtomic(graphLock.path, graphLock.after);
    }
    await writeJsonAtomic(journalPath, { ...journal, phase: "destination-created" });
    await hooks.afterDestinationTransfer?.();
    for (const manifest of manifests.filter((state) => sourceManifestPaths.has(state.path))) {
      if (manifest.after) await writeJsonAtomic(manifest.path, manifest.after);
      else await rm(manifest.path, { force: true });
    }
    for (const graphLock of graphLocks.filter((state) => sourceGraphPaths.has(state.path))) {
      if (graphLock.after) await writeJsonAtomic(graphLock.path, graphLock.after);
      else await rm(graphLock.path, { force: true });
    }
    await writeJsonAtomic(journalPath, { ...journal, phase: "source-released" });
    await hooks.afterManifestTransfer?.();
    const [sourceAtCommit, destinationAtCommit] = await Promise.all([
      readExactConfig(sourcePath),
      readExactConfig(destinationPath),
    ]);
    if (configRevision(sourceAtCommit) !== configRevision(sourceBefore)
      || configRevision(destinationAtCommit) !== configRevision(destinationBefore)) {
      throw new Error("Fleet normalization source config changed or destination config changed concurrently before compare-and-swap commit; the external edit was preserved.");
    }
    if (!ownershipOnly) await writeJsonAtomic(sourcePath, sourceAfter);
    await writeJsonAtomic(journalPath, { ...journal, phase: "source-updated" });
    await rm(journalPath, { force: true });
    return { applied: true, planDigest: current.planDigest, packages: [...names].sort((a, b) => a.localeCompare(b)) };
  } catch (error) {
    const restored = await restoreJournalSource(journal, true).then(() => true, () => false);
    if (restored) await writeJsonAtomic(journalPath, { ...journal, phase: "rolled-back" }).catch(() => undefined);
    throw error;
  }
}

export async function recoverFleetNormalization(request: FleetNormalizationRequest): Promise<FleetNormalizationRecoveryResult> {
  const normalizedRequest = normalizeRequest(request);
  const roots = await normalizationRoots(normalizedRequest);
  const ordered = [...new Set([roots.source, roots.destination])].sort((a, b) => a.localeCompare(b));
  return withOrderedLocks(ordered, async () => {
    const journalPath = normalizationJournalPath(roots.source, normalizedRequest.destinationFleet);
    if (!(await pathExists(journalPath))) throw new Error(`No pending fleet normalization journal at ${journalPath}.`);
    const journal = await readNormalizeJournal(journalPath);
    const locks = await acquireJournalManifestLocks(journal.manifests);
    try {
      await assertJournalRecoverable(journal);
      await restoreJournalSource(journal);
      await rm(journalPath, { force: true });
      return { recovered: true, sourceRestored: true, journalPath };
    } finally {
      await releaseLocks(locks);
    }
  });
}

async function resolveNormalizationSource(from: FleetNormalizationSource, globalRoot?: string): Promise<WorkspaceScope> {
  if (from === "user") return resolveWorkspaceScope({ user: true, globalRoot });
  if (from.startsWith("fleet:") && from.length > "fleet:".length) {
    return resolveWorkspaceScope({ fleet: from.slice("fleet:".length), globalRoot });
  }
  throw new Error("--from must be 'user' or 'fleet:<sourceFleet>'.");
}

function isLegacySelfNormalizationRequest(
  request: FleetNormalizationRequest,
  source: WorkspaceScope,
  destination: WorkspaceScope,
): boolean {
  return source.kind === "fleet"
    && source.fleetId === request.destinationFleet
    && request.from === `fleet:${request.destinationFleet}`
    && source.root === destination.root;
}

function isLegacySelfNormalizationPlan(plan: FleetNormalizationPlan): boolean {
  return plan.source.kind === "fleet"
    && plan.source.fleetId === plan.destination.fleetId
    && plan.source.root === plan.destination.root
    && plan.request.from === `fleet:${plan.destination.fleetId}`;
}

async function assertSourceFleetPostcondition(
  request: FleetNormalizationRequest,
  source: WorkspaceScope,
  selectedPackages: string[],
): Promise<void> {
  if (source.kind !== "fleet" || !source.fleetId) return;
  const registration = await showRegisteredFleet(source.fleetId, { globalRoot: request.globalRoot });
  const removed = new Set(selectedPackages);
  const remaining = new Set(source.config.packages.filter((pkg) => !removed.has(pkg.name)).map((pkg) => pkg.name));
  const missing = registration.requiredPackages.filter((name) => !remaining.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Source fleet '${source.fleetId}' postcondition would remove required package(s): ${missing.join(", ")}.`,
    );
  }
}

function normalizeRequest(request: FleetNormalizationRequest): FleetNormalizationRequest {
  const packages = request.packages === undefined ? undefined : sortedUnique(request.packages);
  if (request.packages !== undefined && packages?.length === 0) throw new Error("--package requires at least one package name.");
  const artifacts = request.artifacts === undefined
    ? undefined
    : sortedUnique(request.artifacts.map((artifact) => normalizeArtifactSelector(artifact)));
  if (request.artifacts !== undefined && artifacts?.length === 0) throw new Error("--artifact requires at least one type/name selector.");
  const profile = request.profile?.trim();
  if (request.profile !== undefined && !profile) throw new Error("--profile requires a profile name.");
  const agent = request.agent?.trim();
  if (request.agent !== undefined && !agent) throw new Error("--agent requires a configured agent name.");
  if (profile && agent) throw new Error("--profile and --agent cannot be combined.");
  const orphanedOwnerRoots = request.orphanedOwnerRoots === undefined
    ? undefined
    : sortedUnique(request.orphanedOwnerRoots.map((root) => normalizeOrphanedOwnerRoot(root)));
  if (request.orphanedOwnerRoots !== undefined && orphanedOwnerRoots?.length === 0) {
    throw new Error("--orphaned-owner requires at least one absolute workspace root.");
  }
  return {
    destinationFleet: request.destinationFleet.trim(),
    from: request.from,
    ...(packages ? { packages } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(profile ? { profile } : {}),
    ...(agent ? { agent } : {}),
    ...(orphanedOwnerRoots ? { orphanedOwnerRoots } : {}),
    ...(request.globalRoot ? { globalRoot: resolve(request.globalRoot) } : {}),
  };
}

function normalizeOrphanedOwnerRoot(value: string): string {
  const root = value.trim();
  if (!root || !isAbsolute(root)) throw new Error(`Invalid orphaned owner root '${value}'; expected an absolute workspace path.`);
  return resolve(root);
}

async function normalizationRoots(request: FleetNormalizationRequest): Promise<{ source: string; destination: string }> {
  const destination = await showRegisteredFleet(request.destinationFleet, { globalRoot: request.globalRoot });
  const source = request.from === "user"
    ? resolve(request.globalRoot ?? homedir())
    : (await showRegisteredFleet(request.from.slice("fleet:".length), { globalRoot: request.globalRoot })).root;
  return { source, destination: destination.root };
}

async function withOrderedLocks<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const run = async (index: number): Promise<T> => {
    if (index === roots.length) return fn();
    const root = roots[index]!;
    return withFilesystemLock(
      join(root, ".agentwheel", "fleet-normalize.lock"),
      5_000,
      () => run(index + 1),
      "fleet normalization",
    );
  };
  return run(0);
}

async function inspectInstalledState(
  source: WorkspaceScope,
  destination: WorkspaceScope,
  packageNames: string[],
): Promise<FleetNormalizationInstalledState> {
  const selected = new Set(packageNames);
  const [sourceGraphs, destinationGraphs, sourceRoots, destinationRoots] = await Promise.all([
    relevantGraphLocks(source.root, selected),
    relevantGraphLocks(destination.root, selected),
    runtimeRoots(source),
    runtimeRoots(destination),
  ]);
  const allRoots = [...new Set([...sourceRoots, ...destinationRoots])];
  const manifests = await collectManifests(allRoots);
  const sourceOwners = workspaceOwners(source);
  const destinationOwners = workspaceOwners(destination);
  const sourceEntries = relevantManifestEntries(manifests, selected, sourceOwners);
  const destinationEntries = relevantManifestEntries(manifests, selected, destinationOwners);
  const anyRelevantManifest = manifests.some((item) => item.manifest.entries.some((entry) => entryMatchesPackages(entry, selected)));
  const anyRelevantGraph = sourceGraphs.length > 0 || destinationGraphs.length > 0;

  if (anyRelevantManifest && !anyRelevantGraph) {
    throw new Error("Installed manifests exist for the selected packages without matching graph lock evidence; normalization is blocked.");
  }
  if (anyRelevantGraph && !anyRelevantManifest) {
    throw new Error("Graph lock state exists for the selected packages without matching install manifests; normalization is blocked.");
  }
  if (!anyRelevantManifest && !anyRelevantGraph) {
    return {
      graphLockDigests: [],
      sourceManifestCount: 0,
      destinationManifestCount: 0,
      renderedPathCount: 0,
      orphanedUnmanagedPaths: [],
      sourceGraphLockPaths: [],
      graphTransfers: [],
      transfers: [],
    };
  }
  if (sourceGraphs.length === 0) {
    throw new Error("Source install manifests require source graph lock coverage before ownership can be handed off.");
  }
  for (const graph of sourceGraphs) {
    if (!graph.allRootsSelected) throw new Error(`Source graph lock is only partially selected and cannot be removed safely: ${graph.path}`);
  }
  if (sourceEntries.length === 0) {
    throw new Error("Source graph lock state is not covered by a source-owned install manifest.");
  }

  const transfers = new Map<string, FleetNormalizationManifestTransfer>();
  const graphTransfers: FleetNormalizationGraphTransfer[] = [];
  const plannedDestinationPaths = new Set<string>();
  const coveredSourceEntries = new Set<RelevantManifestEntry>();
  const coveredDestinationGraphs = new Set<string>();
  const plannedDestinationGraphs = new Set<string>();

  for (const sourceGraph of sourceGraphs) {
    const sourceState = await targetStateForGraph(source, sourceGraph);
    const destinationState = await targetStateForGraph(destination, sourceGraph);
    if (sourceState.graphLockPath !== sourceGraph.path) {
      throw new Error(`Source graph lock target identity is stale or noncanonical: ${sourceGraph.path}`);
    }
    if (sourceState.adapter !== destinationState.adapter) {
      throw new Error(`Source and destination adapters diverge for target '${sourceGraph.targetKey}'.`);
    }
    const expectedSourceManifest = sourceEntries.filter((entry) => entry.manifest.path === sourceState.manifestPath);
    if (expectedSourceManifest.length === 0) {
      throw new Error(`Source graph lock is not covered by its canonical install manifest: ${sourceState.manifestPath}`);
    }
    const sourceGraphArtifacts = new Set(sourceGraph.artifactIdentities);
    const destinationGraph = destinationGraphs.find((candidate) => candidate.path === destinationState.graphLockPath);
    if (destinationGraph && destinationGraph.digest !== sourceGraph.digest) {
      throw new Error("Source and destination graph declarations, selections, versions, identities, or rendered paths diverge.");
    }
    if (plannedDestinationGraphs.has(destinationState.graphLockPath)) {
      throw new Error(`Multiple source target graphs resolve to the same destination graph identity: ${destinationState.graphLockPath}`);
    }
    plannedDestinationGraphs.add(destinationState.graphLockPath);
    if (destinationGraph) coveredDestinationGraphs.add(destinationGraph.path);
    const destinationGraphAfter = destinationGraph?.lock
      ?? destinationGraphFromSource(sourceGraph.lock, destinationState.targetFingerprint);
    graphTransfers.push({
      sourceGraphLockPath: sourceGraph.path,
      sourceGraphLockDigest: sha256(canonicalJson(sourceGraph.lock)),
      destinationGraphLockPath: destinationState.graphLockPath,
      destinationGraphLockDigest: destinationGraph ? sha256(canonicalJson(destinationGraph.lock)) : null,
      destinationGraphLockAfterDigest: sha256(canonicalJson(destinationGraphAfter)),
      targetKey: sourceGraph.targetKey,
      adapter: destinationState.adapter,
      targetFingerprint: destinationState.targetFingerprint,
    });

    const existingDestinationManifest = manifests.find((manifest) => manifest.path === destinationState.manifestPath);
    const destinationBeforeRevision = existingDestinationManifest?.manifest.revision ?? null;
    const desiredEntries: InstallManifestV2["entries"] = [];
    const sourceRenderedPaths: string[] = [];
    const destinationRenderedPaths: string[] = [];
    for (const sourceEntry of expectedSourceManifest) {
      coveredSourceEntries.add(sourceEntry);
      assertSimpleVerifiableEntry(sourceEntry.entry, sourceEntry.renderedPath);
      if (!sourceGraphArtifacts.has(graphEntryIdentity(sourceEntry.entry))) {
        throw new Error(`Source manifest entry is not covered by its graph lock: ${sourceEntry.renderedPath}`);
      }
      if (sourceEntry.entry.owners.some((owner) => !selected.has(owner))) {
        throw new Error(`Partial ownership at ${sourceEntry.renderedPath} includes packages outside the normalization selection.`);
      }
      const destinationRenderedPath = renderedEntryPathForRoot(destinationState.installRoot, sourceEntry.entry.path);
      await assertEquivalentRuntimeBytes(sourceEntry.renderedPath, destinationRenderedPath, sourceEntry.entry.hash);
      plannedDestinationPaths.add(destinationRenderedPath);
      sourceRenderedPaths.push(sourceEntry.renderedPath);
      destinationRenderedPaths.push(destinationRenderedPath);
      desiredEntries.push({
        ...sourceEntry.entry,
        workspaceOwner: workspaceOwnerForRoot(destination.root, destination.fleetId!),
      });
    }

    const destinationAfter = mergeDestinationManifest(
      existingDestinationManifest,
      destinationState,
      expectedSourceManifest[0]!.manifest.manifest.generatedAt,
      desiredEntries,
      sourceOwners,
    );
    const transferKey = `${sourceState.manifestPath}\0${destinationState.manifestPath}`;
    transfers.set(transferKey, {
      sourceManifestPath: sourceState.manifestPath,
      sourceManifestRevision: expectedSourceManifest[0]!.manifest.manifest.revision,
      destinationManifestPath: destinationState.manifestPath,
      destinationManifestRevision: destinationBeforeRevision,
      destinationManifestAfterRevision: computeManifestRevision(destinationAfter),
      destinationTargetRoot: destinationState.installRoot,
      destinationStateKey: destinationState.stateKey,
      installationType: destinationState.installationType,
      adapter: destinationState.adapter,
      renderedPaths: sortedUnique(sourceRenderedPaths),
      destinationRenderedPaths: sortedUnique(destinationRenderedPaths),
      unmanagedSourceRenderedPaths: [],
    });
  }

  if (coveredSourceEntries.size !== sourceEntries.length) {
    throw new Error("Source installed state is only partially covered by the selected graph locks.");
  }
  for (const destinationGraph of destinationGraphs) {
    if (!coveredDestinationGraphs.has(destinationGraph.path)) {
      throw new Error(`Destination graph state is stale or uncovered: ${destinationGraph.path}`);
    }
  }
  const plannedDestinationManifests = new Set([...transfers.values()].map((transfer) => transfer.destinationManifestPath));
  for (const destinationEntry of destinationEntries) {
    if (!plannedDestinationManifests.has(destinationEntry.manifest.path)) {
      throw new Error(`Destination installed state is stale or uncovered: ${destinationEntry.manifest.path}`);
    }
  }
  for (const manifest of manifests) {
    for (const entry of manifest.manifest.entries) {
      const renderedPath = renderedEntryPath(manifest.manifest, entry);
      if (!plannedDestinationPaths.has(renderedPath)) continue;
      if (sourceOwners.has(entry.workspaceOwner) || destinationOwners.has(entry.workspaceOwner)) continue;
      throw new Error(
        `Foreign same-path ownership at ${renderedPath} belongs to ${entry.workspaceOwner}. `
        + "Byte equality is insufficient; an explicit reviewed handoff plan is required.",
      );
    }
  }

  return {
    graphLockDigests: sourceGraphs.map((item) => item.digest).sort(),
    sourceManifestCount: new Set(sourceEntries.map((entry) => entry.manifest.path)).size,
    destinationManifestCount: new Set(destinationEntries.map((entry) => entry.manifest.path)).size,
    renderedPathCount: plannedDestinationPaths.size,
    orphanedUnmanagedPaths: [],
    sourceGraphLockPaths: sourceGraphs.map((graph) => graph.path).sort((a, b) => a.localeCompare(b)),
    graphTransfers: graphTransfers.sort((a, b) => a.sourceGraphLockPath.localeCompare(b.sourceGraphLockPath)),
    transfers: [...transfers.values()]
      .sort((a, b) => `${a.sourceManifestPath}:${a.destinationManifestPath}`.localeCompare(`${b.sourceManifestPath}:${b.destinationManifestPath}`)),
  };
}

async function inspectLegacySelfInstalledState(
  fleet: WorkspaceScope,
  packageNames: string[],
  profileName?: string,
  agentName?: string,
  artifactNames?: string[],
  orphanedOwnerRoots?: string[],
): Promise<FleetNormalizationInstalledState> {
  if (fleet.kind !== "fleet" || !fleet.fleetId) {
    throw new Error("Legacy self-normalization requires a registered named fleet destination.");
  }
  const selected = new Set(packageNames);
  const selectedArtifacts = artifactNames ? new Set(artifactNames) : undefined;
  const targetKeys = agentName
    ? targetKeysForAgent(fleet, agentName)
    : profileName ? targetKeysForProfile(fleet, profileName) : undefined;
  const graphCandidates = await relevantGraphLocks(
    fleet.root,
    selected,
    targetKeys,
    async (graph) => hasRelevantLegacyManifestCandidate(fleet, graph, selected),
  );
  const graphs: RelevantGraphLock[] = [];
  const legacyOwner = workspaceOwnerForRoot(fleet.root);
  const fleetOwner = workspaceOwnerForRoot(fleet.root, fleet.fleetId);
  const orphanedOwners = await orphanedWorkspaceOwners(orphanedOwnerRoots);
  const knownLegacyOwners = new Set([legacyOwner, ...orphanedOwners]);
  const transferableOwners = orphanedOwners.size > 0 ? orphanedOwners : new Set([legacyOwner]);
  let normalizedGraphCount = 0;
  for (const graph of graphCandidates) {
    const legacyState = await legacyTargetStateForGraph(fleet, graph);
    const legacyManifest = (await collectManifestPaths([legacyState.manifestPath]))[0];
    const relevantManifestEntries = legacyManifest?.manifest.entries.filter((entry) =>
      entryMatchesGraphPackages(entry, graph.lock, selected)
      && entryMatchesArtifacts(entry, selectedArtifacts)) ?? [];
    if (relevantManifestEntries.length > 0) {
      graphs.push(graph);
    }
    const destinationState = await targetStateForGraph(fleet, graph, fleet.fleetId);
    if (destinationState.graphLockPath === graph.path
      && legacyManifest?.manifest.entries.some((entry) =>
        entry.workspaceOwner === fleetOwner && entryMatchesPackages(entry, selected))) {
      normalizedGraphCount += 1;
    }
  }
  if (graphs.length === 0 && normalizedGraphCount > 0) {
    throw new Error(`Fleet '${fleet.fleetId}' installed state is already normalized to fleet-qualified ownership.`);
  }
  const manifestPaths = new Set<string>();
  for (const graph of graphs) {
    manifestPaths.add((await legacyTargetStateForGraph(fleet, graph)).manifestPath);
    manifestPaths.add((await targetStateForGraph(fleet, graph, fleet.fleetId)).manifestPath);
  }
  const manifests = await collectManifestPaths([...manifestPaths]);
  const relevantEntries = manifests.flatMap((manifest) => manifest.manifest.entries
    .filter((entry) => graphs.some((graph) => entryMatchesGraphPackages(entry, graph.lock, selected))
      && entryMatchesArtifacts(entry, selectedArtifacts))
    .map((entry) => ({ manifest, entry, renderedPath: renderedEntryPath(manifest.manifest, entry) })));
  const legacyEntries = relevantEntries.filter((entry) => transferableOwners.has(entry.entry.workspaceOwner));
  const qualifiedEntries = relevantEntries.filter((entry) => entry.entry.workspaceOwner === fleetOwner);
  const foreignEntries = relevantEntries.filter((entry) =>
    !knownLegacyOwners.has(entry.entry.workspaceOwner) && entry.entry.workspaceOwner !== fleetOwner);

  if (foreignEntries.length > 0) {
    throw new Error(
      `Legacy self-normalization owner mismatch at ${foreignEntries[0]!.renderedPath}: `
      + `expected ${legacyOwner}, found foreign owner ${foreignEntries[0]!.entry.workspaceOwner}.`,
    );
  }
  for (const orphanedOwner of orphanedOwners) {
    if (!legacyEntries.some((entry) => entry.entry.workspaceOwner === orphanedOwner)) {
      throw new Error(`Accepted orphaned owner '${orphanedOwner}' has no matching installed-state entries for this normalization.`);
    }
  }
  if (legacyEntries.length === 0) {
    if (qualifiedEntries.length > 0) {
      throw new Error(`Fleet '${fleet.fleetId}' installed state is already normalized to fleet-qualified ownership.`);
    }
    throw new Error(`Fleet '${fleet.fleetId}' has no legacy same-root manifest ownership to normalize.`);
  }
  if (graphs.length === 0) {
    throw new Error("Legacy same-root install manifests exist without matching graph lock evidence; self-normalization is blocked.");
  }
  for (const graph of graphs) {
    if (!selectedArtifacts && !graph.allRootsSelected) {
      throw new Error(`Legacy graph lock is only partially selected and cannot be moved safely: ${graph.path}`);
    }
  }

  const transfers = new Map<string, FleetNormalizationManifestTransfer>();
  const graphTransfers: FleetNormalizationGraphTransfer[] = [];
  const coveredEntries = new Set<RelevantManifestEntry>();
  const renderedPaths = new Set<string>();
  const orphanedUnmanagedPaths = new Set<string>();

  for (const graph of graphs) {
    const legacyState = await legacyTargetStateForGraph(fleet, graph);
    const destinationState = await targetStateForGraph(fleet, graph, fleet.fleetId);
    if (graph.path === destinationState.graphLockPath) {
      throw new Error(`Fleet '${fleet.fleetId}' graph state is already normalized to fleet-qualified identity.`);
    }
    const expectedEntries = legacyEntries.filter((entry) => entry.manifest.path === legacyState.manifestPath);
    if (expectedEntries.length === 0) {
      throw new Error(`Legacy graph lock is not covered by its canonical same-root install manifest: ${legacyState.manifestPath}`);
    }
    const graphArtifacts = new Set(graph.artifactIdentities);
    const existingManifest = manifests.find((manifest) => manifest.path === destinationState.manifestPath);
    const desiredEntries: InstallManifestV2["entries"] = [];
    const sourceRenderedPaths: string[] = [];
    const destinationRenderedPaths: string[] = [];
    for (const entry of expectedEntries) {
      coveredEntries.add(entry);
      assertSimpleVerifiableEntry(entry.entry, entry.renderedPath);
      const coveredByCurrentGraph = graphArtifacts.has(graphEntryIdentity(entry.entry));
      const matchesCurrentGraph = orphanedOwners.has(entry.entry.workspaceOwner)
        && orphanedEntryMatchesCurrentGraph(entry, graph, selected);
      if (!coveredByCurrentGraph && !matchesCurrentGraph && !orphanedOwners.has(entry.entry.workspaceOwner)) {
        throw new Error(`Legacy manifest entry is not covered by its graph lock: ${entry.renderedPath}`);
      }
      await assertEquivalentRuntimeBytes(entry.renderedPath, entry.renderedPath, entry.entry.hash);
      renderedPaths.add(entry.renderedPath);
      sourceRenderedPaths.push(entry.renderedPath);
      if (coveredByCurrentGraph || matchesCurrentGraph) {
        desiredEntries.push({ ...entry.entry, workspaceOwner: fleetOwner });
        destinationRenderedPaths.push(entry.renderedPath);
      } else {
        orphanedUnmanagedPaths.add(entry.renderedPath);
      }
    }
    const after = desiredEntries.length > 0 || existingManifest
      ? mergeDestinationManifest(
          existingManifest,
          destinationState,
          expectedEntries[0]!.manifest.manifest.generatedAt,
          desiredEntries,
          transferableOwners,
        )
      : undefined;
    transfers.set(legacyState.manifestPath, {
      sourceManifestPath: legacyState.manifestPath,
      sourceManifestRevision: expectedEntries[0]!.manifest.manifest.revision,
      destinationManifestPath: destinationState.manifestPath,
      destinationManifestRevision: existingManifest?.manifest.revision ?? null,
      destinationManifestAfterRevision: after ? computeManifestRevision(after) : null,
      destinationTargetRoot: destinationState.installRoot,
      destinationStateKey: destinationState.stateKey,
      installationType: destinationState.installationType,
      adapter: destinationState.adapter,
      renderedPaths: sortedUnique(sourceRenderedPaths),
      destinationRenderedPaths: sortedUnique(destinationRenderedPaths),
      unmanagedSourceRenderedPaths: sortedUnique(
        sourceRenderedPaths.filter((path) => !destinationRenderedPaths.includes(path)),
      ),
    });
    if (!selectedArtifacts) {
      const fullDigest = sha256(canonicalJson(graph.lock));
      const existingDestinationGraph = graphCandidates.find((candidate) => candidate.path === destinationState.graphLockPath);
      if (existingDestinationGraph) assertGraphIsSubset(graph, existingDestinationGraph);
      const destinationGraph = destinationGraphFromSource(graph.lock, destinationState.targetFingerprint);
      graphTransfers.push({
        sourceGraphLockPath: graph.path,
        sourceGraphLockDigest: fullDigest,
        destinationGraphLockPath: destinationState.graphLockPath,
        destinationGraphLockDigest: existingDestinationGraph
          ? sha256(canonicalJson(existingDestinationGraph.lock))
          : null,
        destinationGraphLockAfterDigest: sha256(canonicalJson(destinationGraph)),
        targetKey: graph.targetKey,
        adapter: graph.adapter,
        targetFingerprint: destinationState.targetFingerprint,
      });
    }
  }

  if (coveredEntries.size !== legacyEntries.length) {
    throw new Error("Legacy same-root manifest ownership is only partially covered by canonical graph locks.");
  }

  return {
    graphLockDigests: graphs.map((graph) => graph.digest).sort(),
    sourceManifestCount: new Set(legacyEntries.map((entry) => entry.manifest.path)).size,
    destinationManifestCount: new Set(qualifiedEntries.map((entry) => entry.manifest.path)).size,
    renderedPathCount: renderedPaths.size,
    orphanedUnmanagedPaths: [...orphanedUnmanagedPaths].sort((a, b) => a.localeCompare(b)),
    sourceGraphLockPaths: graphs.map((graph) => graph.path).sort((a, b) => a.localeCompare(b)),
    graphTransfers: graphTransfers.sort((a, b) => a.sourceGraphLockPath.localeCompare(b.sourceGraphLockPath)),
    transfers: [...transfers.values()].sort((a, b) => a.sourceManifestPath.localeCompare(b.sourceManifestPath)),
  };
}

async function orphanedWorkspaceOwners(roots?: string[]): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const root of roots ?? []) {
    if (await pathExists(root)) {
      throw new Error(`Orphaned owner root still exists and cannot be adopted: ${root}. Recover or normalize it from that workspace instead.`);
    }
    owners.add(workspaceOwnerForRoot(root));
  }
  return owners;
}

function targetKeysForProfile(scope: WorkspaceScope, name: string): Set<string> {
  const profile = scope.config.profiles[name];
  if (!profile) throw new Error(`Unknown fleet profile '${name}'.`);
  if (isCompositeWorkspaceProfile(profile)) {
    throw new Error(`Fleet normalization requires a concrete local profile; '${name}' is composite.`);
  }
  return new Set(profile.runtimes.map((runtime) => runtime.agent ?? runtime.adapter));
}

function targetKeysForAgent(scope: WorkspaceScope, name: string): Set<string> {
  const agent = scope.config.agents[name];
  if (!agent) throw new Error(`Unknown fleet agent '${name}'.`);
  if (agent.transport === "ssh") {
    throw new Error(`Installed-state normalization cannot hand off SSH agent '${name}' locally.`);
  }
  return new Set([name]);
}

interface RelevantManifestEntry {
  manifest: CollectedManifest;
  entry: InstallManifestV2["entries"][number];
  renderedPath: string;
}

async function runtimeRoots(scope: WorkspaceScope): Promise<string[]> {
  const roots = new Set<string>([scope.root]);
  if (scope.config.packages.some((pkg) => pkg.installationType === "user")
    || Object.values(scope.config.agents).some((agent) => agent.installationType === "user")) {
    roots.add(resolve(process.env.AGENTWHEEL_TEST_HOME || process.env.HOME || homedir()));
  }
  for (const [name, agent] of Object.entries(scope.config.agents)) {
    if (agent.transport === "ssh") throw new Error(`Installed-state normalization cannot inspect SSH agent '${name}' locally.`);
    roots.add(resolveConfigPath(agent.root, scope.root));
  }
  for (const profile of Object.values(scope.config.profiles)) {
    // Composite profiles coordinate member workspaces; they do not own a local
    // runtime target. Each member's installed state remains authoritative in
    // that member workspace and must be normalized there independently.
    if (isCompositeWorkspaceProfile(profile)) continue;
    for (const runtime of profile.runtimes) {
      if (runtime.agent) continue;
      roots.add(runtime.targetRoot ? resolveConfigPath(runtime.targetRoot, scope.root) : scope.root);
    }
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

async function collectManifests(roots: string[]): Promise<CollectedManifest[]> {
  const found = new Map<string, CollectedManifest>();
  for (const root of roots) {
    const dir = join(root, ".agentwheel");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith(".install-manifest.json")) continue;
      const path = join(dir, name);
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const parsed = installManifestSchema.parse(raw);
      if (parsed.version !== 2) {
        if (parsed.entries.some((entry) => entry.packageName)) {
          throw new Error(`Legacy v1 install manifest cannot prove fleet ownership: ${path}`);
        }
        continue;
      }
      if (resolve(parsed.targetRoot) !== resolve(root)) {
        throw new Error(`Install manifest target root does not match its enumerated runtime root: ${path}`);
      }
      const expectedPath = installManifestPath(parsed.targetRoot, parsed.adapter, {
        installationType: parsed.installationType,
        stateKey: parsed.stateKey,
      });
      if (resolve(expectedPath) !== resolve(path)) {
        throw new Error(`Install manifest state identity does not match its canonical path: ${path}`);
      }
      found.set(path, { path, raw, manifest: { ...parsed, revision: computeManifestRevision(raw), legacy: false } });
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function collectManifestPaths(paths: string[]): Promise<CollectedManifest[]> {
  const found: CollectedManifest[] = [];
  for (const path of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
    if (!(await pathExists(path))) continue;
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const parsed = installManifestSchema.parse(raw);
    if (parsed.version !== 2) {
      throw new Error(`Legacy v1 install manifest cannot prove fleet ownership: ${path}`);
    }
    const expectedPath = installManifestPath(parsed.targetRoot, parsed.adapter, {
      installationType: parsed.installationType,
      stateKey: parsed.stateKey,
    });
    if (resolve(expectedPath) !== resolve(path)) {
      throw new Error(`Install manifest state identity does not match its canonical path: ${path}`);
    }
    found.push({ path, raw, manifest: { ...parsed, revision: computeManifestRevision(raw), legacy: false } });
  }
  return found;
}

interface RelevantGraphLock {
  path: string;
  lock: GraphLock;
  digest: string;
  allRootsSelected: boolean;
  artifactIdentities: string[];
  targetKey: string;
  adapter: string;
}

async function relevantGraphLocks(
  workspaceRoot: string,
  selected: Set<string>,
  targetKeys?: Set<string>,
  include?: (candidate: RelevantGraphLock) => Promise<boolean>,
): Promise<RelevantGraphLock[]> {
  const root = join(workspaceRoot, ".agentwheel", "locks");
  if (!(await pathExists(root))) return [];
  const results: RelevantGraphLock[] = [];
  for (const path of await listFiles(root)) {
    if (!path.endsWith(".graph-lock.json")) continue;
    const lock = await readGraphLock(path);
    if (!lock.canonical.roots.some((candidate) => selected.has(candidate.rootId))) continue;
    const parts = relative(root, path).split(/[\\/]/);
    if (parts.length !== 3) throw new Error(`Graph lock path is not canonical: ${path}`);
    const [targetKey, adapter, fileName] = parts as [string, string, string];
    if (targetKeys && !targetKeys.has(targetKey)) continue;
    const pathFingerprint = basename(fileName, ".graph-lock.json");
    if (!lock.canonical.targetFingerprint || lock.canonical.targetFingerprint !== pathFingerprint) {
      throw new Error(`Graph lock fingerprint does not match its canonical path: ${path}`);
    }
    const candidate: RelevantGraphLock = {
      path,
      lock,
      digest: "",
      allRootsSelected: lock.canonical.roots.every((rootEntry) => selected.has(rootEntry.rootId)),
      artifactIdentities: [],
      targetKey,
      adapter,
    };
    if (include && !(await include(candidate))) continue;
    const projection = relevantGraphProjection(lock, selected);
    results.push({
      ...candidate,
      digest: sha256(canonicalJson(projection)),
      artifactIdentities: lock.canonical.artifacts
        .filter((artifact) => artifact.owners.some((owner) => ownerMatchesGraphPackage(lock, owner, selected)))
        .map(graphArtifactIdentity)
        .sort(),
    });
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function isCurrentLocalTarget(scope: WorkspaceScope, graph: RelevantGraphLock): boolean {
  const agent = scope.config.agents[graph.targetKey];
  if (agent?.transport === "ssh") {
    throw new Error(`Installed-state normalization cannot hand off SSH target '${graph.targetKey}' locally.`);
  }
  return Boolean(agent) || graph.targetKey === graph.adapter;
}

async function hasRelevantLegacyManifestCandidate(
  scope: WorkspaceScope,
  graph: RelevantGraphLock,
  selected: Set<string>,
): Promise<boolean> {
  if (!isCurrentLocalTarget(scope, graph)) return false;
  // A historical graph can name a retired root.  For a configured named
  // target with an explicit installation type we can locate its legacy
  // manifest without treating that retired root as current desired state.
  // Only a manifest entry actually covered by the graph admits the lock to
  // the full, fail-closed target derivation below.
  const manifestPath = await legacyManifestPathForConfiguredTarget(scope, graph)
    ?? (await legacyTargetStateForGraph(scope, graph)).manifestPath;
  const manifest = (await collectManifestPaths([manifestPath]))[0];
  return manifest?.manifest.entries.some((entry) =>
    entryMatchesGraphPackages(entry, graph.lock, selected)) ?? false;
}

async function legacyManifestPathForConfiguredTarget(
  scope: WorkspaceScope,
  graph: RelevantGraphLock,
): Promise<string | undefined> {
  const agent = scope.config.agents[graph.targetKey];
  if (!agent || !agent.installationType) return undefined;
  if (agent.transport === "ssh") {
    throw new Error(`Installed-state normalization cannot hand off SSH target '${graph.targetKey}' locally.`);
  }
  if (agent.adapter !== graph.adapter) {
    throw new Error(`Graph adapter '${graph.adapter}' does not match configured target adapter '${agent.adapter}'.`);
  }
  const adapter = await resolveAdapter({
    adapter: agent.adapter,
    adapterConfig: agent.adapterConfig,
    adapterModule: agent.adapterModule,
    allowAdapterCode: false,
    baseDir: scope.root,
  });
  const targetRoot = resolveConfigPath(agent.root, scope.root);
  const installRoot = resolve(installRootForAdapterInstallationType(adapter, targetRoot, agent.installationType, false));
  const stateKey = stateKeyFor(adapter.name, {
    installationType: agent.installationType,
    targetFingerprint: graph.lock.canonical.targetFingerprint!,
  });
  return installManifestPath(installRoot, adapter.name, { installationType: agent.installationType, stateKey });
}

interface DerivedTargetState {
  adapter: string;
  installationType: string;
  targetRoot: string;
  installRoot: string;
  stateKey: string;
  targetFingerprint: string;
  graphLockPath: string;
  manifestPath: string;
}

async function targetStateForGraph(
  scope: WorkspaceScope,
  graph: RelevantGraphLock,
  identityFleetId: string | null = scope.fleetId ?? null,
): Promise<DerivedTargetState> {
  const agent = scope.config.agents[graph.targetKey];
  if (agent?.transport === "ssh") {
    throw new Error(`Installed-state normalization cannot hand off SSH target '${graph.targetKey}' locally.`);
  }
  if (agent && agent.adapter !== graph.adapter) {
    throw new Error(`Graph adapter '${graph.adapter}' does not match configured target adapter '${agent.adapter}'.`);
  }
  const graphPackages = graph.lock.canonical.roots.map((root) => scope.config.packages.find((pkg) => pkg.name === root.rootId));
  if (graphPackages.some((pkg) => !pkg)) {
    throw new Error(`Graph target '${graph.targetKey}' contains a package absent from the fleet configuration.`);
  }
  const packages = graphPackages as WorkspacePackage[];
  if (!agent) {
    if (graph.targetKey !== graph.adapter) {
      throw new Error(
        `Installed-state normalization cannot derive target '${graph.targetKey}' without a matching named agent; `
        + "only the ordinary direct adapter target is supported.",
      );
    }
    const packageAdapter = oneEffectiveValue(
      packages.map((pkg) => pkg.adapter ?? graph.adapter),
      `adapter for direct target '${graph.targetKey}'`,
    );
    if (packageAdapter !== graph.adapter) {
      throw new Error(`Graph adapter '${graph.adapter}' does not match direct package adapter '${packageAdapter}'.`);
    }
  }
  const installationType = oneEffectiveValue(
    packages.map((pkg) => pkg.installationType ?? agent?.installationType ?? "local"),
    `installation type for target '${graph.targetKey}'`,
  );
  const adapterConfig = oneEffectiveOptionalValue(
    packages.map((pkg) => agent?.adapterConfig ?? pkg.adapterConfig),
    `adapter config for target '${graph.targetKey}'`,
  );
  const adapterModule = oneEffectiveOptionalValue(
    packages.map((pkg) => agent?.adapterModule ?? pkg.adapterModule),
    `adapter module for target '${graph.targetKey}'`,
  );
  const adapter = await resolveAdapter({
    adapter: agent?.adapter ?? graph.adapter,
    adapterConfig,
    adapterModule,
    allowAdapterCode: false,
    baseDir: scope.root,
  });
  const targetRoot = agent ? resolveConfigPath(agent.root, scope.root) : scope.root;
  const fingerprintParts = {
    adapter: adapter.name,
    ...(identityFleetId ? { fleetId: identityFleetId } : {}),
    installationType,
    adapterConfig,
    adapterModule,
    adapterCodeHash: adapter.programmatic?.hash,
    ...(agent ? { agentName: graph.targetKey } : {}),
    targetRoot,
    transport: "local",
    ssh: undefined,
    ...(agent?.stateKey ? { stateKey: agent.stateKey } : {}),
  };
  const targetFingerprint = computeTargetFingerprint(fingerprintParts);
  const stateKey = stateKeyFor(adapter.name, {
    installationType,
    stateKey: agent?.stateKey,
    targetFingerprint,
    ...(identityFleetId ? { fleetId: identityFleetId } : {}),
  });
  const installRoot = resolve(installRootForAdapterInstallationType(adapter, targetRoot, installationType, false));
  return {
    adapter: adapter.name,
    installationType,
    targetRoot,
    installRoot,
    stateKey,
    targetFingerprint,
    graphLockPath: graphLockPathForTarget(scope.root, graph.targetKey, adapter.name, fingerprintParts),
    manifestPath: installManifestPath(installRoot, adapter.name, { installationType, stateKey }),
  };
}

async function legacyTargetStateForGraph(
  scope: WorkspaceScope,
  graph: RelevantGraphLock,
): Promise<DerivedTargetState> {
  const current = await targetStateForGraph(scope, graph, null);
  const targetFingerprint = graph.lock.canonical.targetFingerprint!;
  const stateKey = stateKeyFor(current.adapter, {
    installationType: current.installationType,
    targetFingerprint,
  });
  return {
    ...current,
    stateKey,
    targetFingerprint,
    graphLockPath: graph.path,
    manifestPath: installManifestPath(current.installRoot, current.adapter, {
      installationType: current.installationType,
      stateKey,
    }),
  };
}

function assertGraphIsSubset(source: RelevantGraphLock, destination: RelevantGraphLock): void {
  const sourceRoots = new Map(source.lock.canonical.roots.map((root) => [root.rootId, canonicalJson(root)]));
  for (const root of destination.lock.canonical.roots) {
    if (sourceRoots.get(root.rootId) !== canonicalJson(root)) {
      throw new Error(
        `Partially normalized destination graph diverges at root '${root.rootId}': ${destination.path}`,
      );
    }
  }
  const sourceArtifacts = new Set(source.lock.canonical.artifacts.map(graphArtifactIdentity));
  for (const artifact of destination.lock.canonical.artifacts) {
    if (!sourceArtifacts.has(graphArtifactIdentity(artifact))) {
      throw new Error(`Partially normalized destination graph contains divergent artifact state: ${destination.path}`);
    }
  }
}

function destinationGraphFromSource(source: GraphLock, targetFingerprint: string): GraphLock {
  const sourceFingerprint = source.canonical.targetFingerprint;
  return {
    ...source,
    canonical: {
      ...source.canonical,
      targetFingerprint,
      plainNameIncumbents: source.canonical.plainNameIncumbents.map((entry) => ({
        ...entry,
        targetFingerprint: entry.targetFingerprint === sourceFingerprint ? targetFingerprint : entry.targetFingerprint,
      })),
    },
  };
}

function mergeDestinationManifest(
  existing: CollectedManifest | undefined,
  state: DerivedTargetState,
  generatedAt: string,
  desiredEntries: InstallManifestV2["entries"],
  replaceOwners: Set<string> = new Set(),
): Record<string, unknown> {
  if (existing) {
    const manifest = existing.manifest;
    if (manifest.adapter !== state.adapter
      || manifest.installationType !== state.installationType
      || manifest.stateKey !== state.stateKey
      || resolve(manifest.targetRoot) !== state.installRoot) {
      throw new Error(`Destination manifest identity diverges from the derived target: ${existing.path}`);
    }
  }
  const entries = [...(existing?.manifest.entries ?? [])];
  for (const desired of desiredEntries) {
    const collisions = entries.filter((entry) => entry.path === desired.path);
    if (collisions.length > 1) throw new Error(`Destination manifest has ambiguous ownership for ${desired.path}.`);
    const collision = collisions[0];
    if (!collision) {
      entries.push(desired);
      continue;
    }
    if (entryIdentity(collision) !== entryIdentity(desired)) {
      throw new Error(`Destination manifest entry diverges in content, graph identity, or owner at ${desired.path}.`);
    }
    if (collision.workspaceOwner === desired.workspaceOwner) continue;
    if (!replaceOwners.has(collision.workspaceOwner)) {
      throw new Error(`Destination manifest entry diverges in content, graph identity, or owner at ${desired.path}.`);
    }
    entries[entries.indexOf(collision)] = desired;
  }
  const manifest = withManifestRevision({
    version: 2,
    adapter: state.adapter,
    installationType: state.installationType,
    stateKey: state.stateKey,
    targetRoot: state.installRoot,
    generatedAt: existing?.manifest.generatedAt ?? generatedAt,
    entries,
    revision: existing?.manifest.revision ?? "0000000000000000",
    legacy: false,
  });
  return writableManifest(manifest);
}

async function assertEquivalentRuntimeBytes(sourcePath: string, destinationPath: string, expectedHash: string): Promise<void> {
  if (!(await pathExists(sourcePath))) throw new Error(`Source runtime path is missing: ${sourcePath}`);
  if (!(await pathExists(destinationPath))) throw new Error(`Destination runtime path is missing: ${destinationPath}`);
  const [sourceHash, destinationHash] = await Promise.all([hashPath(sourcePath), hashPath(destinationPath)]);
  if (sourceHash !== expectedHash || destinationHash !== expectedHash || sourceHash !== destinationHash) {
    throw new Error(`Runtime content drift at ${destinationPath}; source and destination bytes are not equivalent.`);
  }
}

function renderedEntryPathForRoot(root: string, entryPath: string): string {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, entryPath);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Install manifest entry escapes its target root: ${entryPath}`);
  }
  return candidate;
}

function oneEffectiveValue(values: string[], label: string): string {
  const unique = sortedUnique(values);
  if (unique.length !== 1) throw new Error(`Cannot derive a single ${label}; selected package targets diverge.`);
  return unique[0]!;
}

function oneEffectiveOptionalValue(values: Array<string | undefined>, label: string): string | undefined {
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error(`Cannot derive a single ${label}; selected package targets diverge.`);
  return unique[0];
}

function relevantGraphProjection(lock: GraphLock, selected: Set<string>): unknown {
  const roots = lock.canonical.roots.filter((root) => selected.has(root.rootId));
  const nodeIds = new Set(roots.map((root) => root.graphNodeId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of lock.canonical.edges) {
      if (nodeIds.has(edge.from) && !nodeIds.has(edge.to)) {
        nodeIds.add(edge.to);
        changed = true;
      }
    }
    for (const edge of lock.canonical.includeEdges) {
      if (nodeIds.has(edge.fromNodeId) && !nodeIds.has(edge.toNodeId)) {
        nodeIds.add(edge.toNodeId);
        changed = true;
      }
    }
  }
  const artifacts = lock.canonical.artifacts.filter((artifact) =>
    artifact.owners.some((owner) => ownerMatchesGraphPackage(lock, owner, selected)));
  for (const artifact of artifacts) {
    if (artifact.owners.some((owner) => !ownerMatchesGraphPackage(lock, owner, selected))) {
      throw new Error(`Graph artifact ${artifact.logicalSelector} has partial ownership outside the selected normalization packages.`);
    }
    nodeIds.add(artifact.graphNodeId);
  }
  return {
    roots: roots.map((root) => ({
      ...root,
      selectionImport: root.selectionImport ? {
        exportHash: root.selectionImport.exportHash,
        exportName: root.selectionImport.exportName,
        extends: root.selectionImport.extends,
        inherited: root.selectionImport.inherited,
        additions: root.selectionImport.additions,
        exclusions: root.selectionImport.exclusions,
        effective: root.selectionImport.effective,
      } : undefined,
    })),
    nodes: lock.canonical.nodes.filter((node) => nodeIds.has(node.id)),
    edges: lock.canonical.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    includeEdges: lock.canonical.includeEdges.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)),
    artifacts,
    namespacing: lock.canonical.namespacing.filter((entry) => nodeIds.has(entry.graphNodeId)),
    overrides: lock.canonical.overrides.filter((entry) => nodeIds.has(entry.graphNodeId) || nodeIds.has(entry.overriddenGraphNodeId)),
    plainNameIncumbents: lock.canonical.plainNameIncumbents.filter((entry) => nodeIds.has(entry.graphNodeId))
      .map(({ targetFingerprint: _targetFingerprint, ...entry }) => entry),
  };
}

function relevantManifestEntries(
  manifests: CollectedManifest[],
  selected: Set<string>,
  owners: Set<string>,
): RelevantManifestEntry[] {
  return manifests.flatMap((manifest) => manifest.manifest.entries
    .filter((entry) => entryMatchesPackages(entry, selected) && owners.has(entry.workspaceOwner))
    .map((entry) => ({ manifest, entry, renderedPath: renderedEntryPath(manifest.manifest, entry) })));
}

function entryMatchesPackages(entry: InstallManifestV2["entries"][number], selected: Set<string>): boolean {
  return entry.owners.some((owner) => ownerMatchesPackage(owner, selected))
    || (entry.packageName ? selected.has(entry.packageName) : false);
}

function entryMatchesGraphPackages(
  entry: InstallManifestV2["entries"][number],
  lock: GraphLock,
  selected: Set<string>,
): boolean {
  return entry.owners.some((owner) => ownerMatchesGraphPackage(lock, owner, selected))
    || (entry.packageName ? selected.has(entry.packageName) : false);
}

function entryMatchesArtifacts(
  entry: InstallManifestV2["entries"][number],
  selected: Set<string> | undefined,
): boolean {
  if (!selected) return true;
  return selected.has(entry.logicalSelector ?? `${entry.artifactType}/${entry.artifactName}`)
    || selected.has(`${entry.artifactType}/${entry.artifactName}`);
}

function normalizeArtifactSelector(value: string): string {
  const selector = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(selector)) {
    throw new Error(`Invalid --artifact selector '${value}'; expected type/name.`);
  }
  return selector;
}

function ownerMatchesPackage(owner: string, selected: Set<string>): boolean {
  return selected.has(owner) || (owner.startsWith("workspace:") && selected.has(owner.slice("workspace:".length)));
}

function ownerMatchesGraphPackage(lock: GraphLock, owner: string, selected: Set<string>): boolean {
  return ownerMatchesPackage(owner, selected)
    || lock.canonical.roots.some((root) => selected.has(root.rootId) && root.graphNodeId === owner);
}

function renderedEntryPath(manifest: InstallManifestV2, entry: InstallManifestV2["entries"][number]): string {
  const root = resolve(manifest.targetRoot);
  const candidate = resolve(root, entry.path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Install manifest entry escapes its target root: ${entry.path}`);
  }
  return candidate;
}

function workspaceOwners(scope: WorkspaceScope): Set<string> {
  return new Set([
    workspaceOwnerForRoot(scope.root),
    ...(scope.fleetId ? [workspaceOwnerForRoot(scope.root, scope.fleetId)] : []),
  ]);
}

function assertSimpleVerifiableEntry(entry: InstallManifestV2["entries"][number], path: string): void {
  if (entry.semanticPlugin || entry.mergeStrategy || entry.mode) {
    throw new Error(`Installed-state normalization cannot byte-verify semantic, merge, or managed-block entry ${path}.`);
  }
  if (entry.kind !== "file" && entry.kind !== "dir") throw new Error(`Unsupported installed entry kind at ${path}.`);
}

function entryIdentity(entry: InstallManifestV2["entries"][number]): string {
  return canonicalJson({
    path: entry.path,
    artifactType: entry.artifactType,
    artifactName: entry.artifactName,
    installName: entry.installName,
    logicalSelector: entry.logicalSelector,
    graphNodeId: entry.graphNodeId,
    dependencyRole: entry.dependencyRole,
    owners: entry.owners,
    kind: entry.kind,
    hash: entry.hash,
    sourceHash: entry.sourceHash,
    channel: entry.channel,
    packageName: entry.packageName,
    composedFrom: entry.composedFrom,
  });
}

function graphArtifactIdentity(artifact: GraphLock["canonical"]["artifacts"][number]): string {
  return canonicalJson({
    graphNodeId: artifact.graphNodeId,
    type: artifact.type,
    name: artifact.name,
    installName: artifact.installName,
    logicalSelector: artifact.logicalSelector,
    dependencyRole: artifact.dependencyRole,
    owners: artifact.owners,
    kind: artifact.kind,
    sourceHash: artifact.hash,
    channel: artifact.channel,
  });
}

function graphEntryIdentity(entry: InstallManifestV2["entries"][number]): string {
  return canonicalJson({
    graphNodeId: entry.graphNodeId,
    type: entry.artifactType,
    name: entry.artifactName,
    installName: entry.installName,
    logicalSelector: entry.logicalSelector,
    dependencyRole: entry.dependencyRole,
    owners: entry.owners,
    kind: entry.kind,
    sourceHash: entry.sourceHash,
    channel: entry.channel,
  });
}

function orphanedEntryMatchesCurrentGraph(
  entry: RelevantManifestEntry,
  graph: RelevantGraphLock,
  selected: Set<string>,
): boolean {
  // Graph locks record an artifact's source-relative path, whereas manifests
  // record its adapter-rendered runtime path. For user installations those
  // bases can differ (for example `skills/foo` and `.openclaw/skills/foo`).
  // The adapter routes an artifact by type and installName, so those fields
  // are the stable destination identity. Runtime bytes are verified separately.
  return graph.lock.canonical.artifacts.some((artifact) =>
    artifact.owners.some((owner) => ownerMatchesGraphPackage(graph.lock, owner, selected))
    && artifact.type === entry.entry.artifactType
    && artifact.name === entry.entry.artifactName
    && artifact.installName === entry.entry.installName
    && artifact.kind === entry.entry.kind,
  );
}

async function readExactConfig(path: string): Promise<WorkspaceConfig> {
  return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function buildJournalManifestStates(
  plan: FleetNormalizationPlan,
  selected: Set<string>,
): Promise<JournalManifestState[]> {
  const renderedByManifest = new Map<string, Set<string>>();
  for (const transfer of plan.installedState.transfers) {
    const paths = renderedByManifest.get(transfer.sourceManifestPath) ?? new Set<string>();
    for (const path of transfer.renderedPaths) paths.add(path);
    renderedByManifest.set(transfer.sourceManifestPath, paths);
  }
  const states: JournalManifestState[] = [];
  const sourceByPath = new Map<string, { raw: Record<string, unknown>; manifest: InstallManifestV2 }>();
  for (const [path, renderedPaths] of [...renderedByManifest].sort(([a], [b]) => a.localeCompare(b))) {
    const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const parsed = installManifestSchema.parse(before);
    if (parsed.version !== 2) throw new Error(`Manifest changed to unsupported v1 state: ${path}`);
    sourceByPath.set(path, { raw: before, manifest: { ...parsed, revision: computeManifestRevision(before), legacy: false } });
    const entries = parsed.entries.filter((entry) =>
      !(entryMatchesPackages(entry, selected) && renderedPaths.has(renderedEntryPath(parsed, entry))),
    );
    const removeEmptyLegacyManifest = isLegacySelfNormalizationPlan(plan) && entries.length === 0;
    const afterManifest = removeEmptyLegacyManifest
      ? undefined
      : withManifestRevision({ ...parsed, revision: computeManifestRevision(before), legacy: false, entries });
    const after = afterManifest ? writableManifest(afterManifest) : null;
    states.push({
      path,
      before,
      after,
      beforeRevision: computeManifestRevision(before),
      afterRevision: after ? computeManifestRevision(after) : null,
    });
  }
  for (const transfer of plan.installedState.transfers) {
    const source = sourceByPath.get(transfer.sourceManifestPath);
    if (!source) throw new Error(`Source manifest disappeared before handoff: ${transfer.sourceManifestPath}`);
    if (source.manifest.revision !== transfer.sourceManifestRevision) {
      throw new Error(`Source manifest changed after planning: ${transfer.sourceManifestPath}`);
    }
    const desiredEntries = source.manifest.entries
      .filter((entry) => entryMatchesPackages(entry, selected)
        && transfer.renderedPaths.includes(renderedEntryPath(source.manifest, entry))
        && !transfer.unmanagedSourceRenderedPaths.includes(renderedEntryPath(source.manifest, entry)))
      .map((entry) => ({ ...entry, workspaceOwner: workspaceOwnerForRoot(plan.destination.root, plan.destination.fleetId) }));
    const before = await readOptionalRecord(transfer.destinationManifestPath);
    const parsedBefore = before ? installManifestSchema.parse(before) : undefined;
    if (parsedBefore && parsedBefore.version !== 2) {
      throw new Error(`Destination manifest changed to unsupported v1 state: ${transfer.destinationManifestPath}`);
    }
    const existing = parsedBefore
      ? {
          path: transfer.destinationManifestPath,
          raw: before!,
          manifest: { ...parsedBefore, revision: computeManifestRevision(before), legacy: false } as InstallManifestV2,
        }
      : undefined;
    const state: DerivedTargetState = {
      adapter: transfer.adapter,
      installationType: transfer.installationType,
      targetRoot: transfer.destinationTargetRoot,
      installRoot: transfer.destinationTargetRoot,
      stateKey: transfer.destinationStateKey,
      targetFingerprint: "journaled",
      graphLockPath: "journaled",
      manifestPath: transfer.destinationManifestPath,
    };
    const after = desiredEntries.length > 0 || existing
      ? mergeDestinationManifest(
          existing,
          state,
          source.manifest.generatedAt,
          desiredEntries,
          workspaceOwnersForPlanSource(plan),
        )
      : undefined;
    const beforeRevision = before ? computeManifestRevision(before) : null;
    const afterRevision = after ? computeManifestRevision(after) : null;
    if (beforeRevision !== transfer.destinationManifestRevision || afterRevision !== transfer.destinationManifestAfterRevision) {
      throw new Error(`Destination manifest changed after planning: ${transfer.destinationManifestPath}`);
    }
    if (transfer.sourceManifestPath === transfer.destinationManifestPath) {
      const sourceState = states.find((candidate) => candidate.path === transfer.sourceManifestPath);
      if (!sourceState) throw new Error(`Source manifest journal state is missing: ${transfer.sourceManifestPath}`);
      sourceState.after = after ?? null;
      sourceState.afterRevision = afterRevision;
    } else {
      if (after || before) states.push({ path: transfer.destinationManifestPath, before, after: after ?? null, beforeRevision, afterRevision });
    }
  }
  return states;
}

async function buildJournalGraphLockStates(plan: FleetNormalizationPlan): Promise<NormalizeJournal["graphLocks"]> {
  const states: NormalizeJournal["graphLocks"] = [];
  for (const transfer of plan.installedState.graphTransfers) {
    const sourceBefore = JSON.parse(await readFile(transfer.sourceGraphLockPath, "utf8")) as Record<string, unknown>;
    const sourceLock = await readGraphLock(transfer.sourceGraphLockPath);
    const sourceDigest = sha256(canonicalJson(sourceLock));
    if (sourceDigest !== transfer.sourceGraphLockDigest) {
      throw new Error(`Source graph lock changed after planning: ${transfer.sourceGraphLockPath}`);
    }
    if (transfer.sourceGraphLockPath === transfer.destinationGraphLockPath) {
      if (transfer.destinationGraphLockDigest !== sourceDigest
        || transfer.destinationGraphLockAfterDigest !== sourceDigest) {
        throw new Error(`Same-root graph lock changed after planning: ${transfer.sourceGraphLockPath}`);
      }
      states.push({
        path: transfer.sourceGraphLockPath,
        before: sourceBefore,
        after: sourceBefore,
        beforeDigest: sourceDigest,
        afterDigest: sourceDigest,
      });
      continue;
    }
    const destinationBefore = await readOptionalRecord(transfer.destinationGraphLockPath);
    const destinationBeforeDigest = destinationBefore
      ? sha256(canonicalJson(await readGraphLock(transfer.destinationGraphLockPath)))
      : null;
    const destinationAfter = (destinationBefore
      ? await readGraphLock(transfer.destinationGraphLockPath)
      : destinationGraphFromSource(sourceLock, transfer.targetFingerprint)) as unknown as Record<string, unknown>;
    const destinationAfterDigest = sha256(canonicalJson(destinationAfter));
    if (destinationBeforeDigest !== transfer.destinationGraphLockDigest
      || destinationAfterDigest !== transfer.destinationGraphLockAfterDigest) {
      throw new Error(`Destination graph lock changed after planning: ${transfer.destinationGraphLockPath}`);
    }
    states.push({
      path: transfer.destinationGraphLockPath,
      before: destinationBefore,
      after: destinationAfter,
      beforeDigest: destinationBeforeDigest,
      afterDigest: destinationAfterDigest,
    });
    states.push({
      path: transfer.sourceGraphLockPath,
      before: sourceBefore,
      after: null,
      beforeDigest: sourceDigest,
      afterDigest: null,
    });
  }
  return states.sort((a, b) => a.path.localeCompare(b.path));
}

async function acquireManifestLocks(transfers: FleetNormalizationManifestTransfer[]): Promise<ApplyLock[]> {
  const items: Array<{ path: string; targetRoot?: string; adapter?: string; installationType?: string; stateKey?: string }> = [];
  for (const transfer of transfers) {
    items.push({ path: transfer.sourceManifestPath });
    items.push({
      path: transfer.destinationManifestPath,
      targetRoot: transfer.destinationTargetRoot,
      adapter: transfer.adapter,
      installationType: transfer.installationType,
      stateKey: transfer.destinationStateKey,
    });
  }
  return acquireJournalManifestLocks(items);
}

async function acquireJournalManifestLocks(manifests: Array<{
  path: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  targetRoot?: string;
  adapter?: string;
  installationType?: string;
  stateKey?: string;
}>): Promise<ApplyLock[]> {
  const locks: ApplyLock[] = [];
  try {
    const unique = new Map<string, typeof manifests[number]>();
    for (const item of manifests) unique.set(item.path, item);
    for (const item of [...unique.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const raw = await readOptionalRecord(item.path) ?? item.before ?? item.after;
      if (!raw && !(item.targetRoot && item.adapter && item.installationType && item.stateKey)) {
        throw new Error(`Cannot derive an Agentwheel apply lock for missing manifest ${item.path}.`);
      }
      const manifest = raw ? installManifestSchema.parse(raw) : undefined;
      if (manifest && manifest.version !== 2) throw new Error(`Manifest lock requires v2 state: ${item.path}`);
      const targetRoot = manifest?.targetRoot ?? item.targetRoot!;
      const adapter = manifest?.adapter ?? item.adapter!;
      const installationType = manifest?.installationType ?? item.installationType!;
      const stateKey = manifest?.stateKey ?? item.stateKey!;
      const scope = { installationType, stateKey };
      const lock = await acquireApplyLock(targetRoot, adapter, undefined, {}, scope);
      locks.push(lock);
      if (await readApplyJournal(targetRoot, adapter, undefined, scope)) {
        throw new Error(`Cannot normalize while an Agentwheel apply journal is pending for ${item.path}.`);
      }
    }
    return locks;
  } catch (error) {
    await releaseLocks(locks);
    throw error;
  }
}

async function releaseLocks(locks: ApplyLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) await lock.release();
}

async function restoreJournalSource(journal: NormalizeJournal, preserveDivergentSource = false): Promise<void> {
  for (const manifest of journal.manifests) await restoreJournalFile(manifest.path, manifest.before);
  for (const graphLock of journal.graphLocks) await restoreJournalFile(graphLock.path, graphLock.before);
  const beforeRevision = configRevision(journal.sourceBefore);
  const afterRevision = configRevision(journal.sourceAfter);
  const current = await readExactConfig(journal.sourcePath);
  const revision = configRevision(current);
  if (beforeRevision === afterRevision && revision === beforeRevision) return;
  if (!preserveDivergentSource) {
    await writeJsonAtomic(journal.sourcePath, journal.sourceBefore);
    return;
  }
  if (afterRevision !== beforeRevision && revision === afterRevision) {
    await writeJsonAtomic(journal.sourcePath, journal.sourceBefore);
  }
}

async function assertJournalRecoverable(journal: NormalizeJournal): Promise<void> {
  const currentConfig = await readExactConfig(journal.sourcePath);
  const currentConfigRevision = configRevision(currentConfig);
  const acceptedConfigRevisions = new Set([configRevision(journal.sourceBefore), configRevision(journal.sourceAfter)]);
  if (!acceptedConfigRevisions.has(currentConfigRevision)) {
    throw new Error("Cannot recover fleet normalization because source config changed outside the recorded transaction.");
  }
  const currentDestinationConfig = await readExactConfig(journal.destinationPath);
  if (configRevision(currentDestinationConfig) !== configRevision(journal.destinationBefore)) {
    throw new Error("Cannot recover fleet normalization because destination config changed outside the recorded transaction.");
  }
  for (const manifest of journal.manifests) {
    const raw = await readOptionalRecord(manifest.path);
    const revision = raw ? computeManifestRevision(raw) : null;
    if (revision !== manifest.beforeRevision && revision !== manifest.afterRevision) {
      throw new Error(`Cannot recover fleet normalization because manifest changed outside the transaction: ${manifest.path}`);
    }
  }
  for (const graphLock of journal.graphLocks) {
    const raw = await readOptionalRecord(graphLock.path);
    const digest = raw ? sha256(canonicalJson(await readGraphLock(graphLock.path))) : null;
    if (digest !== graphLock.beforeDigest && digest !== graphLock.afterDigest) {
      throw new Error(`Cannot recover fleet normalization because graph lock changed outside the transaction: ${graphLock.path}`);
    }
  }
}

function workspaceOwnersForPlanSource(plan: FleetNormalizationPlan): Set<string> {
  return new Set([
    workspaceOwnerForRoot(plan.source.root),
    ...(plan.source.fleetId ? [workspaceOwnerForRoot(plan.source.root, plan.source.fleetId)] : []),
    ...(plan.request.orphanedOwnerRoots ?? []).map((root) => workspaceOwnerForRoot(root)),
  ]);
}

async function readOptionalRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function restoreJournalFile(path: string, before: Record<string, unknown> | null): Promise<void> {
  if (before) await writeJsonAtomic(path, before);
  else await rm(path, { force: true });
}

async function readNormalizeJournal(path: string): Promise<NormalizeJournal> {
  const value = JSON.parse(await readFile(path, "utf8")) as NormalizeJournal;
  if (value.version !== 1 || !value.sourcePath || !Array.isArray(value.manifests) || !Array.isArray(value.graphLocks)) {
    throw new Error(`Invalid fleet normalization journal at ${path}.`);
  }
  return value;
}

function writableManifest(manifest: InstallManifestV2): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete value.legacy;
  return value;
}

function assertCurrentDigest(expected: string, current: string): void {
  if (current !== expected) throw new Error(`Fleet normalization plan is stale or changed: expected ${expected}, found ${current}. Re-plan.`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function packageMap(config: WorkspaceConfig): Map<string, WorkspacePackage> {
  const result = new Map<string, WorkspacePackage>();
  for (const pkg of config.packages) {
    if (result.has(pkg.name)) throw new Error(`Duplicate package declaration '${pkg.name}' in ${config.schemaVersion} config.`);
    result.set(pkg.name, pkg);
  }
  return result;
}

function configRevision(config: WorkspaceConfig): string {
  return sha256(canonicalJson(config));
}

function normalizationJournalPath(sourceRoot: string, destinationFleet: string): string {
  return join(sourceRoot, ".agentwheel", `fleet-normalize-${destinationFleet}.journal.json`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid plan digest: ${value}`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
