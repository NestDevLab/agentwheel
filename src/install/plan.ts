import { join, relative } from "node:path";
import type { AdapterConfig, ProgrammaticAdapterApply, ProgrammaticAdapterOperation, ProgrammaticAdapterUninstall } from "../model/adapter.js";
import type { Artifact, ArtifactType, FileKind } from "../model/artifact.js";
import type { DependencyRole, InstallManifest, InstallManifestEntry, InstallManifestV1Entry } from "../model/manifest.js";
import type { StagedBundle } from "../staging/staging.js";
import { openClawPluginInstallCommand } from "../targets/plugins/openclaw.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import type { DesiredArtifact, DesiredEntryMeta } from "./desired.js";
import { normalizeOwners } from "./desired.js";

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
  execute?: boolean;
  mergeStrategy?: "json-deep" | "codex-toml-mcp";
  programmaticOperation?: ProgrammaticAdapterOperation;
  programmaticApply?: ProgrammaticAdapterApply;
  composedFrom?: Artifact["composedFrom"];
  installName?: string;
  logicalSelector?: string;
  graphNodeId?: string;
  dependencyRole?: DependencyRole;
  owners?: string[];
  graphLockDigest?: string;
}

export interface MigrationReport {
  adopted: number;
  dropped: string[];
}

export interface InstallPlan {
  adapter: string;
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
}

export async function createInstallPlan(
  bundle: StagedBundle,
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
  transport: TargetTransport = localTransport,
): Promise<InstallPlan> {
  const desired = new Map<string, InstallOperation>();

  for (const artifact of bundle.artifacts) {
    const op = operationForArtifact(artifact, adapter, targetRoot, {
      logicalSelector: `${artifact.type}/${artifact.name}`,
      dependencyRole: "root",
      owners: [artifact.packageName ?? bundle.source.packageName ?? bundle.source.source],
      composedFrom: artifact.composedFrom,
    });
    if (op) {
      desired.set(op.relativeDestPath, op);
    }
  }

  await addProgrammaticOperations(desired, adapter, targetRoot);

  return createPlanFromOperations(desired, adapter, targetRoot, manifest, transport, {});
}

export async function createCombinedInstallPlan(
  desiredArtifacts: DesiredArtifact[],
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
  transport: TargetTransport = localTransport,
  options: CombinedInstallPlanOptions = {},
): Promise<InstallPlan> {
  for (const artifact of desiredArtifacts) {
    if (artifact.meta.dependencyRole === "transitive" && isGuardedMergeTarget(artifact.type)) {
      throw new Error(`Transitive ${artifact.type} artifacts cannot be installed until per-subentry ownership exists: ${artifact.type}/${artifact.name}`);
    }
  }

  const desired = new Map<string, InstallOperation>();
  for (const artifact of desiredArtifacts) {
    const op = operationForArtifact(artifact, adapter, targetRoot, artifact.meta);
    if (op) {
      desired.set(op.relativeDestPath, op);
    }
  }

  await addProgrammaticOperations(desired, adapter, targetRoot);
  return createPlanFromOperations(desired, adapter, targetRoot, manifest, transport, options);
}

async function createPlanFromOperations(
  desired: Map<string, InstallOperation>,
  adapter: AdapterConfig,
  targetRoot: string,
  manifest: InstallManifest | undefined,
  transport: TargetTransport,
  options: CombinedInstallPlanOptions,
): Promise<InstallPlan> {
  const migration = migrateManifestForPlan(manifest, desired);
  const effectiveEntries = migration.entries;
  const manifestByPath = new Map(effectiveEntries.map((entry) => [entry.path, entry]));
  const operations: InstallOperation[] = [];

  for (const op of desired.values()) {
    if (op.action === "plugin") {
      const existing = manifestByPath.get(op.relativeDestPath);
      if (existing && existing.hash === op.desiredHash) {
        operations.push({ ...op, action: "skip", manifestHash: existing.hash, reason: "plugin already planned" });
      } else {
        operations.push(op);
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

    if (op.mergeStrategy) {
      const existing = manifestByPath.get(op.relativeDestPath);
      const exists = await transport.pathExists(op.destPath);
      if (!exists) {
        operations.push({ ...op, action: "create", reason: "merge destination missing" });
        continue;
      }
      const currentHash = await transport.hashPath(op.destPath);
      if (existing && existing.sourceHash === op.desiredHash) {
        operations.push({ ...op, action: "skip", currentHash, manifestHash: existing.hash, reason: "merged source already up to date" });
      } else {
        operations.push({ ...op, action: "update", currentHash, manifestHash: existing?.hash, reason: existing ? "merge source changed" : "merge into existing JSON" });
      }
      continue;
    }

    const existing = manifestByPath.get(op.relativeDestPath);
    const exists = await transport.pathExists(op.destPath);
    if (!exists) {
      operations.push({ ...op, action: "create", reason: "destination missing" });
      continue;
    }

    const currentHash = await transport.hashPath(op.destPath);
    if (!existing) {
      operations.push({ ...op, action: "conflict", currentHash, reason: "destination exists but is not managed" });
      continue;
    }

    if (currentHash !== existing.hash) {
      operations.push({
        ...op,
        action: "drift",
        currentHash,
        manifestHash: existing.hash,
        reason: "managed destination changed outside agentwheel",
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
    const destPath = join(targetRoot, entry.path);
    if (!(await transport.pathExists(destPath))) continue;
    const currentHash = await transport.hashPath(destPath);
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
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
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
        reason: "artifact removed from source",
        channel: entry.channel,
        packageName: entry.packageName,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
    }
  }

  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: adapter.name,
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
  desired: Map<string, InstallOperation>,
  adapter: AdapterConfig,
  targetRoot: string,
): Promise<void> {
  if (!adapter.programmatic?.plan) return;
  for (const op of await adapter.programmatic.plan({ targetRoot, adapterName: adapter.name })) {
    desired.set(`programmatic/${op.name}`, {
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

function migrateManifestForPlan(
  manifest: InstallManifest | undefined,
  desired: Map<string, InstallOperation>,
): { entries: PlanningManifestEntry[]; report?: MigrationReport } {
  if (!manifest) return { entries: [] };
  if (!manifest.legacy) return { entries: manifest.entries };

  const entries: InstallManifestEntry[] = [];
  const dropped: string[] = [];
  let adopted = 0;
  const desiredOps = [...desired.values()].sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));

  for (const entry of manifest.entries) {
    const pathMatch = desired.get(entry.path);
    const packageMatch = !pathMatch && entry.packageName
      ? desiredOps.find((op) => op.owners?.includes(entry.packageName!) && op.artifactType === entry.artifactType && op.artifactName === entry.artifactName)
        ?? desiredOps.find((op) => op.owners?.includes(entry.packageName!))
      : undefined;
    const match = pathMatch ?? packageMatch;
    if (!match) {
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
    graphLockDigest: op.graphLockDigest,
    composedFrom: op.composedFrom ?? entry.composedFrom,
  };
}

function operationMetadataFromDesired(artifact: Artifact, meta: DesiredEntryMeta): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "composedFrom"
> {
  return {
    installName: artifact.name,
    logicalSelector: meta.logicalSelector ?? `${artifact.type}/${artifact.name}`,
    graphNodeId: meta.graphNodeId,
    dependencyRole: meta.dependencyRole ?? "root",
    owners: normalizeOwners(meta.owners),
    composedFrom: meta.composedFrom ?? artifact.composedFrom,
  };
}

function operationMetadataFromEntry(entry: PlanningManifestEntry): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "graphLockDigest"
> {
  if ("owners" in entry) {
    return {
      installName: entry.installName,
      logicalSelector: entry.logicalSelector,
      graphNodeId: entry.graphNodeId,
      dependencyRole: entry.dependencyRole,
      owners: entry.owners,
      graphLockDigest: entry.graphLockDigest,
    };
  }
  return {
    installName: entry.artifactName,
    logicalSelector: `${entry.artifactType}/${entry.artifactName}`,
    dependencyRole: "root",
    owners: [entry.packageName ?? "legacy"],
  };
}

function normalizeOperationOwners(op: InstallOperation): string[] {
  return normalizeOwners(op.owners ?? [op.packageName ?? op.artifactName]);
}

function isGuardedMergeTarget(type: ArtifactType): boolean {
  return type === "mcp" || type === "hooks" || type === "settings" || type === "plugins";
}

function operationForArtifact(artifact: Artifact, adapter: AdapterConfig, targetRoot: string, meta: DesiredEntryMeta): InstallOperation | undefined {
  const target = adapter.targets[artifact.type];
  if (!target?.enabled) return undefined;
  const metadata = operationMetadataFromDesired(artifact, meta);

  if (artifact.type === "plugins" && target.semantic === "openclaw-plugin") {
    const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
    return {
      action: "plugin",
      artifactType: artifact.type,
      artifactName: artifact.name,
      kind: artifact.kind,
      sourcePath,
      destPath: targetRoot,
      relativeDestPath: `plugins/${artifact.name}`,
      desiredHash: artifact.hash,
      reason: "semantic plugin install planned",
      channel: artifact.channel ?? "managed",
      packageName: artifact.packageName,
      semanticCommand: openClawPluginInstallCommand({ path: sourcePath, dryRun: true }),
      composedFrom: metadata.composedFrom,
      ...metadata,
    };
  }

  const destPath = artifact.type === "instructions" || artifact.type === "settings" || isFileTarget(target.dest)
    ? join(targetRoot, target.dest)
    : join(targetRoot, target.dest, artifact.name);

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
    composedFrom: metadata.composedFrom,
    ...metadata,
  };
}

function isFileTarget(dest: string): boolean {
  return /\.(json|jsonc|toml|md)$/i.test(dest);
}

function reasonWithComposedDiff(reason: string, desired?: Artifact["composedFrom"], current?: Artifact["composedFrom"]): string {
  const changed = changedComposedSelectors(desired, current);
  if (changed.length === 0) return reason;
  return `${reason} (included fragment changed: ${changed.join(", ")})`;
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
