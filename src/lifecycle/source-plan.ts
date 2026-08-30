import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import { defaultInstallationType, installRootForAdapterInstallationType, installRootForArtifacts, resolveInstallationTypeForArtifacts } from "../model/adapter.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import { canonicalGraphLockJson, computeTargetFingerprint, readGraphLock, writeGraphLock, type GraphLock } from "../model/graph-lock.js";
import { createCombinedInstallPlan, createInstallPlan, readInstallManifest, recoverPendingApply } from "../install/index.js";
import { stateKeyFor } from "../install/paths.js";
import type { DesiredArtifact } from "../install/desired.js";
import type { InstallPlan } from "../install/plan.js";
import { readApplyJournal } from "../install/transaction.js";
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
import { listInstallManifests } from "../install/manifest.js";
import { createExactMcpRetirementPlan } from "./mcp-retirement.js";

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
  const workspaceRoot = options.workspaceRoot ?? options.targetRoot;
  const transport = options.transport ?? localTransport;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    options.warn?.(message);
  };
  const installationType = options.installationType ?? resolveInstallationTypeForAdapterTarget(options.adapter);
  const targetFingerprint = computeTargetFingerprint(options.targetFingerprintParts ?? {
    adapter: options.adapter.name,
    fleetId: options.fleetId,
    installationType,
    targetRoot: options.targetRoot,
    transport: transport.kind,
    transportDescription: transport.description,
  });
  const stateKey = stateKeyFor(options.adapter.name, {
    installationType,
    stateKey: options.stateKey,
    targetFingerprint,
    fleetId: options.fleetId,
  });
  const installRoot = installRootForAdapterInstallationType(options.adapter, options.targetRoot, installationType, transport.kind === "ssh");
  const recoveredPendingApply = options.readOnly === true
    ? false
    : await recoverPendingApplyIfSafe(installRoot, options.adapter.name, transport, { installationType, stateKey });
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
  const graphLockPath = pathForGraphLock(workspaceRoot, options.targetKey ?? "default", options.adapter.name, targetFingerprint);
  const previousLock = await readExistingGraphLock(graphLockPath);
  const registryClient = new RegistryClient({ workspaceRoot, offline: lockMode, offlineLabel: lockLabel, warn });
  const graph = await resolveDependencyGraph(options.roots, {
    workspaceRoot,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
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
  const manifest = await readInstallManifest(resolvedInstallRoot, options.adapter.name, transport, { installationType: resolvedInstallationType, stateKey });
  const workspaceOwner = workspaceOwnerForRoot(workspaceRoot, options.fleetId);
  const plan = options.retireExactMcp
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
        warn,
      });
  if (options.forceForeignState !== true && options.deferForeignStateCheck !== true) {
    await assertNoForeignWorkspaceState({
      installRoot: resolvedInstallRoot,
      adapter: options.adapter.name,
      transport,
      workspaceRoot,
      workspaceOwner,
      globalRoot: options.globalRoot,
      stateKey,
      plannedPaths: plan.operations.map((operation) => operation.relativeDestPath),
    });
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
    plannedPaths: options.plannedPaths ?? plan.operations.map((operation) => operation.relativeDestPath),
  });
}

export async function writeGraphSourceLock(result: GraphSourcePlanResult): Promise<void> {
  await mkdir(dirname(result.graphLockPath), { recursive: true });
  await writeGraphLock(result.graphLockPath, result.bundle.graphLock);
}

export function graphLockPathForTarget(workspaceRoot: string, targetKey: string, adapter: string, targetFingerprintParts: unknown): string {
  return pathForGraphLock(workspaceRoot, targetKey, adapter, computeTargetFingerprint(targetFingerprintParts));
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

const workspaceOwnerPrefix = "workspace-root:";

interface ForeignStateCheck {
  installRoot: string;
  adapter: string;
  transport: TargetTransport;
  workspaceRoot: string;
  workspaceOwner: string;
  globalRoot?: string;
  stateKey: string;
  plannedPaths: string[];
}

interface ForeignStateOwner {
  owner: string;
  fileName: string;
  entryCount: number;
  collidingPaths: string[];
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
async function assertNoForeignWorkspaceState(check: ForeignStateCheck): Promise<void> {
  const planned = new Set(check.plannedPaths);
  if (planned.size === 0) return;

  const manifests = await listInstallManifests(check.installRoot, check.adapter, check.transport);
  const root = resolve(check.workspaceRoot);
  const ownsSubWorkspaces = root !== globalConfigRoot(check.globalRoot);
  const foreign: ForeignStateOwner[] = [];

  for (const entry of manifests) {
    if (entry.stateKey === check.stateKey) continue;
    const byOwner = new Map<string, { entryCount: number; collidingPaths: string[] }>();
    for (const manifestEntry of entry.manifest.entries) {
      const owner = "workspaceOwner" in manifestEntry ? manifestEntry.workspaceOwner : undefined;
      if (typeof owner !== "string" || !owner.startsWith(workspaceOwnerPrefix)) continue;
      if (ownedByWorkspace(owner, check.workspaceOwner, root, ownsSubWorkspaces)) continue;
      const bucket = byOwner.get(owner) ?? { entryCount: 0, collidingPaths: [] };
      bucket.entryCount += 1;
      if (planned.has(manifestEntry.path)) bucket.collidingPaths.push(manifestEntry.path);
      byOwner.set(owner, bucket);
    }
    for (const [owner, bucket] of byOwner) {
      if (bucket.collidingPaths.length === 0) continue;
      foreign.push({ owner, fileName: entry.fileName, ...bucket });
    }
  }

  if (foreign.length === 0) return;

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
