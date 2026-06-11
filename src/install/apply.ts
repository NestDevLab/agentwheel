import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { InstallManifest, InstallManifestEntry, InstallManifestV2, SourceLock } from "../model/manifest.js";
import type { GraphLock } from "../model/graph-lock.js";
import { writeGraphLock } from "../model/graph-lock.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { mergeJsonFile } from "./json-merge.js";
import { readInstallManifest, removeStateFiles, withManifestRevision, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallOperation, InstallPlan } from "./plan.js";
import { assertOperationContained } from "./path-safety.js";
import {
  acquireApplyLock,
  localPathExists,
  readApplyJournal,
  recordBackup,
  removeApplyJournal,
  rollbackCompletedOperations,
  type ApplyJournal,
  type ApplyLockOptions,
  writeApplyJournal,
} from "./transaction.js";
import { mergeCodexTomlMcp } from "./toml-merge.js";
import { normalizeOwners } from "./desired.js";
import { writeJsonAtomic } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

export interface ApplyOptions {
  executePlugins?: boolean;
  transport?: TargetTransport;
  graphLockDigest?: string;
  graphLock?: {
    path: string;
    lock: GraphLock;
  };
  lock?: ApplyLockOptions;
}

export interface UninstallOptions {
  dryRun?: boolean;
  force?: boolean;
  keepFiles?: boolean;
  transport?: TargetTransport;
  graphLock?: {
    path: string;
    lock: GraphLock;
  };
  removeGraphLockPath?: string;
  workspaceConfig?: {
    path: string;
    data: unknown;
  };
  lock?: ApplyLockOptions;
}

export interface UninstallResult {
  removed: number;
  kept: number;
  removedDrifted: number;
}

export async function applyInstallPlan(plan: InstallPlan, sourceLock: SourceLock, options: ApplyOptions = {}): Promise<InstallManifest> {
  return applyPlanTransactionally(plan, { ...options, sourceLock });
}

export async function applyCombinedInstallPlan(plan: InstallPlan, options: ApplyOptions = {}): Promise<InstallManifest> {
  return applyPlanTransactionally(plan, options);
}

export async function recoverPendingApply(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
): Promise<InstallManifest | undefined> {
  const lock = await acquireApplyLock(targetRoot, adapter, transport);
  try {
    const journal = await readApplyJournal(targetRoot, adapter, transport);
    if (!journal) return undefined;

    if (journal.operations.some((operation) => operation.action === "plugin" || operation.action === "program")) {
      throw new Error("Cannot automatically recover a journal containing semantic plugin or programmatic operations");
    }

    const now = new Date().toISOString();
    const entries: InstallManifestEntry[] = [];
    const startedByIndex = new Map(journal.completed.map((operation) => [operation.index, operation]));
    for (const [index, operation] of journal.operations.entries()) {
      assertOperationContained(operation, journal.targetRoot);
      const started = startedByIndex.get(index);
      if (started?.completed || (started && await operationLanded(operation, transport))) {
        started.completed = true;
        await writeApplyJournal(journal, transport);
        const entry = await entryForCompletedOperation(operation, transport, now, journal.graphLockDigest);
        if (entry) entries.push(entry);
        continue;
      }

      if (operationNeedsSource(operation) && operation.sourcePath && !(await localPathExists(operation.sourcePath))) {
        await rollbackStartedOperations(journal, transport);
        await removeApplyJournal(targetRoot, adapter, transport);
        return undefined;
      }

      const backup = started ?? await recordBackup(operation, index, targetRoot, adapter, transport);
      if (!started && isJournaledMutation(operation)) {
        journal.completed.push(backup);
        startedByIndex.set(index, backup);
        await writeApplyJournal(journal, transport);
      }
      const entry = await applyOperation(operation, { transport, now, graphLockDigest: journal.graphLockDigest });
      if (entry) entries.push(entry);
      if (isJournaledMutation(operation)) {
        backup.completed = true;
        await writeApplyJournal(journal, transport);
      }
    }

    return await commitJournalState(journal, transport, journal.mode === "uninstall" ? undefined : entries, now);
  } finally {
    await lock.release();
  }
}

async function applyPlanTransactionally(
  plan: InstallPlan,
  options: ApplyOptions & { sourceLock?: SourceLock } = {},
): Promise<InstallManifest> {
  const transport = options.transport ?? localTransport;
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "drift" || operation.action === "conflict");
    throw new Error(`Refusing to apply with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }

  const lock = await acquireApplyLock(plan.targetRoot, plan.adapter, transport, options.lock);
  try {
    await assertBaseRevision(plan, transport);
    const now = new Date().toISOString();
    const graphLockDigest = options.graphLockDigest ?? plan.graphLockDigest;
    const journal: ApplyJournal = {
      version: 1,
      adapter: plan.adapter,
      targetRoot: plan.targetRoot,
      baseRevision: plan.baseRevision,
      graphLockDigest,
      createdAt: now,
      updatedAt: now,
      operations: plan.operations,
      completed: [],
      manifest: {
        version: 2,
        adapter: plan.adapter,
        targetRoot: plan.targetRoot,
        generatedAt: now,
        revision: "pending-apply-0000",
        legacy: false,
        adapterCode: plan.adapterCode,
        entries: [],
      },
      sourceLock: options.sourceLock,
      graphLockPath: options.graphLock?.path,
      graphLock: options.graphLock?.lock,
    };
    await writeApplyJournal(journal, transport);

    const entries: InstallManifestEntry[] = [];
    for (const [index, operation] of plan.operations.entries()) {
      assertOperationContained(operation, plan.targetRoot);
      const backup = isJournaledMutation(operation)
        ? await recordBackup(operation, index, plan.targetRoot, plan.adapter, transport)
        : undefined;
      if (backup) {
        journal.completed.push(backup);
        await writeApplyJournal(journal, transport);
      }
      const entry = await applyOperation(operation, {
        transport,
        now,
        executePlugins: options.executePlugins,
        graphLockDigest,
        plan,
      });
      if (entry) entries.push(entry);
      if (backup) {
        backup.completed = true;
        await writeApplyJournal(journal, transport);
      }
    }

    return await commitJournalState(journal, transport, entries, now);
  } finally {
    await lock.release();
  }
}

export async function uninstall(plan: InstallPlan, options: UninstallOptions | boolean = {}): Promise<UninstallResult> {
  const resolvedOptions = typeof options === "boolean" ? { dryRun: options } : options;
  const transport = resolvedOptions.transport ?? localTransport;
  if (resolvedOptions.keepFiles && resolvedOptions.force) {
    throw new Error("--keep-files cannot be combined with --force.");
  }
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "conflict");
    throw new Error(`Refusing to uninstall with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }
  const removable = plan.operations
    .filter((operation) => operation.action === "remove" || (resolvedOptions.force && operation.action === "keep"))
    .map((operation) => operation.action === "keep"
      ? { ...operation, action: "remove" as const, reason: `${operation.reason}; force removing drifted managed file` }
      : operation);
  const kept = resolvedOptions.force ? [] : plan.operations.filter((operation) => operation.action === "keep");
  const skipped = plan.operations.filter((operation) => operation.action === "skip");
  const removedDrifted = resolvedOptions.force ? plan.operations.filter((operation) => operation.action === "keep").length : 0;
  if (resolvedOptions.dryRun) return { removed: resolvedOptions.keepFiles ? 0 : removable.length, kept: kept.length, removedDrifted };

  const preservedKept = resolvedOptions.keepFiles
    ? kept.filter((operation) => shouldPreserveKeptOperationWhenKeepingFiles(operation))
    : kept;
  const preserved = [...preservedKept, ...skipped];
  for (const operation of [...removable, ...preserved]) assertOperationContained(operation, plan.targetRoot);
  const now = new Date().toISOString();
  const finalManifest = withManifestRevision({
    version: 2,
    adapter: plan.adapter,
    targetRoot: plan.targetRoot,
    generatedAt: now,
    revision: "pending-uninstall-0",
    legacy: false,
    adapterCode: plan.adapterCode,
    entries: preserved.map((operation) => {
      if (!operation.manifestHash || !operation.desiredHash) {
        throw new Error(`Invalid preserved operation missing manifest/source hash: ${operation.relativeDestPath}`);
      }
      return manifestEntryForOperation(operation, {
        now,
        hash: operation.manifestHash,
        sourceHash: operation.desiredHash,
        graphLockDigest: operation.graphLockDigest ?? plan.graphLockDigest,
      });
    }).sort((a, b) => a.path.localeCompare(b.path)),
  });

  const lock = await acquireApplyLock(plan.targetRoot, plan.adapter, transport, resolvedOptions.lock);
  try {
    await assertBaseRevision(plan, transport);
    const journal: ApplyJournal = {
      version: 1,
      mode: "uninstall",
      adapter: plan.adapter,
      targetRoot: plan.targetRoot,
      baseRevision: plan.baseRevision,
      graphLockDigest: plan.graphLockDigest,
      createdAt: now,
      updatedAt: now,
      operations: resolvedOptions.keepFiles ? [] : removable,
      completed: [],
      manifest: finalManifest,
      graphLockPath: resolvedOptions.graphLock?.path,
      graphLock: resolvedOptions.graphLock?.lock,
      graphLockRemovePath: resolvedOptions.removeGraphLockPath,
      workspaceConfigPath: resolvedOptions.workspaceConfig?.path,
      workspaceConfig: resolvedOptions.workspaceConfig?.data,
    };
    await writeApplyJournal(journal, transport);

    for (const [index, operation] of (resolvedOptions.keepFiles ? [] : removable).entries()) {
      const backup = await recordBackup(operation, index, plan.targetRoot, plan.adapter, transport);
      journal.completed.push(backup);
      await writeApplyJournal(journal, transport);
      await applyOperation(operation, { transport, now, graphLockDigest: plan.graphLockDigest });
      backup.completed = true;
      await writeApplyJournal(journal, transport);
    }

    await commitJournalState(journal, transport, undefined, now);
  } finally {
    await lock.release();
  }
  return { removed: resolvedOptions.keepFiles ? 0 : removable.length, kept: kept.length, removedDrifted };
}

function shouldPreserveKeptOperationWhenKeepingFiles(operation: InstallOperation): boolean {
  return operation.preserveInManifest === true;
}

async function commitJournalState(
  journal: ApplyJournal,
  transport: TargetTransport,
  entries: InstallManifestEntry[] | undefined,
  now: string,
): Promise<InstallManifest> {
  const manifest = withManifestRevision({
    ...journal.manifest,
    generatedAt: now,
    entries: entries ? entries.sort((a, b) => a.path.localeCompare(b.path)) : journal.manifest.entries,
  });

  if (journal.mode === "uninstall" && manifest.entries.length === 0) {
    await removeStateFiles(journal.targetRoot, journal.adapter, transport);
  } else {
    if (journal.sourceLock) await writeSourceLock(journal.targetRoot, journal.adapter, journal.sourceLock, transport);
    await writeInstallManifest(manifest, transport);
  }
  if (journal.graphLockPath && journal.graphLock) await writeGraphLock(journal.graphLockPath, journal.graphLock);
  if (journal.graphLockRemovePath) await rm(journal.graphLockRemovePath, { force: true });
  if (journal.workspaceConfigPath && journal.workspaceConfig) await writeJsonAtomic(journal.workspaceConfigPath, journal.workspaceConfig);
  await removeApplyJournal(journal.targetRoot, journal.adapter, transport);
  return manifest;
}

async function applyOperation(
  operation: InstallOperation,
  context: {
    transport: TargetTransport;
    now: string;
    executePlugins?: boolean;
    graphLockDigest?: string;
    plan?: InstallPlan;
  },
): Promise<InstallManifestEntry | undefined> {
  const { transport, now } = context;
  if (operation.action === "plugin") {
    if (!operation.desiredHash) {
      throw new Error(`Invalid plugin operation missing hash: ${operation.relativeDestPath}`);
    }
    if (context.executePlugins) {
      if (transport.kind !== "local") {
        throw new Error(`Cannot execute semantic plugin install over ${transport.description}. Run plugin installation on the remote host.`);
      }
      if (!operation.semanticCommand || operation.semanticCommand.length === 0) {
        throw new Error(`Invalid plugin operation missing command: ${operation.relativeDestPath}`);
      }
      const command = operation.semanticCommand[0];
      const args = operation.semanticCommand.slice(1);
      if (!command) {
        throw new Error(`Invalid plugin operation missing command: ${operation.relativeDestPath}`);
      }
      await execFileAsync(command, args);
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.desiredHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: context.graphLockDigest,
      executed: context.executePlugins === true,
    });
  }

  if (operation.action === "program") {
    if (!context.plan?.adapterCode || !operation.desiredHash || !operation.programmaticOperation) {
      throw new Error(`Invalid programmatic operation: ${operation.relativeDestPath}`);
    }
    if (operation.programmaticApply) {
      if (transport.kind !== "local") {
        throw new Error(`Cannot execute programmatic adapter operation over ${transport.description}.`);
      }
      await operation.programmaticApply(operation.programmaticOperation, {
        targetRoot: context.plan.targetRoot,
        adapterName: context.plan.adapter,
      });
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.desiredHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: context.graphLockDigest,
    });
  }

  if (operation.action === "create" || operation.action === "update") {
    if (!operation.sourcePath || !operation.desiredHash) {
      throw new Error(`Invalid operation missing source/hash: ${operation.relativeDestPath}`);
    }
    if (operation.mergeStrategy === "json-deep") {
      await mergeWithTransport(operation.sourcePath, operation.destPath, transport, mergeJsonFile);
    } else if (operation.mergeStrategy === "codex-toml-mcp") {
      await mergeWithTransport(operation.sourcePath, operation.destPath, transport, mergeCodexTomlMcp);
    } else {
      await transport.atomicCopy(operation.sourcePath, operation.destPath, operation.kind);
    }
    const hash = await transport.hashPath(operation.destPath);
    if (!operation.mergeStrategy && hash !== operation.desiredHash) {
      throw new Error(`Hash verification failed for ${operation.relativeDestPath}: expected ${operation.desiredHash}, got ${hash}`);
    }
    return manifestEntryForOperation(operation, {
      now,
      hash,
      sourceHash: operation.desiredHash,
      graphLockDigest: context.graphLockDigest,
    });
  }

  if (operation.action === "skip") {
    if (!operation.desiredHash) {
      throw new Error(`Invalid skip operation missing hash: ${operation.relativeDestPath}`);
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.mergeStrategy && operation.currentHash ? operation.currentHash : operation.desiredHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: context.graphLockDigest,
    });
  }

  if (operation.action === "keep") {
    if (!operation.manifestHash || !operation.desiredHash) {
      throw new Error(`Invalid keep operation missing manifest/source hash: ${operation.relativeDestPath}`);
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.manifestHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: operation.graphLockDigest ?? context.graphLockDigest,
    });
  }

  if (operation.action === "remove") {
    await transport.rm(operation.destPath);
    return undefined;
  }

  return undefined;
}

async function entryForCompletedOperation(
  operation: InstallOperation,
  transport: TargetTransport,
  now: string,
  graphLockDigest: string | undefined,
): Promise<InstallManifestEntry | undefined> {
  if (operation.action === "remove") return undefined;
  if (operation.action === "create" || operation.action === "update") {
    return manifestEntryForOperation(operation, {
      now,
      hash: await transport.hashPath(operation.destPath),
      sourceHash: requireDesiredHash(operation),
      graphLockDigest,
    });
  }
  if (operation.action === "skip") {
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.mergeStrategy && operation.currentHash ? operation.currentHash : requireDesiredHash(operation),
      sourceHash: requireDesiredHash(operation),
      graphLockDigest,
    });
  }
  return undefined;
}

function manifestEntryForOperation(
  operation: InstallOperation,
  values: {
    now: string;
    hash: string;
    sourceHash: string;
    graphLockDigest?: string;
    executed?: boolean;
  },
): InstallManifestEntry {
  const owners = normalizeOwners(operation.owners ?? [operation.packageName ?? operation.artifactName]);
  return {
    path: operation.relativeDestPath,
    artifactType: operation.artifactType,
    artifactName: operation.artifactName,
    installName: operation.installName ?? operation.artifactName,
    logicalSelector: operation.logicalSelector ?? `${operation.artifactType}/${operation.artifactName}`,
    graphNodeId: operation.graphNodeId,
    dependencyRole: operation.dependencyRole ?? "root",
    owners,
    refCount: owners.length,
    kind: operation.kind,
    hash: values.hash,
    sourceHash: values.sourceHash,
    updatedAt: values.now,
    channel: operation.channel,
    packageName: operation.packageName,
    semanticCommand: operation.semanticCommand,
    executed: values.executed,
    mergeStrategy: operation.mergeStrategy,
    composedFrom: operation.composedFrom,
    graphLockDigest: operation.graphLockDigest ?? values.graphLockDigest,
  };
}

async function assertBaseRevision(plan: InstallPlan, transport: TargetTransport): Promise<void> {
  const current = await readInstallManifest(plan.targetRoot, plan.adapter, transport);
  const currentRevision = current?.revision ?? null;
  if (currentRevision !== plan.baseRevision) {
    throw new Error(`Install manifest changed since planning for ${plan.adapter}; replan needed`);
  }
}

function isJournaledMutation(operation: InstallOperation): boolean {
  return operation.action === "create" || operation.action === "update" || operation.action === "remove";
}

function operationNeedsSource(operation: InstallOperation): boolean {
  return operation.action === "create" || operation.action === "update";
}

async function operationLanded(operation: InstallOperation, transport: TargetTransport): Promise<boolean> {
  if (operation.action === "remove") return !(await transport.pathExists(operation.destPath));
  if (operation.action !== "create" && operation.action !== "update") return false;
  if (!(await transport.pathExists(operation.destPath))) return false;
  if (operation.mergeStrategy) return true;
  if (!operation.desiredHash) return false;
  return (await transport.hashPath(operation.destPath)) === operation.desiredHash;
}

async function rollbackStartedOperations(journal: ApplyJournal, transport: TargetTransport): Promise<void> {
  if (transport.kind !== "local" && journal.completed.some((item) => item.hadExisting && !item.backupPath)) {
    throw new Error(`Cannot automatically roll back ${transport.description}: remote journal has no restorable backups; restore manually or rerun with staged sources available to finish recovery.`);
  }
  await rollbackCompletedOperations(journal.completed, transport);
}

function requireDesiredHash(operation: InstallOperation): string {
  if (!operation.desiredHash) throw new Error(`Invalid operation missing desired hash: ${operation.relativeDestPath}`);
  return operation.desiredHash;
}

async function mergeWithTransport(
  sourcePath: string,
  destPath: string,
  transport: TargetTransport,
  merge: (sourcePath: string, destPath: string) => Promise<void>,
): Promise<void> {
  if (transport.kind === "local") {
    await merge(sourcePath, destPath);
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-merge-"));
  const localDest = join(tempRoot, basename(destPath) || "merged");
  try {
    if (await transport.pathExists(destPath)) {
      await writeFile(localDest, await transport.readFile(destPath), "utf8");
    }
    await merge(sourcePath, localDest);
    await transport.atomicCopy(localDest, destPath, "file");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
