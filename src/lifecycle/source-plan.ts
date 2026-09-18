import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import { defaultInstallationType, installRootForAdapterInstallationType, installRootForArtifacts, resolveInstallationTypeForArtifacts } from "../model/adapter.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import { canonicalGraphLockJson, computeTargetFingerprint, readGraphLock, writeGraphLock, type GraphLock } from "../model/graph-lock.js";
import { createCombinedInstallPlan, createInstallPlan, readInstallManifest, readSourceLock, recoverPendingApply } from "../install/index.js";
import { stateKeyFor } from "../install/paths.js";
import type { DesiredArtifact } from "../install/desired.js";
import type { InstallOperation, InstallPlan, InstallStateMigration } from "../install/plan.js";
import { assertExactMergeContribution, hasMergeRemovalContent, type MergeRemoval } from "../install/merge-removal.js";
import { listApplyJournals, readApplyJournal } from "../install/transaction.js";
import { resolvePackageSource, selectorsFromRegistryEntry } from "../registry/client.js";
import { RegistryClient } from "../registry/client.js";
import { resolveDependencyGraph, type GraphRootRequest, type ResolvedGraph } from "../resolve/graph.js";
import { diffGraphLocks } from "../resolve/graph-diff.js";
import { renderGraphForTarget } from "../resolve/render.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource, type StagedBundle } from "../staging/staging.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { filterArtifactsByAdapterTargets } from "../validation/adapter-targets.js";
import { pathExists } from "../utils/fs.js";
import { filterArtifactsByInstallFormat } from "../validation/artifacts.js";
import { assertTrustArtifactPolicy, evaluateTransitiveTrust, normalizeTrustPolicy, readTrustedSources, rememberTrustedSources } from "./trust.js";
import { globalWorkspaceConfigPath, readMergedWorkspaceConfig } from "../model/workspace.js";
import { normalizeArtifactSelectors } from "../model/selection.js";
import { parseWorkspaceOwner, workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { computeSourceLockRevision, listInstallManifests } from "../install/manifest.js";
import { installManifestV2Schema, type InstallManifest, type InstallManifestEntry, type InstallManifestV2, type SourceLock } from "../model/manifest.js";
import { createExactMcpRetirementPlan } from "./mcp-retirement.js";
import { resolveWorkspaceOwnershipScope } from "../model/fleet.js";
import { resolveTargetStateIdentity } from "../model/target-state.js";

export interface SourcePlanOptions {
  source: string;
  targetRoot: string;
  workspaceRoot?: string;
  adapter: AdapterConfig;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skills?: string[];
  transport?: TargetTransport;
  frozenLock?: boolean;
  offline?: boolean;
  warn?: (message: string) => void;
  installationType?: string;
  stateKey?: string;
  forceDrift?: boolean;
  forceConflict?: boolean;
  replaceConflict?: boolean;
  fleetId?: string;
}

export interface SourcePlanResult {
  plan: InstallPlan;
  bundle: StagedBundle;
  resolvedSource: string;
  registryEntryName?: string;
}

export interface GraphSourcePlanOptions {
  roots: GraphRootRequest[];
  targetRoot: string;
  workspaceRoot?: string;
  adapter: AdapterConfig;
  transport?: TargetTransport;
  targetKey?: string;
  targetFingerprintParts?: unknown;
  noDeps?: boolean;
  includeSuggestions?: boolean;
  suggestionAliases?: string[];
  dependencyUpdateSelectors?: string[];
  lockedResolution?: boolean;
  frozenLock?: boolean;
  offline?: boolean;
  yes?: boolean;
  trustPatterns?: string[];
  readOnly?: boolean;
  isTTY?: boolean;
  promptTrust?: (sources: string[]) => Promise<boolean>;
  warn?: (message: string) => void;
  trustStorePath?: string;
  globalRoot?: string;
  installationType?: string;
  stateKey?: string;
  forceDrift?: boolean;
  forceConflict?: boolean;
  replaceConflict?: boolean;
  retireExactMcp?: boolean;
  expectedFromWorkspaceOwner?: string;
  forceForeignState?: boolean;
  deferForeignStateCheck?: boolean;
  fleetId?: string;
  cacheRoot?: string;
  registryCachePath?: string;
  freshGraphOnly?: boolean;
}

export interface GraphSourcePlanResult {
  plan: InstallPlan;
  graph: ResolvedGraph;
  bundle: ResolvedGraphBundle;
  desiredArtifacts: DesiredArtifact[];
  graphLockPath: string;
  graphLockDigest: string;
  targetFingerprint: string;
  warnings: string[];
  newTransitiveSources: string[];
  graphDiff: string[];
  recoveredPendingApply: boolean;
  previousManifest?: InstallManifest;
  previousGraphLock?: GraphLock;
  foreignStateObservations: ForeignStateObservation[];
}

export interface ForeignStateObservation {
  stateKey: string;
  fileName: string;
  manifestRevision: string;
  workspaceOwner: string;
  path: string;
  graphNodeId?: string;
  logicalSelector?: string;
}

export async function createSourcePlan(options: SourcePlanOptions): Promise<SourcePlanResult> {
  const workspaceRoot = options.workspaceRoot ?? options.targetRoot;
  const lockMode = options.frozenLock === true || options.offline === true;
  const resolvedInput = await resolvePackageSource(options.source, workspaceRoot, { offline: lockMode, warn: options.warn });
  const resolvedSource = resolvedInput.source;
  const selectedArtifacts = normalizeArtifactSelectors(options.select, options.skills) ?? selectorsFromRegistryEntry(resolvedInput.registryEntry);
  const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedSource));
  const bundle = await stageSource(driver, resolvedSource, {
    workspaceRoot,
    adapter: options.adapter,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: options.mode,
    frozenLock: lockMode,
    select: selectedArtifacts,
  });
  const transport = options.transport ?? localTransport;
  const requestedInstallationType = options.installationType ?? defaultInstallationType;
  const formatCompatibleArtifacts = await filterArtifactsByInstallFormat(bundle.artifacts, options.adapter, requestedInstallationType);
  const installRootArtifacts = filterArtifactsByAdapterTargets(formatCompatibleArtifacts, options.adapter, requestedInstallationType, { warn: options.warn });
  const installationType = resolveInstallationTypeForArtifacts(options.adapter, installRootArtifacts.map((artifact) => artifact.type), requestedInstallationType);
  const installRoot = installRootForArtifacts(options.adapter, options.targetRoot, installationType, installRootArtifacts.map((artifact) => artifact.type), transport.kind === "ssh");
  const targetFingerprint = options.fleetId
    ? computeTargetFingerprint({
        adapter: options.adapter.name,
        fleetId: options.fleetId,
        installationType,
        targetRoot: options.targetRoot,
        transport: transport.kind,
        transportDescription: transport.description,
      })
    : undefined;
  const stateKey = stateKeyFor(options.adapter.name, {
    installationType,
    stateKey: options.stateKey,
    targetFingerprint,
    fleetId: options.fleetId,
  });
  const manifest = await readInstallManifest(installRoot, options.adapter.name, transport, { installationType, stateKey });
  const plan = await createInstallPlan(bundle, options.adapter, options.targetRoot, manifest, transport, {
    workspaceOwner: workspaceOwnerForRoot(workspaceRoot, options.fleetId),
    installationType,
    stateKey,
    forceDrift: options.forceDrift,
    forceConflict: options.forceConflict,
    replaceConflict: options.replaceConflict,
    warn: options.warn,
    suppressAdapterTargetWarnings: true,
  });
  return { plan, bundle, resolvedSource, registryEntryName: resolvedInput.registryEntry?.name };
}

export async function createGraphSourcePlan(options: GraphSourcePlanOptions): Promise<GraphSourcePlanResult> {
  if (options.roots.length === 0) {
    throw new Error("At least one source is required for a graph plan.");
  }
  if (options.freshGraphOnly && options.readOnly !== true) {
    throw new Error("Fresh graph recovery is read-only and cannot be used for install planning.");
  }
  const workspaceRoot = options.workspaceRoot ?? options.targetRoot;
  const transport = options.transport ?? localTransport;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    options.warn?.(message);
  };
  const installationType = options.installationType ?? resolveInstallationTypeForAdapterTarget(options.adapter);
  const targetFingerprintParts = options.targetFingerprintParts ?? {
    adapter: options.adapter.name,
    fleetId: options.fleetId,
    installationType,
    targetRoot: options.targetRoot,
    transport: transport.kind,
    transportDescription: transport.description,
  };
  const installRoot = installRootForAdapterInstallationType(options.adapter, options.targetRoot, installationType, transport.kind === "ssh");
  const targetIdentity = resolveTargetStateIdentity({
    targetFingerprintParts,
    workspaceRoot,
    targetKey: options.targetKey ?? "default",
    resolvedInstallRoot: installRoot,
    transportKind: transport.kind,
  });
  const targetFingerprint = targetIdentity.targetFingerprint;
  const stateKey = stateKeyFor(options.adapter.name, {
    installationType,
    stateKey: options.stateKey,
    targetFingerprint: targetIdentity.stateFingerprint,
    fleetId: options.fleetId,
  });
  const graphLockPath = pathForGraphLock(
    workspaceRoot,
    options.targetKey ?? "default",
    options.adapter.name,
    targetIdentity.stateFingerprint,
  );
  const ownership = await resolveWorkspaceOwnershipScope(workspaceRoot, {
    fleetId: options.fleetId,
    globalRoot: options.globalRoot,
  });
  const workspaceOwner = workspaceOwnerForRoot(ownership.root, ownership.fleetId);
  let recoveredPendingApply = false;
  if (options.readOnly !== true) {
    const pendingJournal = await discoverTargetApplyJournal({
      adapter: options.adapter.name,
      installationType,
      stateKey,
      explicitStateKey: options.stateKey,
      fleetId: options.fleetId,
      installRoot,
      workspaceOwner,
      graphLockPath,
      transport,
    });
    if (pendingJournal) {
      recoveredPendingApply = await recoverPendingApplyIfSafe(
        installRoot,
        options.adapter.name,
        transport,
        { installationType, stateKey: pendingJournal.stateKey },
      );
    }
  }
  const workspaceConfig = await readMergedWorkspaceConfig(workspaceRoot, { globalRoot: options.globalRoot });
  const trustPolicy = {
    ...normalizeTrustPolicy(workspaceConfig.trust),
    acceptedSources: await readTrustedSources(workspaceRoot, options.trustStorePath),
  };
  const lockMode = options.frozenLock === true || options.offline === true;
  const lockLabel = options.offline === true
    ? "Offline"
    : options.frozenLock === true
      ? "Frozen lock"
      : options.lockedResolution === true
        ? "Locked install"
        : "Fresh resolve";
  const readPriorState = async () => {
    const [stableManifest, stableLock, stableSourceLock] = await Promise.all([
      readInstallManifest(installRoot, options.adapter.name, transport, { installationType, stateKey }),
      readExistingGraphLock(graphLockPath),
      readSourceLock(installRoot, options.adapter.name, transport, { installationType, stateKey }),
    ]);
    const priorState = await resolvePriorTargetState({
      adapter: options.adapter.name,
      installationType,
      stateKey,
      explicitStateKey: options.stateKey,
      fleetId: options.fleetId,
      installRoot,
      workspaceOwner,
      graphLockPath,
      stableManifest,
      stableLock,
      transport,
    });
    return { priorState, stableLock, stableSourceLock };
  };
  // Evidence-only recovery must resolve current sources even when historical state is inconsistent.
  // The caller inventories that state separately; it cannot authorize install planning here.
  const { priorState, stableLock, stableSourceLock } = options.freshGraphOnly
    ? { priorState: {} as PriorTargetState, stableLock: undefined, stableSourceLock: undefined }
    : await readPriorState();
  const previousLock = priorState.graphLock;
  const registryClient = new RegistryClient({ workspaceRoot, cachePath: options.registryCachePath, offline: lockMode, offlineLabel: lockLabel, warn });
  const graph = await resolveDependencyGraph(options.roots, {
    workspaceRoot,
    cacheRoot: options.cacheRoot ?? join(workspaceRoot, ".agentwheel", "cache"),
    registryClient,
    noDeps: options.noDeps,
    includeSuggestions: options.includeSuggestions,
    suggestionAliases: options.suggestionAliases,
    dependencyUpdateSelectors: options.dependencyUpdateSelectors,
    lockedResolution: options.lockedResolution,
    frozenLock: lockMode,
    offline: options.offline,
    previousLock,
    warn,
    runtime: options.adapter.name,
  });
  assertFrozenGraph(previousLock, graph, lockMode, lockLabel);
  assertTrustArtifactPolicy(graph, trustPolicy);
  const trustEvaluation = evaluateTransitiveTrust(graph, previousLock, trustPolicy, options.trustPatterns ?? [], options.yes === true);
  await assertTrusted(trustEvaluation.promptSources, options);
  const persistedTrustSources = options.readOnly === true
    ? []
    : await rememberTrustedSources(workspaceRoot, trustEvaluation.persistSources, options.trustStorePath);
  for (const source of persistedTrustSources) warn(`remembered trusted transitive source: ${source}`);
  const bundle = await renderGraphForTarget(graph, {
    workspaceRoot,
    adapter: options.adapter,
    installationType,
    targetFingerprint,
    noDeps: options.noDeps,
    warn,
  });
  const desiredArtifacts = filterArtifactsByAdapterTargets(
    desiredArtifactsFromGraphBundle(bundle),
    options.adapter,
    installationType,
    { warn },
  );
  const resolvedInstallationType = resolveInstallationTypeForArtifacts(options.adapter, desiredArtifacts.map((artifact) => artifact.type), installationType);
  const resolvedInstallRoot = installRootForArtifacts(options.adapter, options.targetRoot, resolvedInstallationType, desiredArtifacts.map((artifact) => artifact.type), transport.kind === "ssh");
  const graphLockDigest = digestGraphLock(bundle.graphLock);
  const graphDiff = diffGraphLocks(previousLock, bundle.graphLock);
  if (normalizeInstallRoot(resolvedInstallRoot, transport.kind) !== normalizeInstallRoot(installRoot, transport.kind)) {
    throw new Error(
      `Adapter ${options.adapter.name} resolved a different install root after rendering; target state identity cannot be proven.`,
    );
  }
  const manifest = priorState.manifest;
  const basePlan = options.retireExactMcp
    ? await createExactMcpRetirementPlan(
        desiredArtifacts,
        options.adapter,
        options.targetRoot,
        manifest,
        transport,
        {
          installationType: resolvedInstallationType,
          stateKey,
          workspaceOwner,
          expectedFromWorkspaceOwner: options.expectedFromWorkspaceOwner,
          graphLockDigest,
        },
      )
    : await createCombinedInstallPlan(desiredArtifacts, options.adapter, options.targetRoot, manifest, transport, {
        baseRevision: manifest?.revision ?? null,
        graphLockDigest,
        workspaceOwner,
        installationType: resolvedInstallationType,
        stateKey,
        forceDrift: options.forceDrift,
        forceConflict: options.forceConflict,
        replaceConflict: options.replaceConflict,
        stateMigration: priorState.migration,
        warn,
      });
  const plan = priorState.migration && !basePlan.stateMigration
    ? { ...basePlan, stateMigration: priorState.migration }
    : basePlan;
  plan.targetStateFilePreconditions = {
    graphLockPath,
    graphLockRevision: stableLock ? digestGraphLock(stableLock) : null,
    sourceLockRevision: computeSourceLockRevision(stableSourceLock),
  };
  let foreignStateObservations: ForeignStateObservation[] = [];
  if (options.forceForeignState !== true && options.deferForeignStateCheck !== true) {
    foreignStateObservations = await assertNoForeignWorkspaceState({
      installRoot: resolvedInstallRoot,
      adapter: options.adapter.name,
      transport,
      workspaceRoot,
      workspaceOwner,
      globalRoot: options.globalRoot,
      stateKey,
      migratingStateKey: priorState.migration?.fromStateKey,
      plannedPaths: plan.operations.map((operation) => operation.relativeDestPath),
      plannedOperations: plan.operations,
    });
    plan.hasBlockingChanges = plan.operations.some((operation) => operation.action === "drift" || operation.action === "conflict");
  }

  return {
    plan,
    graph,
    bundle,
    desiredArtifacts,
    graphLockPath,
    graphLockDigest,
    targetFingerprint,
    warnings,
    newTransitiveSources: trustEvaluation.promptSources,
    graphDiff,
    recoveredPendingApply,
    previousManifest: priorState.manifest,
    previousGraphLock: priorState.graphLock,
    foreignStateObservations,
  };
}

export async function assertNoForeignWorkspaceStateForPlan(
  plan: InstallPlan,
  options: {
    transport?: TargetTransport;
    workspaceRoot: string;
    workspaceOwner: string;
    globalRoot?: string;
    plannedPaths?: string[];
  },
): Promise<void> {
  if (!plan.stateKey) throw new Error(`Foreign-state validation requires a state key for ${plan.adapter}.`);
  await assertNoForeignWorkspaceState({
    installRoot: plan.targetRoot,
    adapter: plan.adapter,
    transport: options.transport ?? localTransport,
    workspaceRoot: options.workspaceRoot,
    workspaceOwner: options.workspaceOwner,
    globalRoot: options.globalRoot,
    stateKey: plan.stateKey,
    migratingStateKey: plan.stateMigration?.fromStateKey,
    plannedPaths: options.plannedPaths ?? plan.operations.map((operation) => operation.relativeDestPath),
    plannedOperations: plan.operations,
  });
  plan.hasBlockingChanges = plan.operations.some((operation) => operation.action === "drift" || operation.action === "conflict");
}

export async function writeGraphSourceLock(result: GraphSourcePlanResult): Promise<void> {
  await mkdir(dirname(result.graphLockPath), { recursive: true });
  await writeGraphLock(result.graphLockPath, result.bundle.graphLock);
}

export function graphLockPathForTarget(
  workspaceRoot: string,
  targetKey: string,
  adapter: string,
  targetFingerprintParts: unknown,
  context: { resolvedInstallRoot: string; transportKind: TargetTransport["kind"] },
): string {
  const identity = resolveTargetStateIdentity({ targetFingerprintParts, workspaceRoot, targetKey, ...context });
  return pathForGraphLock(workspaceRoot, targetKey, adapter, identity.stateFingerprint);
}

export function desiredArtifactsFromGraphBundle(bundle: ResolvedGraphBundle): DesiredArtifact[] {
  return bundle.artifacts.map((artifact) => desiredArtifactFromResolved(artifact));
}

function desiredArtifactFromResolved(artifact: ResolvedArtifact): DesiredArtifact {
  return {
    ...artifact,
    meta: {
      graphNodeId: artifact.graphNodeId,
      installName: artifact.installName,
      logicalSelector: artifact.logicalSelector,
      dependencyRole: artifact.dependencyRole,
      owners: artifact.owners,
      composedFrom: artifact.composedFrom,
    },
  };
}

async function recoverPendingApplyIfSafe(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport,
  scope: { installationType?: string; stateKey?: string },
): Promise<boolean> {
  if (!(await readApplyJournal(targetRoot, adapter, transport, scope))) return false;
  try {
    await recoverPendingApply(targetRoot, adapter, transport, scope);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Pending apply journal for ${adapter} at ${targetRoot} could not be recovered automatically: ${message}`);
  }
}

function resolveInstallationTypeForAdapterTarget(adapter: AdapterConfig): string {
  const supported = new Set<string>();
  for (const registry of Object.values(adapter.targets)) {
    for (const [installationType, target] of Object.entries(registry ?? {})) {
      if (target.enabled) supported.add(installationType);
    }
  }
  if (supported.size === 1) return [...supported][0]!;
  return "local";
}

async function readExistingGraphLock(path: string): Promise<GraphLock | undefined> {
  if (!(await pathExists(path))) return undefined;
  return readGraphLock(path);
}

export interface PriorTargetState {
  graphLock?: GraphLock;
  manifest?: InstallManifest;
  migration?: InstallStateMigration;
}

export interface PriorTargetStateOptions {
  adapter: string;
  installationType: string;
  stateKey: string;
  explicitStateKey?: string;
  fleetId?: string;
  installRoot: string;
  workspaceOwner: string;
  graphLockPath: string;
  stableManifest?: InstallManifest;
  stableLock?: GraphLock;
  transport: TargetTransport;
}

export interface TargetApplyJournalResolution {
  path: string;
  stateKey: string;
}

export async function discoverTargetApplyJournal(
  options: Omit<PriorTargetStateOptions, "stableManifest" | "stableLock">,
): Promise<TargetApplyJournalResolution | undefined> {
  const journals = await listApplyJournals(
    options.installRoot,
    options.adapter,
    options.transport,
    { installationType: options.installationType },
  );
  const correlated: TargetApplyJournalResolution[] = [];
  for (const item of journals) {
    const journal = item.journal;
    const journalStateKey = journal.stateKey
      ?? stateKeyFor(options.adapter, { installationType: options.installationType });
    if (normalizeInstallRoot(journal.targetRoot, options.transport.kind)
      !== normalizeInstallRoot(options.installRoot, options.transport.kind)) {
      continue;
    }
    if (journalStateKey === options.stateKey) {
      validateJournalManifestEnvelope(journal.manifest, options, journalStateKey, item.path);
      correlated.push({ path: item.path, stateKey: journalStateKey });
      continue;
    }
    if (!journal.graphLockPath || !journal.graphLock || !journal.graphLockDigest) continue;
    if (resolve(dirname(journal.graphLockPath)) !== resolve(dirname(options.graphLockPath))) continue;
    if (options.transport.kind === "ssh") {
      throw new Error(
        `Legacy SSH apply journal at ${item.path} does not record its original endpoint; `
        + "Agentwheel cannot prove endpoint identity, so the journal was preserved.",
      );
    }
    const suffix = ".graph-lock.json";
    const graphName = basename(journal.graphLockPath);
    if (!graphName.endsWith(suffix)) {
      throw new Error(`Legacy apply journal at ${item.path} has an invalid graph-lock path.`);
    }
    const fingerprint = graphName.slice(0, -suffix.length);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)
      || journal.graphLock.canonical.targetFingerprint !== fingerprint) {
      throw new Error(`Legacy apply journal graph-lock fingerprint does not match its path at ${item.path}.`);
    }
    const expectedStateKey = stateKeyFor(options.adapter, {
      installationType: options.installationType,
      stateKey: options.explicitStateKey,
      targetFingerprint: fingerprint,
      fleetId: options.fleetId,
    });
    if (journalStateKey !== expectedStateKey) {
      throw new Error(`Legacy apply journal state key does not match its graph lock at ${item.path}.`);
    }
    let actualGraphLock: GraphLock;
    try {
      actualGraphLock = await readGraphLock(journal.graphLockPath);
    } catch (error) {
      throw new Error(
        `Legacy apply journal graph lock is missing or invalid at ${journal.graphLockPath}: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    const embeddedDigest = digestGraphLock(journal.graphLock);
    const actualDigest = digestGraphLock(actualGraphLock);
    if (embeddedDigest !== journal.graphLockDigest || actualDigest !== journal.graphLockDigest) {
      throw new Error(`Legacy apply journal graph-lock digest mismatch at ${item.path}.`);
    }
    const manifest = validateJournalManifestEnvelope(journal.manifest, options, journalStateKey, item.path);
    validateLegacyManifestCandidate(manifest, {
      ...options,
      candidateStateKey: journalStateKey,
      graphLockDigest: journal.graphLockDigest,
      graphLockPath: journal.graphLockPath,
    });
    correlated.push({ path: item.path, stateKey: journalStateKey });
  }
  if (correlated.length > 1) {
    throw new Error(`Ambiguous apply journals for ${options.adapter}: multiple journals match the requested target state.`);
  }
  return correlated[0];
}

function validateJournalManifestEnvelope(
  value: unknown,
  options: Pick<PriorTargetStateOptions, "adapter" | "installationType" | "installRoot" | "transport">,
  stateKey: string,
  journalPath: string,
): InstallManifestV2 {
  let manifest: InstallManifestV2;
  try {
    manifest = installManifestV2Schema.parse(value);
  } catch (error) {
    throw new Error(
      `Apply journal at ${journalPath} has an invalid install manifest: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (manifest.adapter !== options.adapter
    || manifest.installationType !== options.installationType
    || manifest.stateKey !== stateKey
    || normalizeInstallRoot(manifest.targetRoot, options.transport.kind)
      !== normalizeInstallRoot(options.installRoot, options.transport.kind)) {
    throw new Error(`Apply journal target identity does not match its manifest at ${journalPath}.`);
  }
  return manifest;
}

interface LegacyStateCandidate {
  stateKey: string;
  graphLockPath: string;
  graphLockDigest: string;
  graphLock: GraphLock;
  manifest?: InstallManifestV2;
  sourceLock?: SourceLock;
}

export async function resolvePriorTargetState(options: PriorTargetStateOptions): Promise<PriorTargetState> {
  const candidates = await discoverLegacyStateCandidates(options);
  const correlated = candidates.filter((candidate) => candidate.manifest);

  if (options.stableManifest) {
    for (const candidate of correlated) {
      if (!sameManifestContributions(options.stableManifest, candidate.manifest!)) {
        throw new Error(
          `Stable and legacy target states coexist with disagreeing contributions for ${options.adapter}; reconcile them explicitly.`,
        );
      }
    }
    const sameKeyCandidates = correlated.filter((candidate) => candidate.stateKey === options.stateKey);
    if (!options.stableLock && sameKeyCandidates.length > 1) {
      throw new Error(`Ambiguous legacy target state for ${options.adapter}: multiple correlated graph locks use the explicit state key.`);
    }
    if (!options.stableLock && sameKeyCandidates.length === 1) {
      const candidate = sameKeyCandidates[0]!;
      return {
        graphLock: candidate.graphLock,
        manifest: options.stableManifest,
        migration: migrationFromCandidate(candidate),
      };
    }
    return { graphLock: options.stableLock, manifest: options.stableManifest };
  }

  if (options.stableLock && correlated.length > 0) {
    throw new Error(
      `Stable graph state and legacy manifest state coexist for ${options.adapter} without a stable manifest; reconcile them explicitly.`,
    );
  }
  if (correlated.length > 1) {
    throw new Error(`Ambiguous legacy target state for ${options.adapter}: multiple correlated manifests were found.`);
  }
  if (correlated.length === 1) {
    const candidate = correlated[0]!;
    return {
      graphLock: candidate.graphLock,
      manifest: candidate.manifest,
      migration: migrationFromCandidate(candidate),
    };
  }

  if (options.stableLock) return { graphLock: options.stableLock };
  if (candidates.length > 1) {
    throw new Error(`Ambiguous legacy target state for ${options.adapter}: multiple graph-only candidates were found.`);
  }
  if (candidates.length === 1) {
    throw new Error(
      `Legacy graph-only target state for ${options.adapter} has no correlated install manifest; `
      + "runtime identity and ownership cannot be proven, so the graph lock was preserved.",
    );
  }
  return {};
}

async function discoverLegacyStateCandidates(options: PriorTargetStateOptions): Promise<LegacyStateCandidate[]> {
  const directory = dirname(options.graphLockPath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const stableName = basename(options.graphLockPath);
  const suffix = ".graph-lock.json";
  const candidates: LegacyStateCandidate[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (name === stableName || !name.endsWith(suffix)) continue;
    const fingerprint = name.slice(0, -suffix.length);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) continue;
    const graphLockPath = join(directory, name);
    let graphLock: GraphLock;
    try {
      graphLock = await readGraphLock(graphLockPath);
    } catch (error) {
      throw new Error(
        `Legacy graph lock at ${graphLockPath} is invalid or unsupported: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (graphLock.canonical.targetFingerprint !== fingerprint) {
      throw new Error(
        `Legacy graph lock fingerprint does not match its filename at ${graphLockPath}.`,
      );
    }
    if (options.transport.kind === "ssh") {
      throw new Error(
        `Legacy SSH target state at ${graphLockPath} does not record its original endpoint; `
        + "Agentwheel cannot prove endpoint identity, so the graph lock was preserved.",
      );
    }
    const graphLockDigest = digestGraphLock(graphLock);
    const candidateStateKey = stateKeyFor(options.adapter, {
      installationType: options.installationType,
      stateKey: options.explicitStateKey,
      targetFingerprint: fingerprint,
      fleetId: options.fleetId,
    });
    let manifest: InstallManifest | undefined;
    let sourceLock: SourceLock | undefined;
    try {
      manifest = await readInstallManifest(options.installRoot, options.adapter, options.transport, {
        installationType: options.installationType,
        stateKey: candidateStateKey,
      });
      sourceLock = await readSourceLock(options.installRoot, options.adapter, options.transport, {
        installationType: options.installationType,
        stateKey: candidateStateKey,
      });
    } catch (error) {
      throw new Error(
        `Legacy target state for ${graphLockPath} is invalid: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!manifest) {
      if (sourceLock) {
        throw new Error(`Legacy source lock for ${graphLockPath} has no correlated install manifest.`);
      }
      candidates.push({ stateKey: candidateStateKey, graphLockPath, graphLockDigest, graphLock });
      continue;
    }
    const validated = validateLegacyManifestCandidate(manifest, {
      ...options,
      candidateStateKey,
      graphLockDigest,
      graphLockPath,
    });
    candidates.push({
      stateKey: candidateStateKey,
      graphLockPath,
      graphLockDigest,
      graphLock,
      manifest: validated,
      sourceLock,
    });
  }
  return candidates;
}

function validateLegacyManifestCandidate(
  manifest: InstallManifest,
  options: PriorTargetStateOptions & {
    candidateStateKey: string;
    graphLockDigest: string;
    graphLockPath: string;
  },
): InstallManifestV2 {
  if (manifest.version !== 2) {
    throw new Error(`Legacy target state for ${options.graphLockPath} requires an install manifest v2.`);
  }
  if (manifest.adapter !== options.adapter) {
    throw new Error(`Legacy target state adapter mismatch at ${options.graphLockPath}.`);
  }
  if (manifest.installationType !== options.installationType) {
    throw new Error(`Legacy target state installation type mismatch at ${options.graphLockPath}.`);
  }
  if (manifest.stateKey !== options.candidateStateKey) {
    throw new Error(`Legacy target state key mismatch at ${options.graphLockPath}.`);
  }
  if (normalizeInstallRoot(manifest.targetRoot, options.transport.kind)
    !== normalizeInstallRoot(options.installRoot, options.transport.kind)) {
    throw new Error(`Legacy target state target root mismatch at ${options.graphLockPath}.`);
  }
  const correlated = manifest.entries.filter((entry) => entry.graphLockDigest === options.graphLockDigest);
  if (correlated.length === 0) {
    throw new Error(`Legacy install manifest graph-lock digest does not match ${options.graphLockPath}.`);
  }
  if (correlated.some((entry) => entry.workspaceOwner !== options.workspaceOwner)) {
    throw new Error(`Legacy target state contribution scope does not match ${options.graphLockPath}.`);
  }
  return manifest;
}

function migrationFromCandidate(candidate: LegacyStateCandidate): InstallStateMigration {
  return {
    fromStateKey: candidate.manifest ? candidate.stateKey : undefined,
    fromGraphLockPath: candidate.graphLockPath,
    fromGraphLockDigest: candidate.graphLockDigest,
    sourceLock: candidate.manifest ? candidate.sourceLock ?? null : undefined,
  };
}

function sameManifestContributions(left: InstallManifest, right: InstallManifestV2): boolean {
  if (left.version !== 2) return false;
  return stableJson(manifestContributionState(left)) === stableJson(manifestContributionState(right));
}

function manifestContributionState(manifest: InstallManifestV2): unknown {
  return manifest.entries
    .map(({ updatedAt: _updatedAt, graphLockDigest: _graphLockDigest, ...entry }) => entry)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeInstallRoot(path: string, transportKind: TargetTransport["kind"]): string {
  return transportKind === "ssh" ? posix.normalize(path) : resolve(path);
}

const workspaceOwnerPrefix = "workspace-root:";

interface ForeignStateCheck {
  installRoot: string;
  adapter: string;
  transport: TargetTransport;
  workspaceRoot: string;
  workspaceOwner: string;
  globalRoot?: string;
  stateKey: string;
  migratingStateKey?: string;
  plannedPaths: string[];
  plannedOperations: InstallOperation[];
}

interface ForeignStateOwner {
  owner: string;
  fileName: string;
  entryCount: number;
  collidingPaths: string[];
}

interface ForeignStateCollision {
  owner: string;
  stateKey: string;
  fileName: string;
  manifestRevision: string;
  entryCount: number;
  entry: InstallManifestEntry;
}

// One runtime root legitimately holds state for several workspaces -- user-scoped installs all land
// in $HOME -- so coexistence is not the problem. The problem is a path this run would touch that a
// different workspace already owns in a manifest under another target fingerprint: this run cannot
// read that manifest, sees only a file it did not install, and calls it an unmanaged conflict.
// Refuse rather than report a classification that is known to be wrong.
//
// A workspace also owns its own sub-workspaces -- per-profile and per-rollout roots checked out
// beneath it -- so containment is the right exemption almost everywhere. The exception is the
// directory holding the global config: it is a workspace root only because that file doubles as
// one, every control plane on the machine sits beneath it, and containment there would exempt
// exactly the case this guards. Standing in it, only the workspace itself is not foreign.
async function assertNoForeignWorkspaceState(check: ForeignStateCheck): Promise<ForeignStateObservation[]> {
  const planned = new Set(check.plannedPaths);
  if (planned.size === 0) return [];
  const plannedOperations = new Map<string, InstallOperation[]>();
  for (const operation of check.plannedOperations) {
    if (!planned.has(operation.relativeDestPath)) continue;
    const operations = plannedOperations.get(operation.relativeDestPath) ?? [];
    operations.push(operation);
    plannedOperations.set(operation.relativeDestPath, operations);
  }

  const manifests = await listInstallManifests(check.installRoot, check.adapter, check.transport);
  const root = resolve(check.workspaceRoot);
  const ownsSubWorkspaces = root !== globalConfigRoot(check.globalRoot);
  const collisions = new Map<string, ForeignStateCollision[]>();

  for (const entry of manifests) {
    if (entry.stateKey === check.stateKey || entry.stateKey === check.migratingStateKey) continue;
    const entryCounts = new Map<string, number>();
    for (const manifestEntry of entry.manifest.entries) {
      const owner = "workspaceOwner" in manifestEntry ? manifestEntry.workspaceOwner : undefined;
      if (typeof owner === "string" && owner.startsWith(workspaceOwnerPrefix)) {
        entryCounts.set(owner, (entryCounts.get(owner) ?? 0) + 1);
      }
    }
    for (const manifestEntry of entry.manifest.entries) {
      const owner = "workspaceOwner" in manifestEntry ? manifestEntry.workspaceOwner : undefined;
      if (typeof owner !== "string" || !owner.startsWith(workspaceOwnerPrefix)) continue;
      if (ownedByWorkspace(owner, check.workspaceOwner, root, ownsSubWorkspaces)) continue;
      if (planned.has(manifestEntry.path)
        && !(await isDisjointVerifiedMergeContribution(
          check,
          manifestEntry.path,
          manifestEntry.mergeStrategy,
          manifestEntry.mergeRemoval,
          plannedOperations.get(manifestEntry.path) ?? [],
        ))) {
        const ownedEntry = manifestEntry as InstallManifestEntry;
        const pathCollisions = collisions.get(manifestEntry.path) ?? [];
        pathCollisions.push({
          owner,
          stateKey: entry.stateKey,
          fileName: entry.fileName,
          manifestRevision: entry.manifest.revision,
          entryCount: entryCounts.get(owner) ?? 1,
          entry: ownedEntry,
        });
        collisions.set(manifestEntry.path, pathCollisions);
      }
    }
  }

  const foreignByOwner = new Map<string, ForeignStateOwner>();
  const observations: ForeignStateObservation[] = [];
  for (const [path, pathCollisions] of collisions) {
    const operations = plannedOperations.get(path) ?? [];
    const exact = pathCollisions.length === 1
      ? await exactForeignKeepOperation(check, pathCollisions[0]!, operations)
      : undefined;
    if (exact) {
      const index = check.plannedOperations.indexOf(operations[0]!);
      if (index < 0) throw new Error(`Foreign-state reconciliation lost planned operation for ${path}.`);
      check.plannedOperations[index] = exact.operation;
      observations.push(exact.observation);
      continue;
    }
    for (const collision of pathCollisions) {
      const key = `${collision.owner}\0${collision.fileName}`;
      const bucket = foreignByOwner.get(key) ?? {
        owner: collision.owner,
        fileName: collision.fileName,
        entryCount: collision.entryCount,
        collidingPaths: [],
      };
      if (!bucket.collidingPaths.includes(path)) bucket.collidingPaths.push(path);
      foreignByOwner.set(key, bucket);
    }
  }
  const foreign = [...foreignByOwner.values()];

  if (foreign.length === 0) return observations.sort((left, right) => left.path.localeCompare(right.path));

  throw new Error([
    `Refusing to plan ${check.adapter} at ${check.installRoot}.`,
    "This runtime root already carries Agentwheel state owned by another workspace, at paths this run would install:",
    ...foreign.flatMap((item) => [
      `  ${item.owner} (${item.entryCount} entries, ${item.fileName})`,
      ...item.collidingPaths.map((path) => `    ${path}`),
    ]),
    `Current workspace: ${check.workspaceRoot} (state key ${check.stateKey})`,
    "Agentwheel keys install state by target fingerprint, so this run cannot read that manifest and",
    "would report those paths as unmanaged conflicts or drift.",
    parseWorkspaceOwner(check.workspaceOwner)?.fleetId
      ? "Reconcile the owners with an explicit agentwheel fleet normalize operation before planning this fleet."
      : "Re-run from the owning workspace, or pass --force-foreign-state to plan against it anyway.",
  ].join("\n"));
}

async function exactForeignKeepOperation(
  check: ForeignStateCheck,
  collision: ForeignStateCollision,
  operations: InstallOperation[],
): Promise<{ operation: InstallOperation; observation: ForeignStateObservation } | undefined> {
  if (operations.length !== 1) return undefined;
  const operation = operations[0]!;
  const entry = collision.entry;
  if (operation.semanticPlugin || operation.programmaticOperation || operation.mergeStrategy || operation.mode
    || entry.semanticPlugin || entry.mergeStrategy || entry.mode) return undefined;
  if (!operation.desiredHash
    || operation.artifactType !== entry.artifactType
    || operation.artifactName !== entry.artifactName
    || operation.kind !== entry.kind
    || operation.desiredHash !== entry.sourceHash) return undefined;
  const path = join(check.installRoot, entry.path);
  if (!(await check.transport.pathExists(path))) return undefined;
  const currentHash = await check.transport.hashPath(path);
  if (currentHash !== entry.hash || currentHash !== operation.desiredHash
    || (operation.currentHash !== undefined && operation.currentHash !== currentHash)) return undefined;
  return {
    operation: {
      ...operation,
      action: "keep",
      currentHash,
      manifestHash: entry.hash,
      reason: `exact foreign artifact owned by ${collision.owner}; kept outside workspace ${check.workspaceOwner}`,
      preserveInManifest: false,
    },
    observation: {
      stateKey: collision.stateKey,
      fileName: collision.fileName,
      manifestRevision: collision.manifestRevision,
      workspaceOwner: collision.owner,
      path: entry.path,
      graphNodeId: entry.graphNodeId,
      logicalSelector: entry.logicalSelector,
    },
  };
}

async function isDisjointVerifiedMergeContribution(
  check: ForeignStateCheck,
  relativePath: string,
  foreignStrategy: InstallOperation["mergeStrategy"],
  foreignRemoval: MergeRemoval | undefined,
  operations: InstallOperation[],
): Promise<boolean> {
  if (!foreignStrategy || !hasMergeRemovalContent(foreignRemoval) || operations.length !== 1) return false;
  const operation = operations[0]!;
  if (operation.mergeStrategy !== foreignStrategy || !hasMergeRemovalContent(operation.mergeRemoval)) return false;
  if (!disjointMcpMergeContributions(foreignStrategy, foreignRemoval!, operation.mergeRemoval!)) return false;
  try {
    const content = await check.transport.readFile(join(check.installRoot, relativePath));
    assertExactMergeContribution(foreignRemoval!, foreignStrategy, content);
    assertExactMergeContribution(operation.mergeRemoval!, foreignStrategy, content);
    return true;
  } catch {
    return false;
  }
}

function disjointMcpMergeContributions(
  strategy: NonNullable<InstallOperation["mergeStrategy"]>,
  left: MergeRemoval,
  right: MergeRemoval,
): boolean {
  const leftNames = mcpServerNames(strategy, left);
  const rightNames = mcpServerNames(strategy, right);
  if (!leftNames || !rightNames) return false;
  return [...leftNames].every((name) => !rightNames.has(name));
}

function mcpServerNames(
  strategy: NonNullable<InstallOperation["mergeStrategy"]>,
  removal: MergeRemoval,
): Set<string> | undefined {
  if (strategy !== "codex-toml-mcp" && strategy !== "json-deep") return undefined;
  const keys = Object.keys(removal);
  if (strategy === "json-deep" && (keys.length !== 1 || keys[0] !== "mcpServers")) return undefined;
  const servers = removal.mcpServers ?? (strategy === "codex-toml-mcp" ? removal : undefined);
  if (!servers || Array.isArray(servers) || typeof servers !== "object") return undefined;
  return new Set(Object.keys(servers));
}

function globalConfigRoot(globalRoot?: string): string {
  return dirname(dirname(globalWorkspaceConfigPath(globalRoot)));
}

function ownedByWorkspace(owner: string, desiredOwner: string, workspaceRoot: string, ownsSubWorkspaces: boolean): boolean {
  if (owner === desiredOwner) return true;
  const parsedOwner = parseWorkspaceOwner(owner);
  const parsedDesired = parseWorkspaceOwner(desiredOwner);
  if (!parsedOwner || !parsedDesired || parsedOwner.fleetId || parsedDesired.fleetId) return false;
  return ownsSubWorkspaces && parsedOwner.root.startsWith(`${workspaceRoot}/`);
}

function pathForGraphLock(workspaceRoot: string, targetKey: string, adapter: string, targetFingerprint: string): string {
  return join(workspaceRoot, ".agentwheel", "locks", sanitizePathSegment(targetKey), sanitizePathSegment(adapter), `${targetFingerprint}.graph-lock.json`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function digestGraphLock(lock: ResolvedGraphBundle["graphLock"]): string {
  return createHash("sha256").update(canonicalGraphLockJson(lock)).digest("hex");
}

function assertFrozenGraph(previousLock: GraphLock | undefined, graph: ResolvedGraph, frozen: boolean, label: string): void {
  if (!frozen) return;
  if (!previousLock) {
    throw new Error(`${label} requires an existing graph lock. Run without ${label === "Offline" ? "--offline" : "--frozen-lock"} first.`);
  }
  const lockedByKey = new Map(previousLock.canonical.nodes.map((node) => [`${node.normalizedSource}\0${node.name}`, node]));
  const mismatches: string[] = [];
  for (const node of graph.nodes) {
    const locked = lockedByKey.get(`${node.normalizedSource}\0${node.name}`);
    if (!locked) {
      mismatches.push(`${node.id}: new source ${node.normalizedSource}`);
      continue;
    }
    if (locked.version !== node.version) {
      mismatches.push(`${node.id}: version ${locked.version} -> ${node.version}`);
    }
    if (locked.sourceHash !== node.sourceHash) {
      mismatches.push(`${node.id}: sourceHash ${locked.sourceHash} -> ${node.sourceHash}`);
    }
  }
  const lockedRoots = new Map(previousLock.canonical.roots.map((root) => [root.rootId, root]));
  const graphRootIds = new Set(graph.roots.map((root) => root.rootId));
  for (const root of graph.roots) {
    const locked = lockedRoots.get(root.rootId);
    if (!locked) {
      mismatches.push(`${root.rootId}: new graph root`);
      continue;
    }
    if (selectionImportKey(locked.selectionImport) !== selectionImportKey(root.selectionImport)) {
      mismatches.push(`${root.rootId}: selection import changed`);
    }
    if (selectorKey(locked.selected) !== selectorKey(root.selected)) {
      mismatches.push(`${root.rootId}: selected artifacts changed`);
    }
  }
  for (const root of previousLock.canonical.roots) {
    if (!graphRootIds.has(root.rootId)) {
      mismatches.push(`${root.rootId}: removed graph root`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`${label} would change graph nodes:\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  }
}

function selectionImportKey(selection: ResolvedGraph["roots"][number]["selectionImport"] | GraphLock["canonical"]["roots"][number]["selectionImport"]): string {
  if (!selection) return "";
  return JSON.stringify({
    configPath: selection.configPath,
    configHash: selection.configHash,
    exportHash: selection.exportHash,
    exportName: selection.exportName,
    extends: selection.extends,
    inherited: sortedUnique(selection.inherited),
    additions: sortedUnique(selection.additions),
    exclusions: sortedUnique(selection.exclusions),
    effective: sortedUnique(selection.effective),
  });
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function selectorKey(selectors: string[]): string {
  return sortedUnique(selectors).join("\0");
}

async function assertTrusted(sources: string[], options: GraphSourcePlanOptions): Promise<void> {
  if (sources.length === 0) return;
  if (options.readOnly === true) {
    throw new Error(`New transitive sources require trust. Re-run with --yes or --trust <pattern>:\n${sources.map((source) => `- ${source}`).join("\n")}`);
  }
  if (options.promptTrust) {
    if (await options.promptTrust(sources)) return;
    throw new Error(`Untrusted transitive sources:\n${sources.map((source) => `- ${source}`).join("\n")}`);
  }
  if (options.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question(`Trust new transitive sources?\n${sources.map((source) => `- ${source}`).join("\n")}\nType yes to continue: `);
      if (answer.trim().toLowerCase() === "yes") return;
    } finally {
      readline.close();
    }
  }
  throw new Error(`New transitive sources require trust. Re-run with --yes or --trust <pattern>:\n${sources.map((source) => `- ${source}`).join("\n")}`);
}
