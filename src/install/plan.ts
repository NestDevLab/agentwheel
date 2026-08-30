import { basename, join, relative } from "node:path";
import {
  defaultInstallationType,
  installRootForArtifacts,
  resolveInstallationTypeForArtifacts,
  targetMappingForArtifact,
  type AdapterConfig,
  type ProgrammaticAdapterApply,
  type ProgrammaticAdapterOperation,
  type ProgrammaticAdapterUninstall,
} from "../model/adapter.js";
import type { Artifact, ArtifactType, FileKind } from "../model/artifact.js";
import { legacyUnownedWorkspaceOwner, type DependencyRole, type InstallManifest, type InstallManifestEntry, type InstallManifestV1Entry } from "../model/manifest.js";
import type { StagedBundle } from "../staging/staging.js";
import { renderCodexSubagents } from "../staging/codex-subagents.js";
import { renderCopilotArtifacts } from "../staging/copilot-artifacts.js";
import { renderOpenClawSubagents } from "../staging/openclaw-subagents.js";
import { semanticPluginSpecForArtifact, type SemanticPluginSpec } from "../targets/plugins/index.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { filterArtifactsByAdapterTargets } from "../validation/adapter-targets.js";
import { filterArtifactsByInstallFormat, validateArtifactsForInstall } from "../validation/artifacts.js";
import type { DesiredArtifact, DesiredEntryMeta } from "./desired.js";
import { normalizeOwners } from "./desired.js";
import {
  claudeInstructionBridgesAgents,
  desiredManagedInstructionBlockHash,
  managedInstructionBlockMode,
  managedInstructionPhysicalKey,
  managedInstructionSelector,
  readManagedInstructionBlockState,
  type ManagedInstructionBlockMode,
} from "./instructions-block.js";
import { assertOperationContained, assertSafeInstallName } from "./path-safety.js";
import {
  combineMergeRemovals,
  hasMergeRemovalContent,
  MergeAdoptionMismatchError,
  mergeRemovalForInstall,
  type MergeRemoval,
} from "./merge-removal.js";

export type PlanAction = "create" | "update" | "skip" | "remove" | "keep" | "drift" | "conflict" | "plugin" | "program";
export type PlanChannel = "managed" | "overlay" | "addition" | "override" | "ejected";

export interface InstallOperation {
  action: PlanAction;
  artifactType: ArtifactType;
  artifactName: string;
  kind: FileKind;
  sourcePath?: string;
  destPath: string;
  relativeDestPath: string;
  desiredHash?: string;
  currentHash?: string;
  manifestHash?: string;
  reason: string;
  channel: PlanChannel;
  packageName?: string;
  semanticCommand?: string[];
  semanticPlugin?: SemanticPluginSpec;
  execute?: boolean;
  mergeStrategy?: "json-deep" | "openclaw-json-deep" | "yaml-deep" | "codex-toml-mcp";
  mergeRemoval?: MergeRemoval;
  mergeCreatedDestination?: boolean;
  exactMergeRemoval?: boolean;
  mode?: ManagedInstructionBlockMode;
  programmaticOperation?: ProgrammaticAdapterOperation;
  programmaticApply?: ProgrammaticAdapterApply;
  composedFrom?: Artifact["composedFrom"];
  installName?: string;
  logicalSelector?: string;
  graphNodeId?: string;
  dependencyRole?: DependencyRole;
  owners?: string[];
  workspaceOwner?: string;
  graphLockDigest?: string;
  preserveInManifest?: boolean;
  blockedDesiredHash?: string;
  blockedReason?: string;
  composedFromDiff?: string[];
  overrideDrift?: boolean;
}

export interface MigrationReport {
  adopted: number;
  dropped: string[];
}

export interface InstallPlan {
  adapter: string;
  installationType: string;
  stateKey?: string;
  targetRoot: string;
  operations: InstallOperation[];
  hasBlockingChanges: boolean;
  baseRevision: string | null;
  migrationReport?: MigrationReport;
  graphLockDigest?: string;
  adapterCode?: {
    modulePath: string;
    hash: string;
  };
  programmaticApply?: ProgrammaticAdapterApply;
  programmaticUninstall?: ProgrammaticAdapterUninstall;
}

export interface CombinedInstallPlanOptions {
  baseRevision?: string | null;
  graphLockDigest?: string;
  workspaceOwner?: string;
  installationType?: string;
  stateKey?: string;
  forceDrift?: boolean;
  forceConflict?: boolean;
  replaceConflict?: boolean;
  warn?: (message: string) => void;
  suppressAdapterTargetWarnings?: boolean;
}

export async function createInstallPlan(
  bundle: StagedBundle,
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
  transport: TargetTransport = localTransport,
  options: CombinedInstallPlanOptions = {},
): Promise<InstallPlan> {
  const requestedInstallationType = options.installationType ?? defaultInstallationType;
  const artifacts = await renderPlanArtifacts(bundle, adapter);
  const formatCompatibleArtifacts = await filterArtifactsByInstallFormat(artifacts, adapter, requestedInstallationType, { warn: options.warn });
  const installableArtifacts = filterArtifactsByAdapterTargets(formatCompatibleArtifacts, adapter, requestedInstallationType, {
    warn: options.suppressAdapterTargetWarnings ? undefined : options.warn,
  });
  const installationType = resolveInstallationTypeForArtifacts(adapter, installableArtifacts.map((artifact) => artifact.type), requestedInstallationType);
  const installRoot = installRootForArtifacts(adapter, targetRoot, installationType, installableArtifacts.map((artifact) => artifact.type), transport.kind === "ssh");
  await validateArtifactsForInstall(installableArtifacts, adapter, installationType);
  const desired: InstallOperation[] = [];

  for (const artifact of installableArtifacts) {
    const op = await operationForArtifact(artifact, adapter, installRoot, installationType, {
      logicalSelector: `${artifact.type}/${artifact.name}`,
      dependencyRole: "root",
      owners: [artifact.packageName ?? bundle.source.packageName ?? bundle.source.source],
      composedFrom: artifact.composedFrom,
    });
    if (op) {
      desired.push(op);
    }
  }

  await addProgrammaticOperations(desired, adapter, installRoot);

  return createPlanFromOperations(desired, adapter, installRoot, manifest, transport, { ...options, installationType });
}

async function renderPlanArtifacts(bundle: StagedBundle, adapter: AdapterConfig): Promise<Artifact[]> {
  const codexRenderedArtifacts = await renderCodexSubagents(bundle.artifacts, bundle.root, adapter);
  const openClawRenderedArtifacts = await renderOpenClawSubagents(codexRenderedArtifacts, bundle.root, adapter);
  return renderCopilotArtifacts(openClawRenderedArtifacts, bundle.root, adapter);
}

export async function createCombinedInstallPlan(
  desiredArtifacts: DesiredArtifact[],
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
  transport: TargetTransport = localTransport,
  options: CombinedInstallPlanOptions = {},
): Promise<InstallPlan> {
  const requestedInstallationType = options.installationType ?? defaultInstallationType;
  const formatCompatibleArtifacts = await filterArtifactsByInstallFormat(desiredArtifacts, adapter, requestedInstallationType, { warn: options.warn });
  const installableArtifacts = filterArtifactsByAdapterTargets(formatCompatibleArtifacts, adapter, requestedInstallationType, {
    warn: options.suppressAdapterTargetWarnings ? undefined : options.warn,
  });
  const installationType = resolveInstallationTypeForArtifacts(adapter, installableArtifacts.map((artifact) => artifact.type), requestedInstallationType);
  const installRoot = installRootForArtifacts(adapter, targetRoot, installationType, installableArtifacts.map((artifact) => artifact.type), transport.kind === "ssh");
  await validateArtifactsForInstall(installableArtifacts, adapter, installationType);
  for (const artifact of installableArtifacts) {
    if (artifact.meta.dependencyRole !== "root" && isGuardedMergeTarget(artifact.type)) {
      throw new Error(`Dependency-provided ${artifact.type} artifacts cannot be installed until per-subentry ownership exists: ${artifact.type}/${artifact.name}`);
    }
  }

  const desired: InstallOperation[] = [];
  for (const artifact of installableArtifacts) {
    const op = await operationForArtifact(artifact, adapter, installRoot, installationType, artifact.meta);
    if (op) {
      desired.push(op);
    }
  }

  await addProgrammaticOperations(desired, adapter, installRoot);
  return createPlanFromOperations(desired, adapter, installRoot, manifest, transport, { ...options, installationType });
}

async function createPlanFromOperations(
  desiredOps: InstallOperation[],
  adapter: AdapterConfig,
  targetRoot: string,
  manifest: InstallManifest | undefined,
  transport: TargetTransport,
  options: CombinedInstallPlanOptions,
): Promise<InstallPlan> {
  const workspaceOwner = options.workspaceOwner;
  if (workspaceOwner) {
    for (const op of desiredOps) op.workspaceOwner = workspaceOwner;
  }
  const preparedOps = await prepareManagedBlockOperations(desiredOps, adapter, targetRoot, transport, options);
  for (const op of preparedOps) assertOperationContained(op, targetRoot);
  const migration = await migrateManifestForPlan(manifest, preparedOps, targetRoot, transport);
  const effectiveEntries = migration.entries;
  const manifestByPath = new Map(effectiveEntries.map((entry) => [entry.path, entry]));
  const { desired, collisions } = await splitCollisionOperations(preparedOps, manifestByPath, transport);
  const operations: InstallOperation[] = [];
  operations.push(...collisions);

  for (const op of desired.values()) {
    if (op.action === "plugin") {
      const existing = manifestByPath.get(op.relativeDestPath);
      if (existing && existing.sourceHash === op.desiredHash && existing.executed === true) {
        operations.push({ ...op, action: "skip", manifestHash: existing.hash, execute: true, reason: "semantic plugin already executed" });
      } else {
        operations.push(existing && existing.sourceHash === op.desiredHash
          ? { ...op, manifestHash: existing.hash, reason: "semantic plugin pending execution" }
          : op);
      }
      continue;
    }

    if (op.action === "program") {
      const existing = manifestByPath.get(op.relativeDestPath);
      if (existing && existing.hash === op.desiredHash) {
        operations.push({ ...op, action: "skip", manifestHash: existing.hash, reason: "programmatic operation already applied" });
      } else {
        operations.push(op);
      }
      continue;
    }

    if (op.mode === managedInstructionBlockMode) {
      operations.push(...await planManagedBlockOperation(op, manifestByPath, transport, options, workspaceOwner, targetRoot));
      continue;
    }

    if (op.mergeStrategy) {
      const existing = manifestByPath.get(op.relativeDestPath);
      const exists = await transport.pathExists(op.destPath);
      const currentContent = exists ? await transport.readFile(op.destPath) : undefined;
      const currentHash = exists ? await transport.hashPath(op.destPath) : undefined;
      if (existing && workspaceOwner && !entryOwnedByWorkspace(existing, workspaceOwner)) {
        if (!(await canAdoptLegacyUnownedEntry(existing, op, transport))) {
          operations.push(keepForeignManifestEntryOperation(existing, targetRoot, workspaceOwner, op, currentHash));
          continue;
        }
      }
      const incompleteMergeOwnership = existing
        && existing.mergeStrategy
        && !("mergeCreatedDestination" in existing && existing.mergeCreatedDestination === true)
        && !("mergeRemoval" in existing && hasMergeRemovalContent(existing.mergeRemoval));
      const adoptExisting = exists
        && (!existing || incompleteMergeOwnership)
        && options.forceConflict === true;
      let mergeRemoval: MergeRemoval;
      try {
        mergeRemoval = await mergeRemovalForInstall(op.sourcePath!, op.mergeStrategy, currentContent, {
          adoptExisting: adoptExisting ? (op.artifactType === "mcp" ? "mcp" : "generic") : undefined,
        });
      } catch (error) {
        if (!(error instanceof MergeAdoptionMismatchError)) throw error;
        operations.push({
          ...op,
          action: "conflict",
          currentHash,
          reason: error.message,
          blockedReason: error.message,
        });
        continue;
      }
      if (existing && "mergeRemoval" in existing && existing.mergeRemoval) {
        mergeRemoval = combineMergeRemovals(existing.mergeRemoval, mergeRemoval);
      }
      if (!exists) {
        operations.push({ ...op, action: "create", mergeRemoval, mergeCreatedDestination: true, reason: "merge destination missing" });
        continue;
      }
      if (adoptExisting) {
        operations.push({
          ...op,
          action: "skip",
          mergeRemoval,
          mergeCreatedDestination: existing?.mergeCreatedDestination,
          currentHash,
          manifestHash: existing?.hash,
          reason: existing
            ? "force repairing exact incomplete merge ownership"
            : "force adopting exact unmanaged merge contribution",
        });
        continue;
      }
      if (existing && existing.sourceHash === op.desiredHash) {
        operations.push(options.forceDrift
          ? { ...op, action: "update", mergeRemoval, mergeCreatedDestination: existing.mergeCreatedDestination, currentHash, manifestHash: existing.hash, reason: "force refreshing managed merge destination" }
          : { ...op, action: "skip", mergeRemoval: existing.mergeRemoval, mergeCreatedDestination: existing.mergeCreatedDestination, currentHash, manifestHash: existing.hash, reason: "merged source already up to date" });
      } else {
        operations.push({ ...op, action: "update", mergeRemoval, mergeCreatedDestination: existing?.mergeCreatedDestination, currentHash, manifestHash: existing?.hash, reason: existing ? "merge source changed" : "merge into existing destination" });
      }
      continue;
    }

    const existing = manifestByPath.get(op.relativeDestPath);
    if (existing && workspaceOwner && !entryOwnedByWorkspace(existing, workspaceOwner)) {
      if (!(await canAdoptLegacyUnownedEntry(existing, op, transport))) {
        operations.push(keepForeignManifestEntryOperation(existing, targetRoot, workspaceOwner, op));
        continue;
      }
    }
    const exists = await transport.pathExists(op.destPath);
    if (!exists) {
      operations.push({ ...op, action: "create", reason: "destination missing" });
      continue;
    }

    const currentHash = await transport.hashPath(op.destPath);
    if (!existing) {
      if (currentHash === op.desiredHash && options.forceConflict) {
        operations.push({
          ...op,
          action: "skip",
          currentHash,
          reason: "force adopting unmanaged destination with matching hash",
        });
      } else if (options.replaceConflict) {
        operations.push({
          ...op,
          action: "update",
          currentHash,
          reason: "force replacing unmanaged destination",
        });
      } else {
        operations.push({ ...op, action: "conflict", currentHash, reason: "destination exists but is not managed" });
      }
      continue;
    }

    if (currentHash !== existing.hash) {
      const composedFromDiff = changedComposedSelectors(op.composedFrom, existing.composedFrom);
      if (options.forceDrift) {
        operations.push({
          ...op,
          action: "update",
          currentHash,
          manifestHash: existing.hash,
          overrideDrift: true,
          reason: reasonWithComposedDiff("force replacing drifted managed destination", op.composedFrom, existing.composedFrom),
          composedFromDiff,
        });
        continue;
      }
      operations.push({
        ...op,
        action: "drift",
        currentHash,
        manifestHash: existing.hash,
        reason: "managed destination changed outside agentwheel",
        blockedDesiredHash: op.desiredHash,
        blockedReason: blockedDriftReason(op.composedFrom, existing.composedFrom),
        composedFromDiff,
      });
      continue;
    }

    if (currentHash === op.desiredHash) {
      operations.push({ ...op, action: "skip", currentHash, manifestHash: existing.hash, reason: "already up to date" });
    } else {
      operations.push({
        ...op,
        action: "update",
        currentHash,
        manifestHash: existing.hash,
        reason: reasonWithComposedDiff("source changed", op.composedFrom, existing.composedFrom),
      });
    }
  }

  for (const entry of effectiveEntries) {
    if (desired.has(entry.path)) continue;
    const semanticPlugin = entry.semanticPlugin;
    const destPath = semanticPlugin ? targetRoot : join(targetRoot, entry.path);
    if (!semanticPlugin && !(await transport.pathExists(destPath))) continue;
    const inferredMode = semanticPlugin
      ? undefined
      : await inferExactLegacyManagedInstructionMode(entry, destPath, transport);
    const currentHash = semanticPlugin ? entry.hash : await currentEntryHash(entry, destPath, transport, inferredMode);
    if (workspaceOwner && !entryOwnedByWorkspace(entry, workspaceOwner)) {
      operations.push(keepForeignManifestEntryOperation(entry, targetRoot, workspaceOwner, undefined, currentHash));
      continue;
    }
    if (currentHash !== entry.hash) {
      operations.push({
        action: "drift",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        currentHash,
        manifestHash: entry.hash,
        reason: "managed stale destination changed outside agentwheel",
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode ?? inferredMode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
        ...(options.forceDrift
          ? { action: "remove" as const, reason: "force removing drifted stale managed destination", overrideDrift: true }
          : {}),
      });
    } else {
      operations.push({
        action: "remove",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        currentHash,
        manifestHash: entry.hash,
        reason: staleRemovalReason(entry),
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: semanticPlugin?.uninstallCommands[0] ?? entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode ?? inferredMode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
    }
  }

  for (const operation of operations) assertOperationContained(operation, targetRoot);
  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: adapter.name,
    installationType: options.installationType ?? defaultInstallationType,
    stateKey: options.stateKey,
    targetRoot,
    operations,
    hasBlockingChanges: operations.some((op) => op.action === "drift" || op.action === "conflict"),
    baseRevision: options.baseRevision ?? manifest?.revision ?? null,
    migrationReport: migration.report,
    graphLockDigest: options.graphLockDigest,
    adapterCode: adapter.programmatic ? { modulePath: adapter.programmatic.modulePath, hash: adapter.programmatic.hash } : undefined,
    programmaticApply: adapter.programmatic?.apply,
    programmaticUninstall: adapter.programmatic?.uninstall,
  };
}

type PlanningManifestEntry = InstallManifestEntry | InstallManifestV1Entry;

async function addProgrammaticOperations(
  desired: InstallOperation[],
  adapter: AdapterConfig,
  targetRoot: string,
): Promise<void> {
  if (!adapter.programmatic?.plan) return;
  for (const op of await adapter.programmatic.plan({ targetRoot, adapterName: adapter.name })) {
    desired.push({
      action: "program",
      artifactType: "settings",
      artifactName: op.name,
      kind: "file",
      destPath: targetRoot,
      relativeDestPath: `programmatic/${op.name}`,
      desiredHash: adapter.programmatic.hash,
      reason: op.reason ?? "programmatic adapter operation planned",
      channel: "managed",
      programmaticOperation: op,
      programmaticApply: adapter.programmatic.apply,
      installName: op.name,
      logicalSelector: `programmatic/${op.name}`,
      dependencyRole: "root",
      owners: [`programmatic:${adapter.name}`],
    });
  }
}

async function migrateManifestForPlan(
  manifest: InstallManifest | undefined,
  desired: InstallOperation[],
  targetRoot: string,
  transport: TargetTransport,
): Promise<{ entries: PlanningManifestEntry[]; report?: MigrationReport }> {
  if (!manifest) return { entries: [] };
  if (!manifest.legacy) return { entries: manifest.entries };

  const entries: InstallManifestEntry[] = [];
  const dropped: string[] = [];
  let adopted = 0;
  const desiredByPath = groupOperationsByPath(desired);

  for (const entry of manifest.entries) {
    const candidates = desiredByPath.get(entry.path) ?? [];
    const match = candidates.length === 1 ? candidates[0] : undefined;
    if (!match || !(await canStrictlyAdoptLegacyEntry(entry, match, targetRoot, transport))) {
      dropped.push(entry.path);
      continue;
    }
    entries.push(adoptLegacyEntry(entry, match));
    adopted++;
  }

  return {
    entries,
    report: {
      adopted,
      dropped,
    },
  };
}

async function prepareManagedBlockOperations(
  desiredOps: InstallOperation[],
  adapter: AdapterConfig,
  targetRoot: string,
  transport: TargetTransport,
  options: CombinedInstallPlanOptions,
): Promise<InstallOperation[]> {
  const prepared: InstallOperation[] = [];
  const physicalInstructionPaths = new Map<string, InstallOperation>();
  for (const op of desiredOps) {
    if (op.mode !== managedInstructionBlockMode) {
      prepared.push(op);
      continue;
    }
    if (!op.sourcePath) {
      throw new Error(`Managed block instruction operation missing source: ${op.relativeDestPath}`);
    }

    const managedOp = {
      ...op,
      desiredHash: await desiredManagedInstructionBlockHash(op.sourcePath),
    };

    if (await shouldSkipClaudeBridge(adapter, managedOp, targetRoot, transport)) {
      continue;
    }
    await warnOnCopilotDoubleRead(adapter, managedOp, targetRoot, transport, options);

    const physicalKey = await managedInstructionPhysicalKey(managedOp.destPath, transport);
    const incumbent = physicalInstructionPaths.get(physicalKey);
    if (incumbent) {
      if (incumbent.desiredHash !== managedOp.desiredHash) {
        options.warn?.(`Multiple instruction targets resolve to ${managedOp.relativeDestPath}; using ${incumbent.relativeDestPath} and skipping duplicate with different content.`);
      }
      continue;
    }
    physicalInstructionPaths.set(physicalKey, managedOp);
    prepared.push(managedOp);
  }
  return prepared;
}

async function shouldSkipClaudeBridge(
  adapter: AdapterConfig,
  op: InstallOperation,
  targetRoot: string,
  transport: TargetTransport,
): Promise<boolean> {
  if (adapter.name !== "claude" || op.artifactType !== "instructions" || basename(op.destPath).toLowerCase() !== "claude.md") {
    return false;
  }
  const agentsPath = join(targetRoot, "AGENTS.md");
  return claudeInstructionBridgesAgents(op.destPath, agentsPath, transport);
}

async function warnOnCopilotDoubleRead(
  adapter: AdapterConfig,
  op: InstallOperation,
  targetRoot: string,
  transport: TargetTransport,
  options: CombinedInstallPlanOptions,
): Promise<void> {
  if (adapter.name !== "claude" || op.artifactType !== "instructions" || basename(op.destPath).toLowerCase() !== "claude.md") return;
  const agentsPath = join(targetRoot, "AGENTS.md");
  if (!(await transport.pathExists(agentsPath))) return;
  if (await claudeInstructionBridgesAgents(op.destPath, agentsPath, transport)) return;
  options.warn?.("CLAUDE.md and AGENTS.md are separate instruction files; if Copilot is active it may read the managed instructions twice.");
}

async function planManagedBlockOperation(
  op: InstallOperation,
  manifestByPath: Map<string, PlanningManifestEntry>,
  transport: TargetTransport,
  options: CombinedInstallPlanOptions,
  workspaceOwner: string | undefined,
  targetRoot: string,
): Promise<InstallOperation[]> {
  const existing = manifestByPath.get(op.relativeDestPath);
  if (existing && workspaceOwner && !entryOwnedByWorkspace(existing, workspaceOwner)) {
    return [keepForeignManifestEntryOperation(existing, targetRoot, workspaceOwner, op)];
  }

  const selector = managedInstructionSelector(op.logicalSelector, op.artifactType, op.artifactName);
  const state = await readManagedInstructionBlockState(op.destPath, selector, transport);
  if (!state.exists) {
    return [{ ...op, action: "create", reason: "managed instruction destination missing" }];
  }

  if (!existing) {
    if (state.hasBlock && !state.drifted && state.hash === op.desiredHash && options.forceConflict) {
      return [{
        ...op,
        action: "skip",
        currentHash: state.hash,
        reason: "force adopting unmanaged managed-block destination with matching hash",
      }];
    }
    if (options.replaceConflict) {
      return [{
        ...op,
        action: "update",
        currentHash: state.hash,
        reason: "force adopting managed-block destination",
      }];
    }
    return [{
      ...op,
      action: "conflict",
      currentHash: state.hash,
      reason: "destination exists but is not managed",
    }];
  }

  if (!state.hasBlock || state.drifted || state.hash !== existing.hash) {
    const composedFromDiff = changedComposedSelectors(op.composedFrom, existing.composedFrom);
    if (options.forceDrift) {
      return [{
        ...op,
        action: "update",
        currentHash: state.hash,
        manifestHash: existing.hash,
        overrideDrift: true,
        reason: reasonWithComposedDiff("force replacing drifted managed instruction block", op.composedFrom, existing.composedFrom),
        composedFromDiff,
      }];
    }
    return [{
      ...op,
      action: "drift",
      currentHash: state.hash,
      manifestHash: existing.hash,
      reason: state.hasBlock ? "managed instruction block changed outside agentwheel" : "managed instruction block missing from destination",
      blockedDesiredHash: op.desiredHash,
      blockedReason: blockedDriftReason(op.composedFrom, existing.composedFrom),
      composedFromDiff,
    }];
  }

  if (existing.sourceHash === op.desiredHash) {
    return [{ ...op, action: "skip", currentHash: state.hash, manifestHash: existing.hash, reason: "managed instruction block already up to date" }];
  }

  return [{
    ...op,
    action: "update",
    currentHash: state.hash,
    manifestHash: existing.hash,
    reason: reasonWithComposedDiff("managed instruction source changed", op.composedFrom, existing.composedFrom),
  }];
}

async function currentEntryHash(
  entry: PlanningManifestEntry,
  destPath: string,
  transport: TargetTransport,
  mode = entry.mode,
): Promise<string | undefined> {
  if (mode !== managedInstructionBlockMode) return transport.hashPath(destPath);
  const selector = managedInstructionSelector("logicalSelector" in entry ? entry.logicalSelector : undefined, entry.artifactType, entry.artifactName);
  const state = await readManagedInstructionBlockState(destPath, selector, transport);
  return state.hash;
}

async function inferExactLegacyManagedInstructionMode(
  entry: PlanningManifestEntry,
  destPath: string,
  transport: TargetTransport,
): Promise<typeof managedInstructionBlockMode | undefined> {
  if (entry.mode || entry.artifactType !== "instructions") return undefined;
  const selector = managedInstructionSelector("logicalSelector" in entry ? entry.logicalSelector : undefined, entry.artifactType, entry.artifactName);
  const state = await readManagedInstructionBlockState(destPath, selector, transport);
  if (!state.hasBlock || state.drifted || state.hash !== entry.hash) return undefined;
  return managedInstructionBlockMode;
}

async function canStrictlyAdoptLegacyEntry(
  entry: InstallManifestV1Entry,
  op: InstallOperation,
  targetRoot: string,
  transport: TargetTransport,
): Promise<boolean> {
  if (entry.artifactType !== op.artifactType || entry.artifactName !== op.artifactName) return false;
  if (!op.desiredHash || entry.sourceHash !== op.desiredHash) return false;
  if (!packageIdentityMatches(entry, op)) return false;
  const destPath = join(targetRoot, entry.path);
  if (!(await transport.pathExists(destPath))) return false;
  return (await transport.hashPath(destPath)) === entry.hash;
}

function packageIdentityMatches(entry: InstallManifestV1Entry, op: InstallOperation): boolean {
  if (!entry.packageName) return !op.packageName;
  return op.packageName === entry.packageName || op.owners?.includes(entry.packageName) === true;
}

async function splitCollisionOperations(
  desiredOps: InstallOperation[],
  manifestByPath: Map<string, PlanningManifestEntry>,
  transport: TargetTransport,
): Promise<{ desired: Map<string, InstallOperation>; collisions: InstallOperation[] }> {
  const byPath = groupOperationsByPath(desiredOps);

  const desired = new Map<string, InstallOperation>();
  const collisions: InstallOperation[] = [];
  for (const [path, group] of byPath) {
    if (group.length === 1) {
      desired.set(path, group[0]!);
      continue;
    }

    const existing = manifestByPath.get(path);
    const cleanIncumbent = existing ? await cleanManifestIncumbent(existing, group, transport) : undefined;
    if (cleanIncumbent) {
      desired.set(path, cleanIncumbent);
      for (const op of group) {
        if (op === cleanIncumbent) continue;
        collisions.push(collisionOperation(op, group, cleanIncumbent));
      }
      continue;
    }

    for (const op of group) {
      collisions.push(collisionOperation(op, group));
    }
  }

  return { desired, collisions };
}

function groupOperationsByPath(ops: InstallOperation[]): Map<string, InstallOperation[]> {
  const byPath = new Map<string, InstallOperation[]>();
  for (const op of ops) {
    const group = byPath.get(op.relativeDestPath) ?? [];
    group.push(op);
    byPath.set(op.relativeDestPath, group);
  }
  return byPath;
}

async function cleanManifestIncumbent(
  existing: PlanningManifestEntry,
  group: InstallOperation[],
  transport: TargetTransport,
): Promise<InstallOperation | undefined> {
  const destPath = group[0]?.destPath;
  if (!destPath || !(await transport.pathExists(destPath))) return undefined;
  if ((await transport.hashPath(destPath)) !== existing.hash) return undefined;
  const matches = group.filter((op) => operationMatchesManifestEntry(op, existing));
  return matches.length === 1 ? matches[0] : undefined;
}

function operationMatchesManifestEntry(op: InstallOperation, entry: PlanningManifestEntry): boolean {
  if (op.artifactType !== entry.artifactType || op.artifactName !== entry.artifactName) return false;
  if ("logicalSelector" in entry && entry.logicalSelector && op.logicalSelector && entry.logicalSelector === op.logicalSelector) return true;
  if ("graphNodeId" in entry && entry.graphNodeId && op.graphNodeId && entry.graphNodeId === op.graphNodeId) return true;
  return op.packageName !== undefined && entry.packageName === op.packageName;
}

function entryOwnedByWorkspace(entry: PlanningManifestEntry, workspaceOwner: string): boolean {
  return "workspaceOwner" in entry
    && entry.workspaceOwner === workspaceOwner;
}

async function canAdoptLegacyUnownedEntry(
  entry: PlanningManifestEntry,
  op: InstallOperation,
  transport: TargetTransport,
): Promise<boolean> {
  if (!("workspaceOwner" in entry) || entry.workspaceOwner !== legacyUnownedWorkspaceOwner) return false;
  if (entry.artifactType !== op.artifactType || entry.kind !== op.kind) return false;
  if (!op.desiredHash || entry.sourceHash !== op.desiredHash) return false;
  if (!(await transport.pathExists(op.destPath))) return false;
  return (await transport.hashPath(op.destPath)) === entry.hash;
}

function collisionOperation(op: InstallOperation, group: InstallOperation[], incumbent?: InstallOperation): InstallOperation {
  const owners = group.map(describeOperationOwner).sort();
  const incumbentText = incumbent ? `; incumbent ${describeOperationOwner(incumbent)} keeps the plain name` : "";
  return {
    ...op,
    action: "conflict",
    reason: `install path collision at ${op.relativeDestPath}: ${owners.join("; ")}${incumbentText}. Resolve by aliasing, deselecting one artifact, or overriding the dependency selection.`,
  };
}

function describeOperationOwner(op: InstallOperation): string {
  const owner = op.owners?.join(",") ?? op.packageName ?? "unknown-owner";
  return `${op.dependencyRole ?? "root"} ${op.logicalSelector ?? `${op.artifactType}/${op.artifactName}`} owned by ${owner}`;
}

function adoptLegacyEntry(entry: InstallManifestV1Entry, op: InstallOperation): InstallManifestEntry {
  const owners = normalizeOperationOwners(op);
  return {
    ...entry,
    installName: op.installName ?? entry.artifactName,
    logicalSelector: op.logicalSelector ?? `${entry.artifactType}/${entry.artifactName}`,
    graphNodeId: op.graphNodeId,
    dependencyRole: op.dependencyRole ?? "root",
    owners,
    refCount: owners.length,
    workspaceOwner: op.workspaceOwner ?? legacyUnownedWorkspaceOwner,
    graphLockDigest: op.graphLockDigest,
    composedFrom: op.composedFrom ?? entry.composedFrom,
    mode: op.mode,
  };
}

function operationMetadataFromDesired(artifact: Artifact, meta: DesiredEntryMeta): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "composedFrom"
> {
  return {
    installName: meta.installName ?? artifact.name,
    logicalSelector: meta.logicalSelector ?? `${artifact.type}/${artifact.name}`,
    graphNodeId: meta.graphNodeId,
    dependencyRole: meta.dependencyRole ?? "root",
    owners: normalizeOwners(meta.owners),
    composedFrom: meta.composedFrom ?? artifact.composedFrom,
  };
}

function operationMetadataFromEntry(entry: PlanningManifestEntry): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "workspaceOwner" | "graphLockDigest" | "mergeRemoval" | "mergeCreatedDestination"
> {
  if ("owners" in entry) {
    return {
      installName: entry.installName,
      logicalSelector: entry.logicalSelector,
      graphNodeId: entry.graphNodeId,
      dependencyRole: entry.dependencyRole,
      owners: entry.owners,
      workspaceOwner: entry.workspaceOwner,
      graphLockDigest: entry.graphLockDigest,
      mergeRemoval: entry.mergeRemoval,
      mergeCreatedDestination: entry.mergeCreatedDestination,
    };
  }
  return {
    installName: entry.artifactName,
    logicalSelector: `${entry.artifactType}/${entry.artifactName}`,
    dependencyRole: "root",
    owners: [entry.packageName ?? "legacy"],
    workspaceOwner: legacyUnownedWorkspaceOwner,
  };
}

function keepForeignManifestEntryOperation(
  entry: PlanningManifestEntry,
  targetRoot: string,
  workspaceOwner: string,
  operation?: InstallOperation,
  currentHash?: string,
): InstallOperation {
  const owner = "workspaceOwner" in entry ? entry.workspaceOwner : legacyUnownedWorkspaceOwner;
  return {
    action: "keep",
    artifactType: entry.artifactType,
    artifactName: entry.artifactName,
    kind: entry.kind,
    destPath: operation?.destPath ?? join(targetRoot, entry.path),
    relativeDestPath: entry.path,
    desiredHash: entry.sourceHash,
    currentHash: currentHash ?? operation?.currentHash ?? entry.hash,
    manifestHash: entry.hash,
    reason: `foreign artifact owned by ${owner}; kept outside workspace ${workspaceOwner}`,
    channel: entry.channel,
    packageName: entry.packageName,
    semanticCommand: entry.semanticCommand,
    semanticPlugin: entry.semanticPlugin,
    execute: entry.executed,
    mergeStrategy: entry.mergeStrategy,
    mode: entry.mode,
    composedFrom: entry.composedFrom,
    preserveInManifest: true,
    ...operationMetadataFromEntry(entry),
  };
}

function normalizeOperationOwners(op: InstallOperation): string[] {
  return normalizeOwners(op.owners ?? [op.packageName ?? op.artifactName]);
}

function staleRemovalReason(entry: PlanningManifestEntry): string {
  if (!entry.mergeStrategy) return "artifact removed from source";
  return "mergeCreatedDestination" in entry && entry.mergeCreatedDestination === true
    ? "remove entire file created by Agentwheel as merge destination"
    : "remove managed merge contribution; preserving merge destination";
}

function isGuardedMergeTarget(type: ArtifactType): boolean {
  return type === "mcp" || type === "hooks" || type === "settings" || type === "plugins";
}

async function operationForArtifact(artifact: Artifact, adapter: AdapterConfig, targetRoot: string, installationType: string, meta: DesiredEntryMeta): Promise<InstallOperation | undefined> {
  if (artifact.type === "fragments") return undefined;
  const target = targetMappingForArtifact(adapter, artifact.type, installationType);
  if (!target?.enabled) {
    const supported = Object.keys(adapter.targets[artifact.type] ?? {});
    const suffix = supported.length > 0 ? ` Supported installation types: ${supported.join(", ")}` : "";
    throw new Error(`Adapter ${adapter.name} does not support ${artifact.type}/${artifact.name} for installation type '${installationType}'.${suffix}`);
  }
  const metadata = operationMetadataFromDesired(artifact, meta);
  const rawInstallName = metadata.installName ?? artifact.name;
  assertSafeInstallName(rawInstallName, `${artifact.type}/${artifact.name}`);
  const installName = semanticInstallName(artifact, target.semantic, rawInstallName);
  assertSafeInstallName(installName, `${artifact.type}/${artifact.name}`);

  if (artifact.type === "plugins") {
    const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
    const semanticPlugin = await semanticPluginSpecForArtifact({
      semantic: target.semantic,
      artifact,
      installName,
      sourcePath,
      targetRoot,
      installationType,
    });
    if (semanticPlugin) {
      return {
        action: "plugin",
        artifactType: artifact.type,
        artifactName: artifact.name,
        kind: artifact.kind,
        sourcePath,
        destPath: targetRoot,
        relativeDestPath: `plugins/${installName}`,
        desiredHash: artifact.hash,
        reason: "semantic plugin install planned",
        channel: artifact.channel ?? "managed",
        packageName: artifact.packageName,
        semanticCommand: semanticPlugin.installCommands[0],
        semanticPlugin,
        composedFrom: metadata.composedFrom,
        ...metadata,
      };
    }
  }

  if (artifact.type === "subagents" && target.semantic === "codex-subagent") {
    const destPath = join(targetRoot, target.dest, `${installName.replace(/\.toml$/i, "")}.toml`);
    return {
      action: "create",
      artifactType: artifact.type,
      artifactName: artifact.name,
      kind: "file",
      sourcePath: artifact.stagedPath ?? artifact.sourcePath,
      destPath,
      relativeDestPath: relative(targetRoot, destPath).replaceAll("\\", "/"),
      desiredHash: artifact.hash,
      reason: "destination missing",
      channel: artifact.channel ?? "managed",
      packageName: artifact.packageName,
      composedFrom: metadata.composedFrom,
      ...metadata,
      installName: installName.replace(/\.toml$/i, ""),
    };
  }

  const destPath = artifact.type === "instructions" || artifact.type === "settings" || isFileTarget(target.dest)
    ? join(targetRoot, target.dest)
    : join(targetRoot, target.dest, installName);

  return {
    action: "create",
    artifactType: artifact.type,
    artifactName: artifact.name,
    kind: artifact.kind,
    sourcePath: artifact.stagedPath ?? artifact.sourcePath,
    destPath,
    relativeDestPath: relative(targetRoot, destPath).replaceAll("\\", "/"),
    desiredHash: artifact.hash,
    reason: "destination missing",
    channel: artifact.channel ?? "managed",
    packageName: artifact.packageName,
    mergeStrategy: target.merge,
    mode: target.mode,
    composedFrom: metadata.composedFrom,
    ...metadata,
    installName,
  };
}

function semanticInstallName(artifact: Artifact, semantic: string | undefined, installName: string): string {
  if (artifact.type === "rules" && semantic === "copilot-instruction") {
    return withExtension(installName, ".instructions.md", [".instructions.md", ".md"]);
  }
  if (artifact.type === "commands" && semantic === "copilot-prompt") {
    return withExtension(installName, ".prompt.md", [".prompt.md", ".md"]);
  }
  if (artifact.type === "subagents" && semantic === "copilot-agent") {
    return withExtension(installName, ".agent.md", [".agent.md", ".md"]);
  }
  return installName;
}

function withExtension(name: string, targetExtension: string, knownExtensions: string[]): string {
  const match = knownExtensions.find((extension) => name.toLowerCase().endsWith(extension.toLowerCase()));
  const base = match ? name.slice(0, -match.length) : name;
  return `${base}${targetExtension}`;
}

function isFileTarget(dest: string): boolean {
  return /\.(json|jsonc|ya?ml|toml|md)$/i.test(dest);
}

function reasonWithComposedDiff(reason: string, desired?: Artifact["composedFrom"], current?: Artifact["composedFrom"]): string {
  const changed = changedComposedSelectors(desired, current);
  if (changed.length === 0) return reason;
  return `${reason} (included fragment changed: ${changed.join(", ")})`;
}

function blockedDriftReason(desired?: Artifact["composedFrom"], current?: Artifact["composedFrom"]): string | undefined {
  const changed = changedComposedSelectors(desired, current);
  if (changed.length === 0) return undefined;
  return `drift blocks update: included fragment changed ${changed.join(", ")}`;
}

function changedComposedSelectors(desired?: Artifact["composedFrom"], current?: Artifact["composedFrom"]): string[] {
  const currentBySelector = new Map((current ?? []).map((entry) => [entry.selector, entry.hash]));
  return (desired ?? [])
    .filter((entry) => currentBySelector.get(entry.selector) !== entry.hash)
    .map((entry) => entry.selector)
    .sort();
}

export function summarizePlan(plan: InstallPlan): Record<PlanAction, number> {
  const summary: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    remove: 0,
    keep: 0,
    drift: 0,
    conflict: 0,
    plugin: 0,
    program: 0,
  };
  for (const operation of plan.operations) {
    summary[operation.action]++;
  }
  return summary;
}

export function isPendingInstallAction(action: PlanAction): boolean {
  return action !== "skip" && action !== "keep";
}

export function isPendingInstallOperation(operation: Pick<InstallOperation, "action">): boolean {
  return isPendingInstallAction(operation.action);
}
