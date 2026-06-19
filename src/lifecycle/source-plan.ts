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
import { resolvePackageSource } from "../registry/client.js";
import { RegistryClient } from "../registry/client.js";
import { resolveDependencyGraph, type GraphRootRequest, type ResolvedGraph } from "../resolve/graph.js";
import { diffGraphLocks } from "../resolve/graph-diff.js";
import { renderGraphForTarget } from "../resolve/render.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource, type StagedBundle } from "../staging/staging.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { pathExists } from "../utils/fs.js";
import { assertTrustArtifactPolicy, evaluateTransitiveTrust, normalizeTrustPolicy, readTrustedSources, rememberTrustedSources } from "./trust.js";
import { readMergedWorkspaceConfig } from "../model/workspace.js";

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
  const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedSource));
  const bundle = await stageSource(driver, resolvedSource, {
    workspaceRoot,
    adapter: options.adapter,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: options.mode,
    frozenLock: lockMode,
    select: options.select,
    skills: options.skills,
  });
  const transport = options.transport ?? localTransport;
  const requestedInstallationType = options.installationType ?? defaultInstallationType;
  const installationType = resolveInstallationTypeForArtifacts(options.adapter, bundle.artifacts.map((artifact) => artifact.type), requestedInstallationType);
  const installRoot = installRootForArtifacts(options.adapter, options.targetRoot, installationType, bundle.artifacts.map((artifact) => artifact.type));
  const stateKey = options.stateKey ?? stateKeyFor(options.adapter.name, { installationType });
  const manifest = await readInstallManifest(installRoot, options.adapter.name, transport, { installationType, stateKey });
  const plan = await createInstallPlan(bundle, options.adapter, options.targetRoot, manifest, transport, {
    workspaceOwner: workspaceOwnerId(workspaceRoot),
    installationType,
    stateKey,
    forceDrift: options.forceDrift,
    forceConflict: options.forceConflict,
    replaceConflict: options.replaceConflict,
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
    installationType,
    targetRoot: options.targetRoot,
    transport: transport.kind,
    transportDescription: transport.description,
  });
  const stateKey = options.stateKey ?? stateKeyFor(options.adapter.name, { installationType, targetFingerprint });
  const installRoot = installRootForAdapterInstallationType(options.adapter, options.targetRoot, installationType);
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
  const desiredArtifacts = desiredArtifactsFromGraphBundle(bundle);
  const resolvedInstallationType = resolveInstallationTypeForArtifacts(options.adapter, desiredArtifacts.map((artifact) => artifact.type), installationType);
  const resolvedInstallRoot = installRootForArtifacts(options.adapter, options.targetRoot, resolvedInstallationType, desiredArtifacts.map((artifact) => artifact.type));
  const graphLockDigest = digestGraphLock(bundle.graphLock);
  const graphDiff = diffGraphLocks(previousLock, bundle.graphLock);
  const manifest = await readInstallManifest(resolvedInstallRoot, options.adapter.name, transport, { installationType: resolvedInstallationType, stateKey });
  const plan = await createCombinedInstallPlan(desiredArtifacts, options.adapter, options.targetRoot, manifest, transport, {
    baseRevision: manifest?.revision ?? null,
    graphLockDigest,
    workspaceOwner: workspaceOwnerId(workspaceRoot),
    installationType: resolvedInstallationType,
    stateKey,
    forceDrift: options.forceDrift,
    forceConflict: options.forceConflict,
    replaceConflict: options.replaceConflict,
  });
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

function pathForGraphLock(workspaceRoot: string, targetKey: string, adapter: string, targetFingerprint: string): string {
  return join(workspaceRoot, ".agentwheel", "locks", sanitizePathSegment(targetKey), sanitizePathSegment(adapter), `${targetFingerprint}.graph-lock.json`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

function digestGraphLock(lock: ResolvedGraphBundle["graphLock"]): string {
  return createHash("sha256").update(canonicalGraphLockJson(lock)).digest("hex");
}

function workspaceOwnerId(workspaceRoot: string): string {
  return `workspace-root:${resolve(workspaceRoot)}`;
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
  if (mismatches.length > 0) {
    throw new Error(`${label} would change graph nodes:\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  }
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
