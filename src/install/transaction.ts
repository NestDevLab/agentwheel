import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { InstallManifestV2, SourceLock } from "../model/manifest.js";
import type { GraphLock } from "../model/graph-lock.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import type { InstallOperation } from "./plan.js";
import { metadataDir, stateKeyFor, type InstallStateScope } from "./paths.js";
import {
  activateActiveRuntimeJournal,
  activeMutationMetadata,
  beginResolveMutationRuntimeJournal,
  reserveActiveRuntimeJournal,
  resolveMutationRuntimeJournal,
} from "../mutation/coordinator.js";
import { mutationOperationIdSchema, mutationReasonSchema } from "../mutation/protocol.js";

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
  version: 1 | 2;
  mutation?: {
    operationId: string;
    reason: string;
    noCommit: boolean;
    transport?: {
      kind: TargetTransport["kind"];
      description: string;
    };
    journalDigest?: string;
  };
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
  stateRemoveKey?: string;
  workspaceConfigPath?: string;
  workspaceConfig?: unknown;
  /** Opt-in, immutable intent for a metadata-only claim release. Recovery rolls forward only. */
  metadataAudit?: MetadataAuditTransaction;
}

export interface MetadataAuditTransaction {
  kind: "ownership-release";
  workspaceRoot: string;
  operationId: string;
  planDigest: string;
  inventory: Array<{ stateKey: string; revision: string }>;
  runtime: Array<{ path: string; hash: string; snapshotDigest: string }>;
  auditFiles: Array<{ path: string; content: string; sha256: string }>;
}

/** Reject symlinks in every existing ancestor, including a missing file's parent chain. */
export async function assertNoSymlinkPath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink path is unsupported: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Includes ignored/cache files too: a reviewed release must detect every runtime byte change. */
export async function ownershipRuntimeSnapshot(path: string): Promise<string> {
  await assertNoSymlinkPath(path);
  const hash = createHash("sha256");
  async function visit(candidate: string): Promise<void> {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`Unsupported ownership runtime path: ${candidate}`);
    }
    hash.update(JSON.stringify([relative(path, candidate), info.isDirectory() ? "dir" : "file", info.mode & 0o7777]));
    if (info.isDirectory()) {
      for (const name of (await readdir(candidate)).sort()) await visit(join(candidate, name));
    } else {
      const content = await readFile(candidate);
      hash.update(String(content.length)).update("\0").update(content);
    }
  }
  await visit(path);
  return hash.digest("hex");
}

export function metadataAuditPath(audit: MetadataAuditTransaction, path: string): string {
  mutationOperationIdSchema.parse(audit.operationId);
  if (resolve(audit.workspaceRoot) !== audit.workspaceRoot
    || path !== `.agentwheel/ownership-releases/${audit.operationId}.json`) {
    throw new Error("Invalid ownership release audit path.");
  }
  return join(audit.workspaceRoot, ...path.split("/"));
}

export function metadataRuntimePath(root: string, path: string): string {
  const result = resolve(root, path);
  if (!path || relative(resolve(root), result).split(sep).join("/") !== path
    || path === ".agentwheel" || path.startsWith(".agentwheel/")
    || result === resolve(root) || !result.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`Unsafe ownership release path: ${path}`);
  }
  return result;
}

/** The opt-in audit transaction makes its journal and committed state durable before resolution. */
export async function syncMetadataPath(path: string, directoryOnly = false): Promise<void> {
  if (!directoryOnly) {
    const file = await open(path, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  const directory = await open(directoryOnly ? path : dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export interface AbortedApplyJournal {
  journalPath: string;
  archivePath: string;
}

export function applyLockPath(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  const installationType = scope.installationType ?? "local";
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, { installationType })}.runtime-apply-lock`);
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
  if (transport.kind === "local-run-as") throw new Error("local-run-as is read-only in PR1; apply and runtime mutations are not supported.");
  const path = applyJournalPath(journal.targetRoot, journal.adapter, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  });
  let link: {
    path: string;
    transport: Exclude<TargetTransport["kind"], "local-run-as">;
    transportDescription: string;
    journalDigest: string;
  } | undefined;
  if (journal.mutation) {
    const digest = applyJournalLinkDigest(journal, transport);
    if (journal.mutation.journalDigest && journal.mutation.journalDigest !== digest) {
      throw new Error(`Runtime apply journal identity changed for ${path}.`);
    }
    if (journal.mutation.transport && (
      journal.mutation.transport.kind !== transport.kind
      || journal.mutation.transport.description !== transport.description
    )) {
      throw new Error(`Runtime apply journal transport changed for ${path}.`);
    }
    journal.mutation.journalDigest = digest;
    journal.mutation.transport = { kind: transport.kind, description: transport.description };
    link = {
      path,
      transport: transport.kind,
      transportDescription: transport.description,
      journalDigest: digest,
    };
    await reserveActiveRuntimeJournal(link);
  }
  await transport.writeJsonAtomic(path, {
    ...journal,
    updatedAt: new Date().toISOString(),
  });
  if (journal.metadataAudit && transport.kind === "local") await syncMetadataPath(path);
  if (link) await activateActiveRuntimeJournal(link);
}

export async function readApplyJournal(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<ApplyJournal | undefined> {
  const path = applyJournalPath(targetRoot, adapter, scope);
  if (!(await transport.pathExists(path))) return undefined;
  return parseApplyJournal(JSON.parse(await transport.readFile(path)));
}

export interface DiscoveredApplyJournal {
  path: string;
  journal: ApplyJournal;
}

export async function listApplyJournals(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: Pick<InstallStateScope, "installationType"> = {},
): Promise<DiscoveredApplyJournal[]> {
  const installationType = scope.installationType ?? "local";
  const suffix = ".apply-journal.json";
  const found: DiscoveredApplyJournal[] = [];
  for (const fileName of await transport.listDir(metadataDir(targetRoot))) {
    if (!fileName.endsWith(suffix)) continue;
    const path = join(metadataDir(targetRoot), fileName);
    const journal = parseApplyJournal(JSON.parse(await transport.readFile(path)));
    if (journal.adapter !== adapter || (journal.installationType ?? "local") !== installationType) continue;
    found.push({ path, journal });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listAllApplyJournals(
  targetRoot: string,
  adapter: string | undefined,
  transport: TargetTransport = localTransport,
): Promise<DiscoveredApplyJournal[]> {
  const suffix = ".apply-journal.json";
  const found: DiscoveredApplyJournal[] = [];
  for (const fileName of await transport.listDir(metadataDir(targetRoot))) {
    if (!fileName.endsWith(suffix)) continue;
    const path = join(metadataDir(targetRoot), fileName);
    const journal = parseApplyJournal(JSON.parse(await transport.readFile(path)));
    if (adapter === undefined || journal.adapter === adapter) found.push({ path, journal });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readLinkedLocalApplyJournal(
  path: string,
  operationId: string,
  expectedDigest: string,
  expectedTransportDescription: string,
): Promise<ApplyJournal> {
  const absolutePath = resolve(path);
  const journal = parseApplyJournal(JSON.parse(await readFile(absolutePath, "utf8")));
  if (journal.version !== 2 || !journal.mutation) {
    throw new Error(`Runtime apply journal ${absolutePath} is not linked to a governed mutation.`);
  }
  if (journal.mutation.operationId !== mutationOperationIdSchema.parse(operationId)) {
    throw new Error(
      `Runtime apply journal ${absolutePath} belongs to mutation ${journal.mutation.operationId}, not ${operationId}.`,
    );
  }
  if (journal.mutation.transport?.kind !== "local"
    || journal.mutation.transport.description !== expectedTransportDescription) {
    throw new Error(`Runtime apply journal ${absolutePath} transport metadata does not match its durable receipt.`);
  }
  if (journal.mutation.journalDigest !== expectedDigest
    || applyJournalLinkDigest(journal, {
      kind: "local",
      description: expectedTransportDescription,
    }) !== expectedDigest) {
    throw new Error(`Runtime apply journal ${absolutePath} digest does not match its durable receipt.`);
  }
  const expectedPath = resolve(applyJournalPath(journal.targetRoot, journal.adapter, {
    installationType: journal.installationType,
    stateKey: journal.stateKey,
  }));
  if (absolutePath !== expectedPath) {
    throw new Error(`Runtime apply journal path mismatch: expected ${expectedPath}, found ${absolutePath}.`);
  }
  return journal;
}

export async function removeApplyJournal(targetRoot: string, adapter: string, transport: TargetTransport = localTransport, scope: InstallStateScope = {}): Promise<void> {
  const existing = await readApplyJournal(targetRoot, adapter, transport, scope);
  const path = applyJournalPath(targetRoot, adapter, scope);
  if (existing?.mutation) await beginResolveMutationRuntimeJournal(existing.mutation.operationId, path);
  await transport.rm(applyJournalPath(targetRoot, adapter, scope));
  await transport.rm(applyBackupDir(targetRoot, adapter, scope));
  if (existing?.metadataAudit && transport.kind === "local") await syncMetadataPath(dirname(path), true);
  if (existing?.mutation) await resolveMutationRuntimeJournal(existing.mutation.operationId, path);
}

export async function abortApplyJournal(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<AbortedApplyJournal | undefined> {
  assertGovernedRuntimeTransportSupported(transport);
  const lock = await acquireApplyLock(targetRoot, adapter, transport, {}, scope);
  try {
    const journalPath = applyJournalPath(targetRoot, adapter, scope);
    if (!(await transport.pathExists(journalPath))) return undefined;
    const stateKey = stateKeyFor(adapter, scope);
    const archivePath = join(metadataDir(targetRoot), "archive", `${stateKey}.apply-journal.failed-${journalTimestamp(new Date())}.json`);
    const content = await transport.readFile(journalPath);
    const journal = parseApplyJournal(JSON.parse(content));
    if (journal.metadataAudit) {
      throw new Error("A metadata-audit transaction must be recovered and verified; abort cannot discard its partial state.");
    }
    await transport.writeFileAtomic(archivePath, content.endsWith("\n") ? content : `${content}\n`);
    if (journal.mutation) await beginResolveMutationRuntimeJournal(journal.mutation.operationId, journalPath);
    await transport.rm(journalPath);
    await transport.rm(applyBackupDir(targetRoot, adapter, scope));
    if (journal.mutation) await resolveMutationRuntimeJournal(journal.mutation.operationId, journalPath);
    return { journalPath, archivePath };
  } finally {
    await lock.release();
  }
}

export function mutationMetadataForApplyJournal(): ApplyJournal["mutation"] {
  const metadata = activeMutationMetadata();
  return metadata
    ? {
        operationId: mutationOperationIdSchema.parse(metadata.operationId),
        reason: mutationReasonSchema.parse(metadata.reason),
        noCommit: metadata.noCommit,
      }
    : undefined;
}

export function assertGovernedRuntimeTransportSupported(transport: TargetTransport): void {
  if (transport.kind === "local-run-as") {
    throw new Error("local-run-as is read-only in PR1; apply and runtime mutations are not supported.");
  }
  const active = activeMutationMetadata();
  if (active && transport.kind !== "local") {
    throw new Error(
      `Governed runtime apply refuses ${transport.description} before writes; durable remote journal recovery is not implemented.`,
    );
  }
}

export function applyJournalLinkDigest(
  journal: ApplyJournal,
  transport: Pick<TargetTransport, "kind" | "description">,
): string {
  if (!journal.mutation) throw new Error("Cannot digest an unlinked runtime apply journal.");
  return createHash("sha256").update(canonicalJson({
    version: journal.version,
    mutation: {
      operationId: journal.mutation.operationId,
      reason: journal.mutation.reason,
      noCommit: journal.mutation.noCommit,
    },
    transport,
    mode: journal.mode ?? "apply",
    adapter: journal.adapter,
    installationType: journal.installationType ?? null,
    stateKey: journal.stateKey ?? null,
    targetRoot: resolve(journal.targetRoot),
    baseRevision: journal.baseRevision,
    graphLockDigest: journal.graphLockDigest ?? null,
    graphLockPath: journal.graphLockPath ?? null,
    graphLockRemovePath: journal.graphLockRemovePath ?? null,
    stateRemoveKey: journal.stateRemoveKey ?? null,
    workspaceConfigPath: journal.workspaceConfigPath ?? null,
    operations: journal.operations,
    ...(journal.metadataAudit ? { metadataAudit: journal.metadataAudit, manifest: journal.manifest } : {}),
  })).digest("hex");
}

export function assertApplyJournalRecoveryAllowed(journal: ApplyJournal): void {
  const active = activeMutationMetadata();
  if (!active) return;
  if (journal.version === 1) {
    throw new Error(
      "A governed mutation refuses automatic recovery of a legacy v1 apply journal; inspect it and use an explicit journal recovery/abort workflow first.",
    );
  }
  if (!journal.mutation || journal.mutation.operationId !== active.operationId) {
    throw new Error(
      `Pending apply journal belongs to mutation ${journal.mutation?.operationId ?? "unknown"}; current mutation ${active.operationId} may not adopt it.`,
    );
  }
}

function parseApplyJournal(value: unknown): ApplyJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agentwheel apply journal.");
  const journal = value as ApplyJournal;
  if (journal.version !== 1 && journal.version !== 2) throw new Error(`Unsupported Agentwheel apply journal version: ${String(journal.version)}.`);
  if (journal.version === 1 && journal.mutation) throw new Error("Legacy Agentwheel apply journals may not contain mutation metadata.");
  if (journal.version === 2 && journal.mutation) {
    journal.mutation = {
      operationId: mutationOperationIdSchema.parse(journal.mutation.operationId),
      reason: mutationReasonSchema.parse(journal.mutation.reason),
      noCommit: journal.mutation.noCommit === true,
      transport: parseMutationTransport(journal.mutation.transport),
      journalDigest: parseJournalDigest(journal.mutation.journalDigest),
    };
  }
  return journal;
}

function parseMutationTransport(value: unknown): NonNullable<NonNullable<ApplyJournal["mutation"]>["transport"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Governed runtime apply journal is missing transport metadata.");
  }
  const record = value as { kind?: unknown; description?: unknown };
  if ((record.kind !== "local" && record.kind !== "ssh")
    || typeof record.description !== "string"
    || record.description.length === 0
    || record.description.length > 1024) {
    throw new Error("Governed runtime apply journal has invalid transport metadata.");
  }
  return { kind: record.kind, description: record.description };
}

function parseJournalDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Governed runtime apply journal is missing its durable link digest.");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
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

function journalTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function localPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
