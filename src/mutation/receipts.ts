import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { revisionProviderConfigSchema } from "../model/mutation.js";
import { revisionPathSchema, revisionProviderResultSchema, mutationOperationIdSchema } from "./protocol.js";
import {
  describeMutationLockOwner,
  runtimeUuidForCurrentProcess,
  type MutationLockOwnerFacts,
} from "./session-ownership.js";

const preexistingPathSchema = z.object({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

const receiptStatusSchema = z.enum([
  "prepared",
  "handler-succeeded",
  "mutation-applied",
  "succeeded",
  "revisioning-skipped",
  "no-repository-delta",
  "commit-pending",
  "precheck-failed",
  "partial",
  "postcheck-failed",
  "failed",
]);

export const runtimeJournalSchema = z.object({
  path: z.string().min(1).max(4096),
  status: z.enum(["reserved", "pending", "resolving", "resolved"]),
  transport: z.enum(["local", "ssh"]),
  transportDescription: z.string().min(1).max(1024),
  journalDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RuntimeJournalReceipt = z.infer<typeof runtimeJournalSchema>;

const mutationReceiptBaseSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(1),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: mutationOperationIdSchema,
  commandName: z.string().min(1).max(256),
  reason: z.string().min(1).max(4096),
  noCommit: z.boolean(),
  workspaceRoot: z.string().min(1),
  repositoryRoot: z.string().min(1).nullable(),
  expectedHead: z.string().min(1).max(256).nullable(),
  expectedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  revisionMode: z.enum(["off", "commit-after-verify"]),
  provider: revisionProviderConfigSchema.nullable(),
  preexistingPaths: z.array(preexistingPathSchema),
  paths: z.array(revisionPathSchema),
  runtimeJournals: z.array(runtimeJournalSchema).default([]),
  status: receiptStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  providerResponse: revisionProviderResultSchema.optional(),
  error: z.string().min(1).max(4096).optional(),
}).strict();

export const mutationReceiptSchema = mutationReceiptBaseSchema.superRefine((receipt, ctx) => {
  const expected = mutationReceiptDigest(receipt);
  if (receipt.receiptDigest !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["receiptDigest"],
      message: `Mutation receipt digest mismatch: expected ${expected}`,
    });
  }
});

export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
export type MutationReceiptStatus = z.infer<typeof receiptStatusSchema>;

export interface MutationLock {
  path: string;
  release(): Promise<void>;
}

export class MutationLockContentionError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly owner: MutationLockOwnerFacts | undefined,
    diagnostic: string,
  ) {
    super(`Another Agentwheel mutation owns the repository lock at ${lockPath}. ${diagnostic}`);
    this.name = "MutationLockContentionError";
  }
}

export function mutationStateRoot(): string {
  return resolve(process.env.AGENTWHEEL_MUTATION_STATE_ROOT ?? join(homedir(), ".agentwheel", "mutations"));
}

export async function createMutationReceipt(
  receipt: Omit<MutationReceipt, "version" | "revision" | "receiptDigest" | "createdAt" | "updatedAt">,
): Promise<MutationReceipt> {
  const path = receiptPath(receipt.operationId);
  await ensureStateDirectory();
  const reservation = `${path}.reserve`;
  try {
    await open(reservation, "wx", 0o600).then(async (handle) => {
      await handle.sync();
      await handle.close();
    });
    await fsyncDirectory(dirname(path));
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error(`Mutation operation '${receipt.operationId}' already has a durable receipt.`);
    throw error;
  }
  try {
    if (await fileExists(path)) throw new Error(`Mutation operation '${receipt.operationId}' already has a durable receipt.`);
    const now = new Date().toISOString();
    const parsed = sealMutationReceipt({
      ...receipt,
      version: 1,
      revision: 1,
      receiptDigest: "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    await writeReceipt(path, parsed);
    return parsed;
  } finally {
    await rm(reservation, { force: true });
    await fsyncDirectory(dirname(path));
  }
}

export async function updateMutationReceipt(
  receipt: MutationReceipt,
  patch: Partial<Pick<MutationReceipt, "paths" | "runtimeJournals" | "status" | "providerResponse" | "error">>,
): Promise<MutationReceipt> {
  const path = receiptPath(receipt.operationId);
  const release = await acquireReceiptUpdateLock(path, receipt.operationId);
  try {
    const current = await readMutationReceipt(receipt.operationId);
    if (current.revision !== receipt.revision || current.receiptDigest !== receipt.receiptDigest) {
      throw new Error(
        `Mutation receipt '${receipt.operationId}' changed concurrently: expected revision ${receipt.revision}/${receipt.receiptDigest}, found ${current.revision}/${current.receiptDigest}.`,
      );
    }
    const next = sealMutationReceipt({
      ...current,
      ...patch,
      revision: current.revision + 1,
      receiptDigest: "0".repeat(64),
      updatedAt: new Date().toISOString(),
    });
    await writeReceipt(path, next);
    return next;
  } finally {
    await release();
  }
}

export async function readMutationReceipt(operationId: string): Promise<MutationReceipt> {
  const id = mutationOperationIdSchema.parse(operationId);
  const path = receiptPath(id);
  try {
    return mutationReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error)) throw new Error(`Unknown mutation operation '${id}'.`);
    throw error;
  }
}

export async function listMutationReceipts(): Promise<MutationReceipt[]> {
  const root = join(mutationStateRoot(), "receipts");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const receipts: MutationReceipt[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    receipts.push(mutationReceiptSchema.parse(JSON.parse(await readFile(join(root, name), "utf8"))));
  }
  return receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function acquireMutationLock(repositoryRoot: string, operationId: string): Promise<MutationLock> {
  const root = mutationStateRoot();
  const digest = createHash("sha256").update(resolve(repositoryRoot)).digest("hex");
  const lockPath = join(root, "locks", `${digest}.lock`);
  await mkdir(join(root, "locks"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "locks"), 0o700);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (!(await reapStaleLock(lockPath))) {
      const owner = await readMutationLockOwner(lockPath);
      throw new MutationLockContentionError(lockPath, owner, await describeMutationLockOwner(owner));
    }
    await mkdir(lockPath, { mode: 0o700 });
  }
  const ownerPath = join(lockPath, "owner.json");
  await writeSecureJson(ownerPath, {
    version: 1,
    operationId,
    pid: process.pid,
    runtimeUuid: runtimeUuidForCurrentProcess(),
    repositoryRoot: resolve(repositoryRoot),
    createdAt: new Date().toISOString(),
  });
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

async function readMutationLockOwner(lockPath: string): Promise<MutationLockOwnerFacts | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Record<string, unknown>;
    const owner: MutationLockOwnerFacts = {};
    if (typeof parsed.operationId === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(parsed.operationId)) {
      owner.operationId = parsed.operationId;
    }
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) owner.pid = parsed.pid;
    if (typeof parsed.runtimeUuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.runtimeUuid)) {
      owner.runtimeUuid = parsed.runtimeUuid.toLowerCase();
    }
    if (typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))) {
      owner.createdAt = parsed.createdAt;
    }
    return Object.keys(owner).length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

function receiptPath(operationId: string): string {
  return join(mutationStateRoot(), "receipts", `${mutationOperationIdSchema.parse(operationId)}.json`);
}

async function ensureStateDirectory(): Promise<void> {
  const root = mutationStateRoot();
  await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(join(root, "receipts"), 0o700);
}

async function writeReceipt(path: string, receipt: MutationReceipt): Promise<void> {
  await writeSecureJson(path, receipt);
}

function sealMutationReceipt(value: z.input<typeof mutationReceiptBaseSchema>): MutationReceipt {
  const parsed = mutationReceiptBaseSchema.parse(value);
  return mutationReceiptSchema.parse({ ...parsed, receiptDigest: mutationReceiptDigest(parsed) });
}

export function mutationReceiptDigest(receipt: Record<string, unknown>): string {
  const { receiptDigest: _ignored, ...payload } = receipt;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function acquireReceiptUpdateLock(path: string, operationId: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.cas-lock`;
  const candidatePath = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
  const candidate = await open(candidatePath, "wx", 0o600);
  try {
    await candidate.writeFile(`${JSON.stringify({
      version: 1,
      operationId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    await candidate.sync();
  } finally {
    await candidate.close();
  }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(candidatePath, lockPath);
        await fsyncDirectory(dirname(lockPath));
        acquired = true;
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (!(await reapStaleReceiptUpdateLock(lockPath))) {
          throw new Error(`Mutation receipt '${operationId}' has another active compare-and-swap writer.`);
        }
      }
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
  if (!acquired) throw new Error(`Mutation receipt '${operationId}' compare-and-swap lock could not be acquired.`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true });
    await fsyncDirectory(dirname(lockPath));
  };
}

async function reapStaleReceiptUpdateLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || processIsAlive(owner.pid)) return false;
  } catch {
    return false;
  }
  const archive = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockPath, archive);
    await rm(archive, { force: true });
    await fsyncDirectory(dirname(lockPath));
    return true;
  } catch {
    return false;
  }
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
  await fsyncDirectory(dirname(path));
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || processIsAlive(owner.pid)) return false;
  } catch (error) {
    // A contender can observe the directory between mkdir and owner.json publication.
    // Missing or unreadable ownership is busy, never evidence that the lock is stale.
    return false;
  }
  const archive = `${lockPath}.stale-${Date.now()}`;
  try {
    await rename(lockPath, archive);
    await rm(archive, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
