import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallManifestV2, SourceLock } from "../model/manifest.js";
import type { GraphLock } from "../model/graph-lock.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import type { InstallOperation } from "./plan.js";
import { metadataDir, stateKeyFor, type InstallStateScope } from "./paths.js";

export interface ApplyLockOptions {
  staleAfterMs?: number;
}

export interface ApplyLock {
  path: string;
  release(): Promise<void>;
}

export interface ApplyJournalCompletedOperation {
  index: number;
  destPath: string;
  kind: "file" | "dir";
  hadExisting: boolean;
  backupPath?: string;
  completed?: boolean;
}

export interface ApplyJournal {
  version: 1;
  mode?: "apply" | "uninstall";
  adapter: string;
  installationType?: string;
  stateKey?: string;
  targetRoot: string;
  baseRevision: string | null;
  graphLockDigest?: string;
  createdAt: string;
  updatedAt: string;
  operations: InstallOperation[];
  completed: ApplyJournalCompletedOperation[];
  manifest: InstallManifestV2;
  sourceLock?: SourceLock;
  graphLockPath?: string;
  graphLock?: GraphLock;
  graphLockRemovePath?: string;
  workspaceConfigPath?: string;
  workspaceConfig?: unknown;
}

export function applyLockPath(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, scope)}.apply-lock`);
}

export function applyJournalPath(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, scope)}.apply-journal.json`);
}

export function applyBackupDir(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, scope)}.apply-backups`);
}

export async function acquireApplyLock(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  options: ApplyLockOptions = {},
  scope: InstallStateScope = {},
): Promise<ApplyLock> {
  const lockPath = applyLockPath(targetRoot, adapter, scope);
  const ownerPath = join(lockPath, "owner.json");
  const metadata = {
    pid: process.pid,
    adapter,
    installationType: scope.installationType,
    stateKey: scope.stateKey,
    targetRoot,
    transport: transport.description,
    createdAt: new Date().toISOString(),
  };

  try {
    await transport.mkdirExclusive(lockPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await handleExistingLock(lockPath, ownerPath, transport, options);
    await transport.mkdirExclusive(lockPath);
  }
  await transport.writeJsonAtomic(ownerPath, metadata);

  return {
    path: lockPath,
    release: () => transport.rm(lockPath),
  };
}

export async function writeApplyJournal(journal: ApplyJournal, transport: TargetTransport = localTransport): Promise<void> {
  await transport.writeJsonAtomic(applyJournalPath(journal.targetRoot, journal.adapter, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  }), {
    ...journal,
    updatedAt: new Date().toISOString(),
  });
}

export async function readApplyJournal(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<ApplyJournal | undefined> {
  const path = applyJournalPath(targetRoot, adapter, scope);
  if (!(await transport.pathExists(path))) return undefined;
  return JSON.parse(await transport.readFile(path)) as ApplyJournal;
}

export async function removeApplyJournal(targetRoot: string, adapter: string, transport: TargetTransport = localTransport, scope: InstallStateScope = {}): Promise<void> {
  await transport.rm(applyJournalPath(targetRoot, adapter, scope));
  await transport.rm(applyBackupDir(targetRoot, adapter, scope));
}

export async function recordBackup(
  operation: InstallOperation,
  index: number,
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<ApplyJournalCompletedOperation> {
  const hadExisting = await transport.pathExists(operation.destPath);
  if (!hadExisting || transport.kind !== "local" || (operation.action !== "update" && operation.action !== "remove" && operation.action !== "create")) {
    return {
      index,
      destPath: operation.destPath,
      kind: operation.kind,
      hadExisting,
    };
  }

  const backupPath = join(applyBackupDir(targetRoot, adapter, scope), String(index));
  await rm(backupPath, { recursive: true, force: true });
  await mkdir(dirname(backupPath), { recursive: true });
  await cp(operation.destPath, backupPath, { recursive: operation.kind === "dir", dereference: true });
  return {
    index,
    destPath: operation.destPath,
    kind: operation.kind,
    hadExisting,
    backupPath,
  };
}

export async function rollbackCompletedOperations(
  completed: ApplyJournalCompletedOperation[],
  transport: TargetTransport = localTransport,
): Promise<void> {
  for (const item of [...completed].sort((a, b) => b.index - a.index)) {
    if (item.hadExisting && item.backupPath) {
      await transport.atomicCopy(item.backupPath, item.destPath, item.kind);
    } else if (!item.hadExisting) {
      await transport.rm(item.destPath);
    } else {
      throw new Error(`Cannot roll back ${item.destPath}: no backup was recorded for ${transport.description}`);
    }
  }
}

async function handleExistingLock(
  lockPath: string,
  ownerPath: string,
  transport: TargetTransport,
  options: ApplyLockOptions,
): Promise<void> {
  const owner = await readLockOwner(ownerPath, transport);
  if (options.staleAfterMs !== undefined && owner?.createdAt) {
    const ageMs = Date.now() - Date.parse(owner.createdAt);
    if (Number.isFinite(ageMs) && ageMs > options.staleAfterMs) {
      await transport.rm(lockPath);
      return;
    }
  }
  const ownerDetails = owner ? ` created by pid ${owner.pid} at ${owner.createdAt}` : "";
  throw new Error(`Apply lock already exists at ${lockPath}${ownerDetails}. Run recovery or remove the lock after verifying no sync is running.`);
}

async function readLockOwner(ownerPath: string, transport: TargetTransport): Promise<{ pid?: number; createdAt?: string } | undefined> {
  try {
    if (!(await transport.pathExists(ownerPath))) return undefined;
    return JSON.parse(await transport.readFile(ownerPath)) as { pid?: number; createdAt?: string };
  } catch {
    return undefined;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

export async function localPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
