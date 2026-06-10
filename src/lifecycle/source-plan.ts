import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import { canonicalGraphLockJson, computeTargetFingerprint, readGraphLock, writeGraphLock, type GraphLock } from "../model/graph-lock.js";
import { createCombinedInstallPlan, createInstallPlan, readInstallManifest, recoverPendingApply } from "../install/index.js";
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
  frozenLock?: boolean;
  offline?: boolean;
  yes?: boolean;
  trustPatterns?: string[];
  isTTY?: boolean;
  promptTrust?: (sources: string[]) => Promise<boolean>;
  warn?: (message: string) => void;
  trustStorePath?: string;
  globalRoot?: string;
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
  const manifest = await readInstallManifest(options.targetRoot, options.adapter.name, transport);
  const plan = await createInstallPlan(bundle, options.adapter, options.targetRoot, manifest, transport);
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
  const recoveredPendingApply = await recoverPendingApplyIfSafe(options.targetRoot, options.adapter.name, transport);
  const workspaceConfig = await readMergedWorkspaceConfig(workspaceRoot, { globalRoot: options.globalRoot });
  const trustPolicy = {
    ...normalizeTrustPolicy(workspaceConfig.trust),
    acceptedSources: await readTrustedSources(workspaceRoot, options.trustStorePath),
  };
  const lockMode = options.frozenLock === true || options.offline === true;
  const lockLabel = options.offline === true ? "Offline" : "Frozen lock";
  const targetFingerprint = computeTargetFingerprint(options.targetFingerprintParts ?? {
    adapter: options.adapter.name,
    targetRoot: options.targetRoot,
    transport: transport.kind,
    transportDescription: transport.description,
  });
  const graphLockPath = pathForGraphLock(workspaceRoot, options.targetKey ?? "default", options.adapter.name, targetFingerprint);
  const previousLock = await readExistingGraphLock(graphLockPath);
  const registryClient = new RegistryClient({ workspaceRoot, offline: lockMode, offlineLabel: lockLabel, warn });
  const graph = await resolveDependencyGraph(options.roots, {
    workspaceRoot,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    registryClient,
    noDeps: options.noDeps,
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
  const persistedTrustSources = await rememberTrustedSources(workspaceRoot, trustEvaluation.persistSources, options.trustStorePath);
  for (const source of persistedTrustSources) warn(`remembered trusted transitive source: ${source}`);
  const bundle = await renderGraphForTarget(graph, {
    workspaceRoot,
    adapter: options.adapter,
    targetFingerprint,
  });
  const desiredArtifacts = desiredArtifactsFromGraphBundle(bundle);
  const graphLockDigest = digestGraphLock(bundle.graphLock);
  const graphDiff = diffGraphLocks(previousLock, bundle.graphLock);
  const manifest = await readInstallManifest(options.targetRoot, options.adapter.name, transport);
  const plan = await createCombinedInstallPlan(desiredArtifacts, options.adapter, options.targetRoot, manifest, transport, {
    baseRevision: manifest?.revision ?? null,
    graphLockDigest,
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

async function recoverPendingApplyIfSafe(targetRoot: string, adapter: string, transport: TargetTransport): Promise<boolean> {
  if (!(await readApplyJournal(targetRoot, adapter, transport))) return false;
  try {
    await recoverPendingApply(targetRoot, adapter, transport);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Pending apply journal for ${adapter} at ${targetRoot} could not be recovered automatically: ${message}`);
  }
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
