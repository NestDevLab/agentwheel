import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverPendingApply } from "../src/install/apply.js";
import {
  acquireApplyLock, applyBackupDir, applyJournalLinkDigest, applyJournalPath,
  assertApplyJournalCompletedOperations, assertGovernedRuntimeTransportSupported, readLinkedApplyJournal, recordBackup,
  type ApplyJournal,
} from "../src/install/transaction.js";
import { beginMutationPathDeclarations, endMutationPathDeclarations } from "../src/mutation/declarations.js";
import { GovernedMutation, recoverMutationRuntime, reserveActiveRuntimeJournal } from "../src/mutation/coordinator.js";
import { createMutationReceipt, runtimeJournalSchema } from "../src/mutation/receipts.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import type { RunAsIdentity } from "../src/transport/run-as-identity.js";

const seams = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));
vi.mock("../src/transport/run-as-identity.js", async (original) => ({
  ...await original<typeof import("../src/transport/run-as-identity.js")>(),
  resolveRunAsIdentity: seams.resolve,
}));
vi.mock("../src/transport/index.js", async (original) => ({
  ...await original<typeof import("../src/transport/index.js")>(),
  createRunAsTransport: seams.create,
}));

const identity: RunAsIdentity = { user: "service", uid: 1234, gid: 1234, home: "/srv/service", root: "/srv/service" };
const description = "local-run-as service (1234:1234) /srv/service";
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  if (originalStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalStateRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeTransport(): TargetTransport {
  return {
    ...localTransport, kind: "local-run-as", description,
    runAsIdentity: identity, prepareApply: vi.fn(async () => {}),
    pathExists: vi.fn(async () => true), rm: vi.fn(async () => {}),
    copyWithin: vi.fn(async () => {}), atomicCopy: vi.fn(async () => {}), mkdirExclusive: vi.fn(async () => {}),
    writeJsonAtomic: vi.fn(async () => {}),
  };
}
function journal(): ApplyJournal {
  return {
    version: 2, mutation: { operationId: "run-as-recovery", reason: "Recover interrupted install", noCommit: false },
    adapter: "codex", targetRoot: identity.root, baseRevision: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    operations: [], completed: [], manifest: {} as ApplyJournal["manifest"],
  };
}
function link() {
  return { path: applyJournalPath(identity.root, "codex"), status: "pending" as const,
    transport: "local-run-as" as const, transportDescription: description,
    journalDigest: "a".repeat(64), runAsIdentity: identity };
}

describe("durable local run-as recovery", () => {
  it("retains the established local v2 digest across the run-as upgrade", () => {
    // Golden digest from the preceding release's local v2 contract.
    expect(applyJournalLinkDigest(journal(), { kind: "local", description: "local" }))
      .toBe("9af0bbb66aff10ebbb56bf4b51b7c9af5da44fb762c00bd8789f89a00f0b7b49");
  });
  it("requires exact structured identity only for run-as receipts", () => {
    expect(runtimeJournalSchema.parse(link()).runAsIdentity).toEqual(identity);
    expect(runtimeJournalSchema.safeParse({ ...link(), runAsIdentity: undefined }).success).toBe(false);
    expect(runtimeJournalSchema.safeParse({ ...link(), transport: "local" }).success).toBe(false);
    expect(runtimeJournalSchema.safeParse({ ...link(), runAsIdentity: { ...identity, extra: true } }).success).toBe(false);
    for (const patch of [{ user: "root" }, { uid: 0 }, { gid: -1 }, { root: "/" }, { root: "/srv/../service" }, { home: "relative" }]) {
      expect(runtimeJournalSchema.safeParse({ ...link(), runAsIdentity: { ...identity, ...patch } }).success).toBe(false);
    }
  });

  it("prepares the service transport before any lock write and fails closed without its capabilities", async () => {
    const transport = fakeTransport();
    const calls: string[] = [];
    transport.prepareApply = async () => { calls.push("prepare"); };
    transport.mkdirExclusive = async () => { calls.push("mkdir"); };
    await acquireApplyLock(identity.root, "codex", transport);
    expect(calls).toEqual(["prepare", "mkdir"]);
    expect(() => assertGovernedRuntimeTransportSupported({ ...transport, runAsIdentity: undefined })).toThrow(/pinned identity/);
    expect(() => assertGovernedRuntimeTransportSupported({ ...transport, prepareApply: undefined })).toThrow(/preparation/);
  });

  it("backs up inaccessible target files entirely through the service transport", async () => {
    const transport = fakeTransport();
    const destPath = join(identity.root, "skills", "example.md");
    const operation = { action: "update", kind: "file", destPath } as ApplyJournal["operations"][number];
    const backup = await recordBackup(operation, 3, identity.root, "codex", transport);
    const backupPath = join(applyBackupDir(identity.root, "codex"), "3");
    expect(transport.rm).toHaveBeenCalledWith(backupPath);
    expect(transport.copyWithin).toHaveBeenCalledWith(destPath, backupPath, "file");
    expect(transport.atomicCopy).not.toHaveBeenCalled();
    expect(backup.backupPath).toBe(backupPath);
  });

  it("reads linked journals through transport and enforces descriptor, digest and path", async () => {
    const transport = fakeTransport();
    const value = journal();
    const digest = applyJournalLinkDigest(value, transport);
    expect(digest).toBe(applyJournalLinkDigest(value, { kind: transport.kind, description }));
    value.mutation!.transport = { kind: transport.kind, description };
    value.mutation!.journalDigest = digest;
    transport.readFile = vi.fn(async () => JSON.stringify(value));
    const path = applyJournalPath(value.targetRoot, value.adapter);
    await expect(readLinkedApplyJournal(path, "run-as-recovery", digest, description, transport)).resolves.toMatchObject({ targetRoot: identity.root });
    expect(transport.readFile).toHaveBeenCalledWith(path);
    await expect(readLinkedApplyJournal(path, "run-as-recovery", digest, "wrong", transport)).rejects.toThrow(/transport/);
    await expect(readLinkedApplyJournal(path, "run-as-recovery", "b".repeat(64), description, transport)).rejects.toThrow(/digest/);
    await expect(readLinkedApplyJournal(`${path}.wrong`, "run-as-recovery", digest, description, transport)).rejects.toThrow(/path mismatch/);
    value.mutation!.transport.kind = "local";
    await expect(readLinkedApplyJournal(path, "run-as-recovery", digest, description, transport)).rejects.toThrow(/transport metadata/);
  });

  it("pins every caller-side write payload and the ordinary manifest", () => {
    const value = journal();
    const transport = fakeTransport();
    const digest = applyJournalLinkDigest(value, transport);
    for (const patch of [
      { workspaceConfig: { untrusted: true } }, { graphLock: { untrusted: true } },
      { manifest: { untrusted: true } }, { sourceLock: { untrusted: true } },
    ]) {
      expect(applyJournalLinkDigest({ ...value, ...patch } as ApplyJournal, transport)).not.toBe(digest);
    }
  });

  it("rejects forged completion destinations, indices and backup paths", () => {
    const value = journal();
    const destPath = join(identity.root, "example.md");
    value.operations = [{ action: "update", kind: "file", destPath } as ApplyJournal["operations"][number]];
    value.mutation!.transport = { kind: "local-run-as", description };
    const completion = { index: 0, kind: "file" as const, destPath, hadExisting: true,
      backupPath: join(applyBackupDir(identity.root, "codex"), "0") };
    for (const patch of [{ index: 1 }, { destPath: "/outside" }, { backupPath: "/outside" }, { hadExisting: false }]) {
      value.completed = [{ ...completion, ...patch }];
      expect(() => assertApplyJournalCompletedOperations(value)).toThrow(/completion/);
    }
    value.completed = [completion, completion];
    expect(() => assertApplyJournalCompletedOperations(value)).toThrow(/duplicate/);
  });

  it("refuses executable recovery before preparing or creating the target lock", async () => {
    const transport = fakeTransport();
    const value = journal();
    value.operations = [{ action: "program" } as ApplyJournal["operations"][number]];
    value.mutation!.transport = { kind: "local-run-as", description };
    const digest = applyJournalLinkDigest(value, transport);
    value.mutation!.journalDigest = digest;
    transport.readFile = vi.fn(async () => JSON.stringify(value));
    await expect(recoverPendingApply(identity.root, "codex", transport, {}, {
      ...link(), operationId: "run-as-recovery", journalDigest: digest,
      reason: value.mutation!.reason, noCommit: false,
    })).rejects.toThrow(/programmatic/);
    expect(transport.prepareApply).not.toHaveBeenCalled();
    expect(transport.mkdirExclusive).not.toHaveBeenCalled();
  });

  it("revalidates the consumed journal under the runtime lock after a service-side swap", async () => {
    const transport = fakeTransport();
    const value = journal();
    value.mutation!.transport = { kind: "local-run-as", description };
    const digest = applyJournalLinkDigest(value, transport);
    value.mutation!.journalDigest = digest;
    const swapped = { ...value, workspaceConfigPath: "/outside/config.json", workspaceConfig: { unsafe: true } };
    let locked = false;
    transport.mkdirExclusive = vi.fn(async () => { locked = true; });
    transport.listDir = vi.fn(async () => []);
    transport.readFile = vi.fn(async () => JSON.stringify(locked ? swapped : value));
    await expect(recoverPendingApply(identity.root, "codex", transport, {}, {
      ...link(), operationId: "run-as-recovery", journalDigest: digest,
      reason: value.mutation!.reason, noCommit: false,
    })).rejects.toThrow(/digest/);
    expect(transport.copyWithin).not.toHaveBeenCalled();
    expect(transport.atomicCopy).not.toHaveBeenCalled();
    expect(transport.writeJsonAtomic).toHaveBeenCalledTimes(1); // lock owner only
  });

  it("rejects receipt link collisions when any pinned account field changes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-runas-link-"));
    roots.push(workspaceRoot);
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(workspaceRoot, "state");
    const receipt = await createMutationReceipt({
      operationId: "run-as-link", commandName: "agentwheel install", reason: "Reject identity collision",
      noCommit: false, workspaceRoot, repositoryRoot: null, expectedHead: null, expectedManifestDigest: null,
      revisionMode: "off", provider: null, preexistingPaths: [], paths: [], status: "partial",
      runtimeJournals: [link()],
    });
    const mutation = GovernedMutation.activateExisting(receipt, undefined, { path: "test", release: async () => {} });
    try {
      for (const patch of [{ user: "another" }, { uid: 2345 }, { gid: 2345 }, { home: "/srv/another" }, { root: "/srv/another" }]) {
        await expect(reserveActiveRuntimeJournal({ ...link(), runAsIdentity: { ...identity, ...patch } })).rejects.toThrow(/link collision/);
      }
    } finally {
      await mutation.fail(new Error("test completed"));
    }
  });

  it.each([false, true])("revalidates pinned identity before any target access (changed=%s)", async (changed) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-runas-recovery-"));
    roots.push(workspaceRoot);
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(workspaceRoot, "state");
    const transport = fakeTransport();
    transport.pathExists = vi.fn(async () => false);
    seams.resolve.mockReturnValue({ ...identity, uid: changed ? 5678 : identity.uid });
    seams.create.mockReturnValue(transport);
    await createMutationReceipt({
      operationId: "run-as-recovery", commandName: "agentwheel install", reason: "Recover interrupted install",
      noCommit: false, workspaceRoot, repositoryRoot: null, expectedHead: null, expectedManifestDigest: null,
      revisionMode: "off", provider: null, preexistingPaths: [], paths: [], status: "partial",
      runtimeJournals: [{ ...link(), status: "resolving" }],
    });
    beginMutationPathDeclarations(workspaceRoot, "run-as-recovery");
    endMutationPathDeclarations();
    if (changed) {
      await expect(recoverMutationRuntime("run-as-recovery")).rejects.toThrow(/identity changed/);
      expect(seams.create).not.toHaveBeenCalled();
      expect(transport.pathExists).not.toHaveBeenCalled();
    } else {
      const receipt = await recoverMutationRuntime("run-as-recovery");
      expect(receipt.runtimeJournals[0]?.status).toBe("resolved");
      expect(transport.pathExists).toHaveBeenCalledWith(link().path);
    }
    expect(seams.resolve).toHaveBeenCalledWith(identity.user, identity.root);
  });
});
