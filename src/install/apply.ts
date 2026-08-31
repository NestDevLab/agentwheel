import { execFile } from "node:child_process";
import { declareMutationPath } from "../mutation/declarations.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { InstallManifest, InstallManifestEntry, InstallManifestV2, SourceLock } from "../model/manifest.js";
import type { GraphLock } from "../model/graph-lock.js";
import { canonicalGraphLockJson, readGraphLock, writeGraphLock } from "../model/graph-lock.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { mergeJsonFile } from "./json-merge.js";
import { mergeOpenClawJsonFile } from "./openclaw-json-merge.js";
import { canonicalInstallManifestJson, computeInstallManifestInventoryRevision, readInstallManifest, removeStateFiles, withManifestRevision, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallOperation, InstallPlan } from "./plan.js";
import { assertOperationContained } from "./path-safety.js";
import {
  acquireApplyLock,
  applyJournalPath,
  assertGovernedRuntimeTransportSupported,
  assertApplyJournalRecoveryAllowed,
  listApplyJournals,
  localPathExists,
  readApplyJournal,
  recordBackup,
  removeApplyJournal,
  rollbackCompletedOperations,
  type ApplyJournal,
  type ApplyLockOptions,
  mutationMetadataForApplyJournal,
  writeApplyJournal,
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

export async function recoverPendingApply(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: { installationType?: string; stateKey?: string } = {},
): Promise<InstallManifest | undefined> {
  assertGovernedRuntimeTransportSupported(transport);
  const lock = await acquireApplyLock(targetRoot, adapter, transport, {}, scope);
  try {
    await assertRuntimeJournalGate(targetRoot, adapter, transport, scope, true);
    const journal = await readApplyJournal(targetRoot, adapter, transport, scope);
    if (!journal) return undefined;
    assertApplyJournalRecoveryAllowed(journal);

    if (journal.operations.some((operation) => operation.action === "plugin" || operation.action === "program" || operation.semanticPlugin)) {
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
        await removeApplyJournal(targetRoot, adapter, transport, scope);
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

  const lock = await acquireApplyLock(plan.targetRoot, plan.adapter, transport, options.lock, scope);
  try {
    await assertRuntimeJournalGate(plan.targetRoot, plan.adapter, transport, scope);
    await assertRuntimeStateRevision(plan, transport);
    await assertBaseRevision(plan, transport);
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
      sourceLock: options.sourceLock,
      graphLockPath: options.graphLock?.path,
      graphLock: options.graphLock?.lock,
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
      graphLockPath: resolvedOptions.graphLock?.path,
      graphLock: resolvedOptions.graphLock?.lock,
      graphLockRemovePath: resolvedOptions.removeGraphLockPath,
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
  return commitJournalState(journal, transport, undefined, journal.createdAt);
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
    await removeStateFiles(journal.targetRoot, journal.adapter, transport, {
      installationType: journal.installationType,
      stateKey: journal.stateKey,
    });
  } else {
    if (journal.sourceLock) await writeSourceLock(journal.targetRoot, journal.adapter, journal.sourceLock, transport, {
      installationType: journal.installationType,
      stateKey: journal.stateKey,
    });
    await writeInstallManifest(manifest, transport);
  }
  if (journal.graphLockPath && journal.graphLock) await writeGraphLock(journal.graphLockPath, journal.graphLock);
  if (journal.graphLockRemovePath) {
    declareMutationPath(journal.graphLockRemovePath);
    await rm(journal.graphLockRemovePath, { force: true });
  }
  if (journal.workspaceConfigPath && journal.workspaceConfig) {
    declareMutationPath(journal.workspaceConfigPath);
    await writeJsonAtomic(journal.workspaceConfigPath, journal.workspaceConfig);
  }
  const verifiedManifest = await assertCommittedJournalState(journal, manifest, transport);
  await removeApplyJournal(journal.targetRoot, journal.adapter, transport, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  });
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
  if (journal.mode === "uninstall" && expectedManifest.entries.length === 0) {
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
  if (journal.workspaceConfigPath && journal.workspaceConfig) {
    const actual = JSON.parse(await readFile(journal.workspaceConfigPath, "utf8"));
    if (canonicalJson(actual) !== canonicalJson(journal.workspaceConfig)) {
      throw new Error(`Workspace config postcheck failed for ${journal.workspaceConfigPath}.`);
    }
  }
  return actualManifest;
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
    stateKey: plan.stateKey,
  });
  const currentRevision = current?.revision ?? null;
  if (currentRevision !== plan.baseRevision) {
    throw new Error(`Install manifest changed since planning for ${plan.adapter}; replan needed`);
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
