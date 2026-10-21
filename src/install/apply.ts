import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { declareMutationPath } from "../mutation/declarations.js";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { InstallManifest, InstallManifestEntry, InstallManifestV2, SourceLock } from "../model/manifest.js";
import type { GraphLock } from "../model/graph-lock.js";
import { canonicalGraphLockJson, readGraphLock, writeGraphLock } from "../model/graph-lock.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { assertRunAsPlanSupported } from "../transport/run-as-policy.js";
import { mergeJsonFile } from "./json-merge.js";
import { mergeOpenClawJsonFile } from "./openclaw-json-merge.js";
import { canonicalInstallManifestJson, computeInstallManifestInventoryRevision, computeSourceLockRevision, listInstallManifests, readInstallManifest, readSourceLock, removeStateFiles, withManifestRevision, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallOperation, InstallPlan } from "./plan.js";
import { assertOperationContained } from "./path-safety.js";
import { installManifestPath, metadataDir } from "./paths.js";
import {
  acquireApplyLock,
  applyJournalPath,
  assertGovernedRuntimeTransportSupported,
  assertApplyJournalRecoveryAllowed,
  assertLinkedApplyJournal,
  listApplyJournals,
  localPathExists,
  readApplyJournal,
  recordBackup,
  removeApplyJournal,
  rollbackCompletedOperations,
  type ApplyJournal,
  type MetadataStateGuards,
  type ApplyLockOptions,
  mutationMetadataForApplyJournal,
  writeApplyJournal,
  assertNoSymlinkPath,
  metadataAuditPath,
  metadataRuntimePath,
  observeOwnershipRuntime,
  assertOwnershipMetadataTransportSupported,
  assertOwnershipMetadataJournalLinked,
  assertOwnershipMetadataAuditPaths,
  syncMetadataPath,
} from "./transaction.js";
import { mergeCodexTomlMcp } from "./toml-merge.js";
import { mergeYamlFile } from "./yaml-merge.js";
import { assertExactMcpMergeContribution, assertExactMergeContribution, assertMergedSourceContribution, hasMergeRemovalContent, mergeContributionAbsent, removeMergeContribution } from "./merge-removal.js";
import { normalizeOwners } from "./desired.js";
import {
  managedInstructionBlockLanded,
  managedInstructionBlockMode,
  managedInstructionSelector,
  readManagedInstructionBlockState,
  exactManagedInstructionBlockSnapshot,
  removeManagedInstructionBlock,
  writeManagedInstructionBlock,
} from "./instructions-block.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

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

export interface ApplyRecoveryLink {
  path: string;
  operationId: string;
  journalDigest: string;
  transportDescription: string;
  reason: string;
  noCommit: boolean;
  resolveOnly?: boolean;
}

export async function recoverPendingApply(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: { installationType?: string; stateKey?: string } = {},
  expectedLink?: ApplyRecoveryLink,
): Promise<InstallManifest | undefined> {
  assertGovernedRuntimeTransportSupported(transport);
  if (transport.kind === "local-run-as" && !expectedLink) throw new Error("Run-as recovery requires a caller-owned durable receipt link.");
  const validateJournal = async (journal: ApplyJournal): Promise<void> => {
    if (expectedLink) {
      if (expectedLink.path !== applyJournalPath(targetRoot, adapter, scope)) throw new Error("Recovery receipt journal path mismatch.");
      assertLinkedApplyJournal(journal, expectedLink.path, expectedLink.operationId, expectedLink.journalDigest, expectedLink.transportDescription, transport);
      if (journal.mutation?.reason !== expectedLink.reason || journal.mutation.noCommit !== expectedLink.noCommit) {
        throw new Error("Runtime apply journal mutation metadata does not match its durable receipt.");
      }
    }
    assertApplyJournalRecoveryAllowed(journal);
    if (journal.metadataAudit || journal.metadataGuards) assertOwnershipMetadataTransportSupported(transport, journal);
    await assertOwnershipMetadataAuditPaths(journal, transport);
    assertRunAsPlanSupported({ operations: journal.operations, adapterCode: journal.manifest.adapterCode } as InstallPlan, transport);
    if (journal.operations.some((operation) => operation.action === "plugin" || operation.action === "program" || operation.semanticPlugin)) {
      throw new Error("Cannot automatically recover a journal containing semantic plugin or programmatic operations");
    }
  };
  await assertRuntimeJournalGate(targetRoot, adapter, transport, scope, true);
  const preflightJournal = await readApplyJournal(targetRoot, adapter, transport, scope);
  if (!preflightJournal) return undefined;
  await validateJournal(preflightJournal);
  const lock = await acquireApplyLock(targetRoot, adapter, transport, {}, scope);
  try {
    await assertRuntimeJournalGate(targetRoot, adapter, transport, scope, true);
    const journal = await readApplyJournal(targetRoot, adapter, transport, scope);
    if (!journal) return undefined;
    await validateJournal(journal);
    if (expectedLink?.resolveOnly) {
      await removeApplyJournal(targetRoot, adapter, transport, scope, journal);
      return journal.manifest;
    }

    const now = new Date().toISOString();
    const entries: InstallManifestEntry[] = [];
    const startedByIndex = new Map(journal.completed.map((operation) => [operation.index, operation]));
    for (const [index, operation] of journal.operations.entries()) {
      assertOperationContained(operation, journal.targetRoot);
      const started = startedByIndex.get(index);
      if (started && await operationLanded(operation, transport)) {
        started.completed = true;
        await writeApplyJournal(journal, transport);
        const entry = await entryForCompletedOperation(operation, transport, now, journal.graphLockDigest);
        if (entry) entries.push(entry);
        continue;
      }

      if (operationNeedsSource(operation) && operation.sourcePath && !(await localPathExists(operation.sourcePath))) {
        await rollbackStartedOperations(journal, transport);
        await removeApplyJournal(targetRoot, adapter, transport, scope, journal);
        return undefined;
      }

      const backup = started ?? await recordBackup(operation, index, targetRoot, adapter, transport, scope);
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

async function assertRuntimeJournalGate(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport,
  scope: { installationType?: string; stateKey?: string },
  allowRequestedJournal = false,
): Promise<void> {
  const pending = await listApplyJournals(targetRoot, adapter, transport, {
    installationType: scope.installationType,
  });
  if (pending.length === 0) return;
  const requestedPath = applyJournalPath(targetRoot, adapter, scope);
  if (allowRequestedJournal && pending.length === 1 && pending[0]!.path === requestedPath) return;
  throw new Error(
    `Cannot mutate ${adapter}/${scope.installationType ?? "local"} at ${targetRoot} while runtime apply journal(s) are pending: `
    + pending.map((item) => item.path).join(", "),
  );
}

async function assertRuntimeStateRevision(plan: InstallPlan, transport: TargetTransport): Promise<void> {
  if (!plan.runtimeStateRevision) return;
  const current = await computeInstallManifestInventoryRevision(plan.targetRoot, plan.adapter, transport);
  if (current !== plan.runtimeStateRevision) {
    throw new Error(
      `Runtime manifest inventory changed after planning: expected ${plan.runtimeStateRevision}, found ${current}; replan needed.`,
    );
  }
}

async function applyPlanTransactionally(
  plan: InstallPlan,
  options: ApplyOptions & { sourceLock?: SourceLock } = {},
): Promise<InstallManifest> {
  const transport = options.transport ?? localTransport;
  const scope = { installationType: plan.installationType, stateKey: plan.stateKey };
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "drift" || operation.action === "conflict");
    throw new Error(`Refusing to apply with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }

  assertGovernedRuntimeTransportSupported(transport);
  assertRunAsPlanSupported(plan, transport);

  const lock = await acquireApplyLock(plan.targetRoot, plan.adapter, transport, options.lock, scope);
  try {
    await assertRuntimeJournalGate(plan.targetRoot, plan.adapter, transport, scope);
    await assertRuntimeStateRevision(plan, transport);
    await assertBaseRevision(plan, transport);
    await assertTargetStateFilePreconditions(plan, transport, options.graphLock?.path);
    await assertStateMigrationPreconditions(plan, transport);
    const now = new Date().toISOString();
    const graphLockDigest = options.graphLockDigest ?? plan.graphLockDigest;
    const mutation = mutationMetadataForApplyJournal();
    const journal: ApplyJournal = {
      version: mutation ? 2 : 1,
      ...(mutation ? { mutation } : {}),
      adapter: plan.adapter,
      installationType: plan.installationType,
      stateKey: plan.stateKey,
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
        installationType: plan.installationType,
        stateKey: plan.stateKey,
        targetRoot: plan.targetRoot,
        generatedAt: now,
        revision: "pending-apply-0000",
        legacy: false,
        adapterCode: plan.adapterCode,
        entries: [],
      },
      sourceLock: options.sourceLock ?? plan.stateMigration?.sourceLock ?? undefined,
      graphLockPath: options.graphLock?.path,
      graphLock: options.graphLock?.lock,
      graphLockRemovePath: plan.stateMigration
        && plan.stateMigration.fromGraphLockPath !== options.graphLock?.path
        ? plan.stateMigration.fromGraphLockPath
        : undefined,
      stateRemoveKey: plan.stateMigration?.fromStateKey !== plan.stateKey
        ? plan.stateMigration?.fromStateKey
        : undefined,
    };
    await writeApplyJournal(journal, transport);

    const entries: InstallManifestEntry[] = [];
    for (const [index, operation] of plan.operations.entries()) {
      assertOperationContained(operation, plan.targetRoot);
      const backup = isJournaledMutation(operation)
        ? await recordBackup(operation, index, plan.targetRoot, plan.adapter, transport, scope)
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
  const scope = { installationType: plan.installationType, stateKey: plan.stateKey };
  if (resolvedOptions.keepFiles && resolvedOptions.force) {
    throw new Error("--keep-files cannot be combined with --force.");
  }
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "conflict");
    throw new Error(`Refusing to uninstall with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }
  const removable = plan.operations
    .filter((operation) => operation.action === "remove" || (resolvedOptions.force && isForceRemovableKeep(operation)))
    .map((operation) => operation.action === "keep"
      ? { ...operation, action: "remove" as const, overrideDrift: true, reason: `${operation.reason}; force removing drifted managed file` }
      : operation);
  const kept = plan.operations.filter((operation) => operation.action === "keep" && (!resolvedOptions.force || !isForceRemovableKeep(operation)));
  const skipped = plan.operations.filter((operation) => operation.action === "skip");
  const removedDrifted = resolvedOptions.force ? plan.operations.filter((operation) => operation.action === "keep" && isForceRemovableKeep(operation)).length : 0;
  if (resolvedOptions.dryRun) return { removed: resolvedOptions.keepFiles ? 0 : removable.length, kept: kept.length, removedDrifted };

  assertGovernedRuntimeTransportSupported(transport);
  assertRunAsPlanSupported(plan, transport);

  const preservedKept = resolvedOptions.keepFiles
    ? kept.filter((operation) => shouldPreserveKeptOperationWhenKeepingFiles(operation))
    : kept;
  const preserved = [...preservedKept, ...skipped].filter((operation) => operation.preserveInManifest !== false);
  for (const operation of [...removable, ...preserved]) assertOperationContained(operation, plan.targetRoot);
  const now = new Date().toISOString();
  let finalManifest = withManifestRevision({
    version: 2,
    adapter: plan.adapter,
    installationType: plan.installationType,
    stateKey: plan.stateKey,
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

  const lock = await acquireApplyLock(plan.targetRoot, plan.adapter, transport, resolvedOptions.lock, scope);
  try {
    await assertRuntimeJournalGate(plan.targetRoot, plan.adapter, transport, scope);
    await assertRuntimeStateRevision(plan, transport);
    await assertBaseRevision(plan, transport);
    await assertTargetStateFilePreconditions(plan, transport, resolvedOptions.graphLock?.path);
    await assertStateMigrationPreconditions(plan, transport);
    await assertExactMergeRemovalPreconditions(removable, transport);
    const revalidatedSkips = new Map<string, InstallManifestEntry>();
    for (const operation of skipped) {
      const entry = await applyOperation(operation, {
        transport,
        now,
        graphLockDigest: operation.graphLockDigest ?? plan.graphLockDigest,
      });
      if (entry) revalidatedSkips.set(operation.relativeDestPath, entry);
    }
    if (revalidatedSkips.size > 0) {
      finalManifest = withManifestRevision({
        ...finalManifest,
        entries: finalManifest.entries.map((entry) => revalidatedSkips.get(entry.path) ?? entry),
      });
    }
    const mutation = mutationMetadataForApplyJournal();
    const journal: ApplyJournal = {
      version: mutation ? 2 : 1,
      ...(mutation ? { mutation } : {}),
      mode: "uninstall",
      adapter: plan.adapter,
      installationType: plan.installationType,
      stateKey: plan.stateKey,
      targetRoot: plan.targetRoot,
      baseRevision: plan.baseRevision,
      graphLockDigest: plan.graphLockDigest,
      createdAt: now,
      updatedAt: now,
      operations: resolvedOptions.keepFiles ? [] : removable,
      completed: [],
      manifest: finalManifest,
      sourceLock: plan.stateMigration?.sourceLock ?? undefined,
      graphLockPath: resolvedOptions.graphLock?.path,
      graphLock: resolvedOptions.graphLock?.lock,
      graphLockRemovePath: resolvedOptions.removeGraphLockPath
        ?? (plan.stateMigration?.fromGraphLockPath !== resolvedOptions.graphLock?.path
          ? plan.stateMigration?.fromGraphLockPath
          : undefined),
      stateRemoveKey: plan.stateMigration?.fromStateKey !== plan.stateKey
        ? plan.stateMigration?.fromStateKey
        : undefined,
      workspaceConfigPath: resolvedOptions.workspaceConfig?.path,
      workspaceConfig: resolvedOptions.workspaceConfig?.data,
    };
    await writeApplyJournal(journal, transport);

    for (const [index, operation] of (resolvedOptions.keepFiles ? [] : removable).entries()) {
      const backup = await recordBackup(operation, index, plan.targetRoot, plan.adapter, transport, scope);
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

function isForceRemovableKeep(operation: InstallOperation): boolean {
  return operation.action === "keep" && operation.preserveInManifest !== true;
}

export async function commitManifestMetadataJournal(
  journal: ApplyJournal,
  transport: TargetTransport = localTransport,
): Promise<InstallManifest> {
  if (journal.mode !== "uninstall" || journal.operations.length !== 0) {
    throw new Error("Manifest metadata journal must contain no runtime operations.");
  }
  assertOwnershipMetadataTransportSupported(transport, journal);
  return commitJournalState(journal, transport, undefined, journal.createdAt);
}

async function commitJournalState(
  journal: ApplyJournal,
  transport: TargetTransport,
  entries: InstallManifestEntry[] | undefined,
  now: string,
): Promise<InstallManifest> {
  if (journal.metadataAudit || journal.metadataGuards) await assertOwnershipMetadataJournalLinked(journal, transport);
  await assertOwnershipMetadataAuditPaths(journal, transport);
  const manifest = withManifestRevision({
    ...journal.manifest,
    generatedAt: journal.metadataAudit || journal.metadataGuards ? journal.createdAt : now,
    entries: entries ? entries.sort((a, b) => a.path.localeCompare(b.path)) : journal.manifest.entries,
  });

  if (journal.metadataGuards) await assertMetadataStateGuards(journal, manifest, journal.metadataGuards, transport);
  if (journal.metadataAudit) {
    await assertMetadataAuditGuards(journal, manifest, transport);
    // Intent lands first. A crash leaves an explicit pending journal, never an unaudited release.
    for (const file of journal.metadataAudit.auditFiles) {
      const path = metadataAuditPath(journal.metadataAudit, file.path);
      await assertOwnershipMetadataAuditPaths(journal, transport);
      declareMutationPath(path);
      await writeAuditFileExclusive(path, file.content, () => assertOwnershipMetadataAuditPaths(journal, transport));
    }
    await assertMetadataAuditGuards(journal, manifest, transport);
  }
  if (journal.mode === "uninstall" && manifest.entries.length === 0 && !journal.metadataAudit) {
    await removeStateFiles(journal.targetRoot, journal.adapter, transport, {
      installationType: journal.installationType,
      stateKey: journal.stateKey,
    });
    if (journal.metadataGuards && transport.kind === "local") await syncMetadataPath(metadataDir(journal.targetRoot), true);
  } else {
    if (journal.sourceLock) await writeSourceLock(journal.targetRoot, journal.adapter, journal.sourceLock, transport, {
      installationType: journal.installationType,
      stateKey: journal.stateKey,
    });
    await writeInstallManifest(manifest, transport);
    if ((journal.metadataAudit || journal.metadataGuards) && transport.kind === "local") await syncMetadataPath(installManifestPath(journal.targetRoot, journal.adapter, {
      installationType: journal.installationType, stateKey: journal.stateKey,
    }));
  }
  if (journal.graphLockPath && journal.graphLock) await writeGraphLock(journal.graphLockPath, journal.graphLock);
  if (journal.stateRemoveKey && journal.stateRemoveKey !== journal.stateKey) {
    await removeStateFiles(journal.targetRoot, journal.adapter, transport, {
      installationType: journal.installationType,
      stateKey: journal.stateRemoveKey,
    });
  }
  if (journal.graphLockRemovePath) {
    declareMutationPath(journal.graphLockRemovePath);
    await rm(journal.graphLockRemovePath, { force: true });
  }
  if (journal.workspaceConfigPath && journal.workspaceConfig) {
    declareMutationPath(journal.workspaceConfigPath);
    await writeJsonAtomic(journal.workspaceConfigPath, journal.workspaceConfig);
  }
  const verifiedManifest = await assertCommittedJournalState(journal, manifest, transport);
  if (journal.metadataAudit) await assertMetadataAuditGuards(journal, manifest, transport, true);
  if (journal.metadataGuards) await assertMetadataStateGuards(journal, manifest, journal.metadataGuards, transport, true);
  await removeApplyJournal(journal.targetRoot, journal.adapter, transport, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  }, journal);
  if (await readApplyJournal(journal.targetRoot, journal.adapter, transport, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  })) {
    throw new Error("Agentwheel apply journal remained after verified state commit.");
  }
  return verifiedManifest ?? manifest;
}

async function assertCommittedJournalState(
  journal: ApplyJournal,
  expectedManifest: InstallManifest,
  transport: TargetTransport,
): Promise<InstallManifest | undefined> {
  const scope = { installationType: journal.installationType, stateKey: journal.stateKey };
  const actualManifest = await readInstallManifest(journal.targetRoot, journal.adapter, transport, scope);
  if (journal.mode === "uninstall" && expectedManifest.entries.length === 0 && !journal.metadataAudit) {
    if (actualManifest) throw new Error("Uninstall postcheck found an install manifest that should have been removed.");
  } else if (!actualManifest) {
    throw new Error(
      `Install manifest postcheck failed: expected ${expectedManifest.revision}, found missing.`,
    );
  } else if (canonicalInstallManifestJson(actualManifest) !== canonicalInstallManifestJson(expectedManifest)) {
    throw new Error("Install manifest postcheck found content that differs from the verified apply result.");
  }
  for (const operation of journal.operations.filter(isJournaledMutation)) {
    if (!(await operationLanded(operation, transport))) {
      throw new Error(`Runtime postcheck failed for ${operation.relativeDestPath}.`);
    }
  }
  if (journal.graphLockPath && journal.graphLock) {
    const actual = await readGraphLock(journal.graphLockPath);
    if (canonicalGraphLockJson(actual) !== canonicalGraphLockJson(journal.graphLock)) {
      throw new Error(`Graph-lock postcheck failed for ${journal.graphLockPath}.`);
    }
  }
  if (journal.graphLockRemovePath && await pathExists(journal.graphLockRemovePath)) {
    throw new Error(`Graph-lock removal postcheck failed for ${journal.graphLockRemovePath}.`);
  }
  if (journal.stateRemoveKey && journal.stateRemoveKey !== journal.stateKey) {
    const removedScope = { installationType: journal.installationType, stateKey: journal.stateRemoveKey };
    if (await readInstallManifest(journal.targetRoot, journal.adapter, transport, removedScope)) {
      throw new Error(`Legacy manifest removal postcheck failed for state ${journal.stateRemoveKey}.`);
    }
    if (await readSourceLock(journal.targetRoot, journal.adapter, transport, removedScope)) {
      throw new Error(`Legacy source-lock removal postcheck failed for state ${journal.stateRemoveKey}.`);
    }
  }
  if (journal.workspaceConfigPath && journal.workspaceConfig) {
    const actual = JSON.parse(await readFile(journal.workspaceConfigPath, "utf8"));
    if (canonicalJson(actual) !== canonicalJson(journal.workspaceConfig)) {
      throw new Error(`Workspace config postcheck failed for ${journal.workspaceConfigPath}.`);
    }
  }
  return actualManifest;
}

/** Both initial commit and recovery accept only the exact reviewed before/after manifest states. */
async function assertMetadataAuditGuards(
  journal: ApplyJournal,
  after: InstallManifestV2,
  transport: TargetTransport,
  requireAfter = false,
): Promise<void> {
  const audit = journal.metadataAudit!;
  await assertOwnershipMetadataAuditPaths(journal, transport);
  const sha = /^[a-f0-9]{64}$/;
  if (transport.kind === "ssh" || (audit.kind !== "ownership-release" && audit.kind !== "ownership-handoff")
    || after.adapter !== journal.adapter || after.targetRoot !== journal.targetRoot
    || after.installationType !== journal.installationType || after.stateKey !== journal.stateKey
    || journal.mode !== "uninstall" || journal.operations.length || journal.completed.length
    || journal.sourceLock || journal.graphLock || journal.graphLockPath || journal.graphLockRemovePath
    || journal.stateRemoveKey || journal.workspaceConfigPath || journal.workspaceConfig
    || !sha.test(audit.planDigest) || !sha.test(journal.baseRevision ?? "")
    || audit.auditFiles.length !== 1 || audit.runtime.length !== 1 || !audit.inventory.length) {
    throw new Error("Invalid metadata-audit transaction; no state was committed.");
  }
  await assertMetadataStateGuards(journal, after, audit, transport, requireAfter);
  for (const file of audit.auditFiles) {
    const path = metadataAuditPath(audit, file.path);
    await assertNoSymlinkPath(path);
    if (!sha.test(file.sha256) || createHash("sha256").update(file.content).digest("hex") !== file.sha256) {
      throw new Error("Metadata-audit content digest is invalid.");
    }
    try {
      if (await readFile(path, "utf8") !== file.content) throw new Error(`Metadata-audit file changed: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || requireAfter) throw error;
    }
  }
}

async function assertMetadataStateGuards(
  journal: ApplyJournal,
  after: InstallManifestV2,
  guards: MetadataStateGuards,
  transport: TargetTransport,
  requireAfter = false,
): Promise<void> {
  const sha = /^[a-f0-9]{64}$/;
  if (transport.kind === "ssh" || (journal.metadataAudit && journal.metadataGuards)
    || after.adapter !== journal.adapter || after.targetRoot !== journal.targetRoot
    || after.installationType !== journal.installationType || after.stateKey !== journal.stateKey
    || journal.mode !== "uninstall" || journal.operations.length || journal.completed.length
    || journal.sourceLock || journal.graphLock || journal.graphLockPath || journal.graphLockRemovePath
    || journal.stateRemoveKey || journal.workspaceConfigPath || journal.workspaceConfig
    || (journal.baseRevision !== null && !sha.test(journal.baseRevision))
    || !guards.inventory.length || !guards.runtime.length) {
    throw new Error("Invalid guarded metadata transaction; no state was committed.");
  }
  assertOwnershipMetadataTransportSupported(transport, journal);
  if (transport.kind === "local") {
    await assertNoSymlinkPath(journal.targetRoot);
    await assertNoSymlinkPath(metadataDir(journal.targetRoot));
  }
  const inventory = await listInstallManifests(journal.targetRoot, undefined, transport);
  if (transport.kind === "local") for (const item of inventory) await assertNoSymlinkPath(item.path);
  const before = new Map(guards.inventory.map((item) => [item.stateKey, item.revision]));
  if (before.size !== guards.inventory.length || [...before.values()].some((revision) => !sha.test(revision))
    || (before.get(journal.stateKey!) ?? null) !== journal.baseRevision) {
    throw new Error("Invalid guarded metadata inventory baseline.");
  }
  const next = new Map(before);
  if (after.entries.length === 0 && !journal.metadataAudit) next.delete(journal.stateKey!);
  else next.set(journal.stateKey!, after.revision);
  const actual = new Map(inventory.map((item) => [item.stateKey, item.manifest.revision]));
  const equals = (expected: Map<string, string>) => actual.size === expected.size
    && [...expected].every(([key, revision]) => actual.get(key) === revision);
  if (!equals(next) && (requireAfter || !equals(before))) {
    throw new Error("Metadata inventory/manifest CAS failed; concurrent state was preserved.");
  }
  for (const guard of guards.runtime) {
    const path = metadataRuntimePath(journal.targetRoot, guard.path);
    if (!sha.test(guard.hash) || !sha.test(guard.snapshotDigest)
      || (await observeOwnershipRuntime(path, transport)).snapshotDigest !== guard.snapshotDigest
      || await transport.hashPath(path) !== guard.hash) {
      throw new Error(`Metadata runtime CAS failed at ${guard.path}; runtime was preserved.`);
    }
    if (guard.managedBlock) {
      const current = exactManagedInstructionBlockSnapshot(await transport.readFile(path), guard.managedBlock.selector);
      if (canonicalJson(current) !== canonicalJson(guard.managedBlock)) {
        throw new Error(`Managed instruction snapshot CAS failed at ${guard.path}.`);
      }
    }
  }
}

async function createPrivateAuditDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Invalid audit directory: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await createPrivateAuditDirectory(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Invalid audit directory: ${path}`);
    return;
  }
  // Clear inherited SGID/ACL group access only on a directory created by this call.
  await chmod(path, 0o700);
  await syncMetadataPath(path, true);
  await syncMetadataPath(dirname(path), true);
}

async function writeAuditFileExclusive(path: string, content: string, validateCallerPath: () => Promise<void>): Promise<void> {
  await assertNoSymlinkPath(path);
  await createPrivateAuditDirectory(dirname(path));
  await assertNoSymlinkPath(path);
  // Directory creation can inherit group/ACL state; validate the complete chain before opening bytes.
  await validateCallerPath();
  await syncMetadataPath(dirname(dirname(path)), true);
  const temporary = `${path}.pending-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Unlike rename, link never replaces an independently created destination.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error;
    }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
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
      await executePluginInstall(operation, transport);
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
    if (operation.mode === managedInstructionBlockMode) {
      const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
      const hash = await writeManagedInstructionBlock(operation.sourcePath, operation.destPath, selector, transport, managedBlockMutationOptions(operation));
      if (hash !== operation.desiredHash) {
        throw new Error(`Managed block hash verification failed for ${operation.relativeDestPath}: expected ${operation.desiredHash}, got ${hash}`);
      }
      return manifestEntryForOperation(operation, {
        now,
        hash,
        sourceHash: operation.desiredHash,
        graphLockDigest: context.graphLockDigest,
      });
    }
    if (operation.mergeStrategy === "json-deep") {
      await mergeWithTransport(operation.sourcePath, operation.destPath, transport, mergeJsonFile);
    } else if (operation.mergeStrategy === "openclaw-json-deep") {
      await mergeOpenClawJsonWithTransport(operation.sourcePath, operation.destPath, transport);
    } else if (operation.mergeStrategy === "yaml-deep") {
      await mergeWithTransport(operation.sourcePath, operation.destPath, transport, mergeYamlFile);
    } else if (operation.mergeStrategy === "codex-toml-mcp") {
      await mergeWithTransport(operation.sourcePath, operation.destPath, transport, mergeCodexTomlMcp);
    } else if (operation.mergeStrategy) {
      throw new Error(`Merge strategy '${operation.mergeStrategy}' is not implemented by apply.`);
    } else {
      await transport.atomicCopy(operation.sourcePath, operation.destPath, operation.kind, operation.desiredHash);
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
    let verifiedCurrentHash = operation.currentHash;
    if (operation.mode === managedInstructionBlockMode) {
      const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
      if (!(await managedInstructionBlockLanded(operation.destPath, selector, operation.desiredHash, transport))) {
        throw new Error(`Managed block changed after planning: ${operation.relativeDestPath}`);
      }
      verifiedCurrentHash = operation.desiredHash;
    } else if (operation.mergeStrategy && hasMergeRemovalContent(operation.mergeRemoval)) {
      if (!(await transport.pathExists(operation.destPath))) {
        throw new Error(`Merge skip destination disappeared after planning: ${operation.relativeDestPath}`);
      }
      assertExactMergeContribution(operation.mergeRemoval!, operation.mergeStrategy, await transport.readFile(operation.destPath));
      verifiedCurrentHash = await transport.hashPath(operation.destPath);
    } else if (!operation.semanticPlugin && !operation.programmaticOperation) {
      if (!(await transport.pathExists(operation.destPath))) {
        throw new Error(`Skip destination disappeared after planning: ${operation.relativeDestPath}`);
      }
      const currentHash = await transport.hashPath(operation.destPath);
      const expectedHash = operation.currentHash ?? operation.desiredHash;
      if (currentHash !== expectedHash) {
        throw new Error(`Skip destination changed after planning: ${operation.relativeDestPath}`);
      }
      verifiedCurrentHash = currentHash;
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: (operation.mergeStrategy || operation.mode === managedInstructionBlockMode) && verifiedCurrentHash ? verifiedCurrentHash : operation.desiredHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: context.graphLockDigest,
    });
  }

  if (operation.action === "keep") {
    if (!operation.manifestHash || !operation.desiredHash) {
      throw new Error(`Invalid keep operation missing manifest/source hash: ${operation.relativeDestPath}`);
    }
    if (operation.preserveInManifest === false) {
      if (!(await transport.pathExists(operation.destPath))) {
        throw new Error(`Foreign keep destination disappeared after planning: ${operation.relativeDestPath}`);
      }
      const currentHash = await transport.hashPath(operation.destPath);
      if (currentHash !== operation.currentHash || currentHash !== operation.manifestHash || currentHash !== operation.desiredHash) {
        throw new Error(`Foreign keep destination changed after planning: ${operation.relativeDestPath}`);
      }
      return undefined;
    }
    return manifestEntryForOperation(operation, {
      now,
      hash: operation.manifestHash,
      sourceHash: operation.desiredHash,
      graphLockDigest: operation.graphLockDigest ?? context.graphLockDigest,
    });
  }

  if (operation.action === "remove") {
    if (operation.semanticPlugin) {
      if (operation.execute !== false) await executePluginUninstall(operation, transport);
      return undefined;
    }
    if (operation.mode === managedInstructionBlockMode) {
      const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
      await removeManagedInstructionBlock(operation.destPath, selector, transport, managedBlockMutationOptions(operation));
    } else if (operation.mergeStrategy) {
      if (operation.mergeCreatedDestination) {
        await transport.rm(operation.destPath);
      } else if (operation.mergeRemoval) {
        if (operation.exactMergeRemoval) {
          if (!(await transport.pathExists(operation.destPath))) {
            throw new Error(`Exact MCP retirement destination is missing: ${operation.relativeDestPath}`);
          }
          assertExactMcpMergeContribution(
            operation.mergeRemoval,
            operation.mergeStrategy,
            await transport.readFile(operation.destPath),
          );
        }
        await removeMergeWithTransport(operation.destPath, operation.mergeStrategy, operation.mergeRemoval, transport);
      }
    } else {
      await transport.rm(operation.destPath);
    }
    return undefined;
  }

  return undefined;
}

async function executePluginInstall(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const commands = semanticInstallCommands(operation);
  if (commands.length === 0) throw new Error(`Invalid plugin operation missing command: ${operation.relativeDestPath}`);
  if (!operation.sourcePath) {
    throw new Error(`Invalid plugin operation missing source path: ${operation.relativeDestPath}`);
  }
  if (operation.semanticPlugin?.stateRoot) {
    await prepareSemanticPluginState(operation, transport);
  }
  await executeSemanticCommands(operation, commands, transport, { stageSource: operation.semanticPlugin?.stateRoot ? false : true });
}

async function executePluginUninstall(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const commands = operation.semanticPlugin?.uninstallCommands ?? [];
  if (commands.length === 0) throw new Error(`Invalid semantic plugin operation missing uninstall command: ${operation.relativeDestPath}`);
  try {
    await executeSemanticCommands(operation, commands, transport);
  } catch (error) {
    if (!isPluginAlreadyAbsentError(operation, error)) throw error;
    console.warn(`WARNING plugin-already-absent ${operation.relativeDestPath}: ${firstErrorLine(error)}`);
  }
  if (operation.semanticPlugin?.stateRoot) {
    await transport.rm(operation.semanticPlugin.stateRoot);
  }
}

async function prepareSemanticPluginState(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const spec = operation.semanticPlugin;
  if (!spec?.stateRoot) return;
  if (!operation.sourcePath) {
    throw new Error(`Invalid semantic plugin operation missing source path: ${operation.relativeDestPath}`);
  }

  if (spec.runtime === "claude") {
    await prepareClaudeMarketplace(operation, transport);
    return;
  }
  if (spec.runtime === "codex") {
    await prepareCodexMarketplace(operation, transport);
    return;
  }
  if (spec.runtime === "copilot") {
    await prepareCopilotPlugin(operation, transport);
    return;
  }
  if (spec.runtime === "hermes") {
    await prepareHermesGitShim(operation, transport);
  }
}

async function prepareClaudeMarketplace(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const spec = requireSemanticPluginState(operation);
  const marketplaceName = requireMarketplaceName(operation);
  const marketplaceRoot = join(spec.stateRoot, "marketplace");
  await transport.rm(spec.stateRoot);
  await transport.atomicCopy(requireSourcePath(operation), join(marketplaceRoot, "plugins", spec.pluginName), operation.kind);
  await transport.writeJsonAtomic(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: marketplaceName,
    owner: { name: "Agentwheel" },
    plugins: [
      {
        name: spec.pluginName,
        source: `./plugins/${spec.pluginName}`,
        description: `Installed by Agentwheel${operation.packageName ? ` from ${operation.packageName}` : ""}`,
      },
    ],
  });
}

async function prepareCodexMarketplace(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const spec = requireSemanticPluginState(operation);
  const marketplaceName = requireMarketplaceName(operation);
  const marketplaceRoot = join(spec.stateRoot, "marketplace");
  await transport.rm(spec.stateRoot);
  await transport.atomicCopy(requireSourcePath(operation), join(marketplaceRoot, "plugins", spec.pluginName), operation.kind);
  await transport.writeJsonAtomic(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), {
    name: marketplaceName,
    interface: {
      displayName: "Agentwheel",
    },
    plugins: [
      {
        name: spec.pluginName,
        source: {
          source: "local",
          path: `./plugins/${spec.pluginName}`,
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Agentwheel",
      },
    ],
  });
}

async function prepareCopilotPlugin(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const spec = requireSemanticPluginState(operation);
  await transport.rm(spec.stateRoot);
  await transport.atomicCopy(requireSourcePath(operation), join(spec.stateRoot, "plugin"), operation.kind);
}

async function prepareHermesGitShim(operation: InstallOperation, transport: TargetTransport): Promise<void> {
  const spec = requireSemanticPluginState(operation);
  const repoRoot = join(spec.stateRoot, "repo");
  await transport.rm(spec.stateRoot);
  await transport.atomicCopy(requireSourcePath(operation), repoRoot, operation.kind);
  if (!transport.execFile) {
    throw new Error(`Cannot prepare Hermes plugin git shim over ${transport.description}: transport does not support remote commands.`);
  }
  await transport.execFile("git", ["init", repoRoot], { cwd: operation.destPath });
  await transport.execFile("git", ["-C", repoRoot, "add", "-A"], { cwd: operation.destPath });
  await transport.execFile("git", [
    "-C",
    repoRoot,
    "-c",
    "user.name=agentwheel",
    "-c",
    "user.email=agentwheel@example.invalid",
    "commit",
    "-m",
    `agentwheel plugin ${operation.desiredHash ?? "unknown"}`,
  ], { cwd: operation.destPath });
}

function requireSemanticPluginState(operation: InstallOperation): NonNullable<InstallOperation["semanticPlugin"]> & { stateRoot: string } {
  const spec = operation.semanticPlugin;
  if (!spec?.stateRoot) throw new Error(`Invalid semantic plugin operation missing state root: ${operation.relativeDestPath}`);
  return spec as NonNullable<InstallOperation["semanticPlugin"]> & { stateRoot: string };
}

function requireSourcePath(operation: InstallOperation): string {
  if (!operation.sourcePath) throw new Error(`Invalid semantic plugin operation missing source path: ${operation.relativeDestPath}`);
  return operation.sourcePath;
}

function requireMarketplaceName(operation: InstallOperation): string {
  const marketplaceName = operation.semanticPlugin?.marketplaceName;
  if (!marketplaceName) throw new Error(`Invalid semantic plugin operation missing marketplace name: ${operation.relativeDestPath}`);
  return marketplaceName;
}

async function executeSemanticCommands(
  operation: InstallOperation,
  commands: string[][],
  transport: TargetTransport,
  options: { stageSource?: boolean } = {},
): Promise<void> {
  if (transport.kind === "local") {
    for (const [command, ...args] of commands) {
      if (!command) throw new Error(`Invalid semantic plugin command for ${operation.relativeDestPath}`);
      await execFileAsync(command, args);
    }
    return;
  }

  if (!transport.execFile) {
    throw new Error(`Cannot execute semantic plugin command over ${transport.description}: transport does not support remote commands.`);
  }

  if (!options.stageSource) {
    for (const [command, ...args] of commands) {
      if (!command) throw new Error(`Invalid semantic plugin command for ${operation.relativeDestPath}`);
      await transport.execFile(command, args, { cwd: operation.destPath });
    }
    return;
  }

  if (!operation.sourcePath) {
    throw new Error(`Invalid semantic plugin operation missing source path: ${operation.relativeDestPath}`);
  }
  const stagingRoot = join(operation.destPath, ".agentwheel", "plugin-staging", `${process.pid}-${Date.now()}`);
  const remoteSourcePath = join(stagingRoot, basename(operation.sourcePath));
  try {
    await transport.atomicCopy(operation.sourcePath, remoteSourcePath, operation.kind);
    for (const [command, ...args] of commands) {
      if (!command) throw new Error(`Invalid semantic plugin command for ${operation.relativeDestPath}`);
      const remoteArgs = args.map((arg) => arg === operation.sourcePath ? remoteSourcePath : arg);
      await transport.execFile(command, remoteArgs, { cwd: operation.destPath });
    }
  } finally {
    await transport.rm(stagingRoot);
  }
}

function isPluginAlreadyAbsentError(operation: InstallOperation, error: unknown): boolean {
  const output = commandErrorOutput(error).toLowerCase();
  if (!output || output.includes("command not found") || output.includes("module not found")) return false;
  const pluginName = (operation.semanticPlugin?.pluginName ?? operation.artifactName).toLowerCase();
  const escapedName = escapeRegExp(pluginName);
  const namedAbsent = [
    new RegExp(`${escapedName}.{0,120}\\b(not installed|not found|does not exist|absent)\\b`, "s"),
    new RegExp(`\\b(not installed|not found|does not exist|absent)\\b.{0,120}${escapedName}`, "s"),
    new RegExp(`\\bunknown plugin\\b.{0,120}${escapedName}`, "s"),
    new RegExp(`${escapedName}.{0,120}\\bunknown plugin\\b`, "s"),
  ].some((pattern) => pattern.test(output));
  const genericAbsent = /\b(no such|unknown)\s+plugins?\b/.test(output)
    || /\bplugins?\b.{0,80}\bnot installed\b/s.test(output);
  return namedAbsent || genericAbsent;
}

function commandErrorOutput(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    if (stderr.trim()) return stderr;
    const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    if (stdout.trim()) return stdout;
  }
  return error instanceof Error ? error.message : String(error);
}

function firstErrorLine(error: unknown): string {
  return commandErrorOutput(error).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "plugin is already absent";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function semanticInstallCommands(operation: InstallOperation): string[][] {
  if (operation.semanticPlugin) return operation.semanticPlugin.installCommands;
  return operation.semanticCommand ? [operation.semanticCommand] : [];
}

function managedBlockMutationOptions(operation: InstallOperation): { expectedHash?: string; allowDrift?: boolean } {
  return {
    expectedHash: operation.overrideDrift ? undefined : operation.manifestHash,
    allowDrift: operation.overrideDrift === true,
  };
}

async function entryForCompletedOperation(
  operation: InstallOperation,
  transport: TargetTransport,
  now: string,
  graphLockDigest: string | undefined,
): Promise<InstallManifestEntry | undefined> {
  if (operation.action === "remove") return undefined;
  if (operation.action === "create" || operation.action === "update") {
    if (operation.mode === managedInstructionBlockMode) {
      const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
      const state = await readManagedInstructionBlockState(operation.destPath, selector, transport);
      return manifestEntryForOperation(operation, {
        now,
        hash: state.hash ?? requireDesiredHash(operation),
        sourceHash: requireDesiredHash(operation),
        graphLockDigest,
      });
    }
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
      hash: (operation.mergeStrategy || operation.mode === managedInstructionBlockMode) && operation.currentHash ? operation.currentHash : requireDesiredHash(operation),
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
    workspaceOwner: operation.workspaceOwner ?? "workspace:unknown",
    kind: operation.kind,
    hash: values.hash,
    sourceHash: values.sourceHash,
    updatedAt: values.now,
    channel: operation.channel,
    packageName: operation.packageName,
    semanticCommand: operation.semanticCommand,
    semanticPlugin: operation.semanticPlugin,
    executed: values.executed ?? operation.execute,
    mergeStrategy: operation.mergeStrategy,
    mergeRemoval: operation.mergeRemoval,
    mergeCreatedDestination: operation.mergeCreatedDestination,
    mode: operation.mode,
    composedFrom: operation.composedFrom,
    graphLockDigest: operation.graphLockDigest ?? values.graphLockDigest,
  };
}

async function assertBaseRevision(plan: InstallPlan, transport: TargetTransport): Promise<void> {
  const current = await readInstallManifest(plan.targetRoot, plan.adapter, transport, {
    installationType: plan.installationType,
    stateKey: plan.stateMigration?.fromStateKey ?? plan.stateKey,
  });
  const currentRevision = current?.revision ?? null;
  if (currentRevision !== plan.baseRevision) {
    throw new Error(`Install manifest changed since planning for ${plan.adapter}; replan needed`);
  }
}

async function assertTargetStateFilePreconditions(
  plan: InstallPlan,
  transport: TargetTransport,
  graphLockWritePath?: string,
): Promise<void> {
  const expected = plan.targetStateFilePreconditions;
  if (!expected) return;
  if (graphLockWritePath && resolve(graphLockWritePath) !== resolve(expected.graphLockPath)) {
    throw new Error(
      `Graph-lock destination changed after planning: expected ${expected.graphLockPath}, found ${graphLockWritePath}; replan needed.`,
    );
  }
  let graphLockRevision: string | null = null;
  if (await pathExists(expected.graphLockPath)) {
    try {
      const graphLock = await readGraphLock(expected.graphLockPath);
      graphLockRevision = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
    } catch (error) {
      throw new Error(
        `Destination graph lock changed after planning at ${expected.graphLockPath}; replan needed: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (graphLockRevision !== expected.graphLockRevision) {
    throw new Error(
      `Destination graph lock changed after planning: expected ${expected.graphLockRevision ?? "missing"}, `
      + `found ${graphLockRevision ?? "missing"}; replan needed.`,
    );
  }
  let sourceLockRevision: string | null;
  try {
    sourceLockRevision = computeSourceLockRevision(await readSourceLock(plan.targetRoot, plan.adapter, transport, {
      installationType: plan.installationType,
      stateKey: plan.stateKey,
    }));
  } catch (error) {
    throw new Error(
      `Destination source lock changed after planning for ${plan.adapter}; replan needed: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (sourceLockRevision !== expected.sourceLockRevision) {
    throw new Error(
      `Destination source lock changed after planning: expected ${expected.sourceLockRevision ?? "missing"}, `
      + `found ${sourceLockRevision ?? "missing"}; replan needed.`,
    );
  }
}

async function assertStateMigrationPreconditions(plan: InstallPlan, transport: TargetTransport): Promise<void> {
  const migration = plan.stateMigration;
  if (!migration) return;
  let graphLock: GraphLock;
  try {
    graphLock = await readGraphLock(migration.fromGraphLockPath);
  } catch (error) {
    throw new Error(
      `Legacy graph lock changed since planning at ${migration.fromGraphLockPath}; replan needed: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  const graphDigest = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
  if (graphDigest !== migration.fromGraphLockDigest) {
    throw new Error(
      `Legacy graph lock changed since planning: expected ${migration.fromGraphLockDigest}, found ${graphDigest}; replan needed.`,
    );
  }
  if (!migration.fromStateKey) return;
  const currentSourceLock = await readSourceLock(plan.targetRoot, plan.adapter, transport, {
    installationType: plan.installationType,
    stateKey: migration.fromStateKey,
  });
  if (canonicalJson(currentSourceLock ?? null) !== canonicalJson(migration.sourceLock ?? null)) {
    throw new Error(`Legacy source lock changed since planning for ${plan.adapter}; replan needed.`);
  }
}

async function assertExactMergeRemovalPreconditions(
  operations: InstallOperation[],
  transport: TargetTransport,
): Promise<void> {
  for (const operation of operations) {
    if (!operation.exactMergeRemoval) continue;
    if (!operation.mergeStrategy || !operation.mergeRemoval) {
      throw new Error(`Invalid exact MCP retirement operation: ${operation.relativeDestPath}`);
    }
    if (!(await transport.pathExists(operation.destPath))) {
      throw new Error(`Exact MCP retirement destination is missing: ${operation.relativeDestPath}`);
    }
    assertExactMcpMergeContribution(
      operation.mergeRemoval,
      operation.mergeStrategy,
      await transport.readFile(operation.destPath),
    );
  }
}

function isJournaledMutation(operation: InstallOperation): boolean {
  if (operation.semanticPlugin && (operation.action === "plugin" || operation.action === "remove")) return false;
  return operation.action === "create" || operation.action === "update" || operation.action === "remove";
}

function operationNeedsSource(operation: InstallOperation): boolean {
  return operation.action === "create" || operation.action === "update";
}

async function operationLanded(operation: InstallOperation, transport: TargetTransport): Promise<boolean> {
  if (operation.action === "remove") {
    if (operation.mode === managedInstructionBlockMode) {
      const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
      const state = await readManagedInstructionBlockState(operation.destPath, selector, transport);
      return !state.exists || !state.hasBlock;
    }
    if (operation.mergeStrategy) {
      const exists = await transport.pathExists(operation.destPath);
      if (operation.mergeCreatedDestination) return !exists;
      if (!operation.mergeRemoval || !exists) return true;
      return mergeContributionAbsent(
        operation.mergeRemoval,
        operation.mergeStrategy,
        await transport.readFile(operation.destPath),
      );
    }
    return !(await transport.pathExists(operation.destPath));
  }
  if (operation.action !== "create" && operation.action !== "update") return false;
  if (!(await transport.pathExists(operation.destPath))) return false;
  if (operation.mode === managedInstructionBlockMode) {
    const selector = managedInstructionSelector(operation.logicalSelector, operation.artifactType, operation.artifactName);
    return managedInstructionBlockLanded(operation.destPath, selector, operation.desiredHash, transport);
  }
  if (operation.mergeStrategy) {
    if (!operation.sourcePath) return false;
    try {
      await assertMergedSourceContribution(
        operation.sourcePath,
        operation.mergeStrategy,
        await transport.readFile(operation.destPath),
      );
      return true;
    } catch {
      return false;
    }
  }
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

async function removeMergeWithTransport(destPath: string, strategy: NonNullable<InstallOperation["mergeStrategy"]>, removal: NonNullable<InstallOperation["mergeRemoval"]>, transport: TargetTransport): Promise<void> {
  if (transport.kind === "local") { await removeMergeContribution(destPath, strategy, removal); return; }
  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-merge-remove-"));
  const localDest = join(tempRoot, basename(destPath) || "merged");
  try {
    await writeFile(localDest, await transport.readFile(destPath), "utf8");
    await removeMergeContribution(localDest, strategy, removal);
    await transport.atomicCopy(localDest, destPath, "file");
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
}

async function mergeOpenClawJsonWithTransport(
  sourcePath: string,
  destPath: string,
  transport: TargetTransport,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-openclaw-merge-"));
  const localDest = join(tempRoot, basename(destPath) || "openclaw.json");
  const validationPath = transport.kind === "local"
    ? localDest
    : `${destPath}.validate-agentwheel-${process.pid}-${Date.now()}`;
  try {
    if (await transport.pathExists(destPath)) {
      await writeFile(localDest, await transport.readFile(destPath), "utf8");
    }
    await mergeOpenClawJsonFile(sourcePath, localDest);
    if (transport.kind !== "local") {
      await transport.atomicCopy(localDest, validationPath, "file");
    }
    await validateOpenClawConfig(validationPath, destPath, transport);
    await transport.atomicCopy(localDest, destPath, "file");
  } finally {
    if (transport.kind !== "local") await transport.rm(validationPath);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function validateOpenClawConfig(
  configPath: string,
  destPath: string,
  transport: TargetTransport,
): Promise<void> {
  if (transport.kind === "local-run-as") {
    if (!transport.validateOpenClawConfig) throw new Error("Run-as transport lacks the allowlisted OpenClaw validator.");
    await transport.validateOpenClawConfig(configPath);
    return;
  }
  if (!transport.execFile) {
    throw new Error(`Cannot validate OpenClaw config over ${transport.description}: transport does not support command execution.`);
  }
  const openClawHome = dirname(destPath);
  const bundledBin = join(openClawHome, "npm", "node_modules", ".bin", "openclaw");
  const script = String.raw`
set -euo pipefail
cfg=$1
bundled_bin=$2
if [ -x "$bundled_bin" ]; then
  bin="$bundled_bin"
elif command -v openclaw >/dev/null 2>&1; then
  bin="openclaw"
else
  echo "OpenClaw binary not found; cannot validate $cfg" >&2
  exit 127
fi
out=$(OPENCLAW_CONFIG_PATH="$cfg" "$bin" config validate --json 2>&1) || {
  printf '%s\n' "$out" >&2
  exit 1
}
printf '%s' "$out" | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const data = JSON.parse(s); if (!data.valid) { console.error(JSON.stringify(data, null, 2)); process.exit(1); } });'
`;
  await transport.execFile("bash", ["-lc", script, "agentwheel-openclaw-validate", configPath, bundledBin]);
}
