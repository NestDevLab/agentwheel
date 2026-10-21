import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitManifestMetadataJournal, recoverPendingApply } from "../src/install/apply.js";
import { readInstallManifest, withManifestRevision, writeInstallManifest } from "../src/install/manifest.js";
import { exactManagedInstructionBlockSnapshot } from "../src/install/instructions-block.js";
import { installManifestPath } from "../src/install/paths.js";
import {
  acquireApplyLock, applyJournalPath, assertOwnershipMetadataAuditPaths, assertOwnershipMetadataTransportSupported,
  metadataAuditPath, mutationMetadataForApplyJournal, observeOwnershipRuntime,
  writeApplyJournal, type ApplyJournal,
} from "../src/install/transaction.js";
import type { InstallManifestV2 } from "../src/model/manifest.js";
import { GovernedMutation } from "../src/mutation/coordinator.js";
import { createMutationReceipt, readMutationReceipt } from "../src/mutation/receipts.js";
import { createRunAsTransport, type RunAsRunner } from "../src/transport/run-as.js";
import { executeRequest, type RunAsRequest } from "../src/transport/run-as-worker.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

// Allow real helper subprocesses to finish under full-suite contention.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
const mutations: GovernedMutation[] = [];
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  for (const mutation of mutations.splice(0)) await mutation.fail(new Error("Fixture finished")).catch(() => {});
  if (originalStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalStateRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope = { installationType: "user", stateKey: `openclaw.user.${"c".repeat(64)}` };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-runas-metadata-")); roots.push(root);
  const target = join(root, "target"), workspace = join(root, "caller");
  await mkdir(target); await mkdir(workspace);
  const requests: RunAsRequest[] = [];
  const runner: RunAsRunner = async (_command, _args, input) => {
    if (!input) return { stdout: "65534\n" };
    const request = JSON.parse(input) as RunAsRequest; requests.push(request);
    try { return { stdout: JSON.stringify({ version: 1, result: await executeRequest(target, process.getuid!(), process.getgid!(), request) }) }; }
    catch (error) { return { stdout: JSON.stringify({ version: 1, error: { message: String(error), code: (error as NodeJS.ErrnoException).code } }) }; }
  };
  // Use a real distinct service identity for ACL/group trust checks; only the injected
  // filesystem helper uses the fixture owner's UID to avoid creating system users.
  const transport = createRunAsTransport({ user: "nobody", uid: 65534, gid: 65534, home: target, root: target }, runner, undefined, "/usr/bin/python3");
  const runtimePath = join(target, "runtime.md"); await writeFile(runtimePath, "preserve runtime\n");
  const manifest: InstallManifestV2 = {
    version: 2, adapter: "openclaw", ...scope, targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z",
    revision: "pending-fixture-revision", legacy: false, entries: [],
  };
  await writeInstallManifest(manifest, transport);
  const before = (await readInstallManifest(target, "openclaw", transport, scope)) as InstallManifestV2;
  return { root, target, workspace, transport, requests, runtimePath, before };
}
async function governed(f: Awaited<ReturnType<typeof fixture>>) {
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(f.workspace, "mutations");
  const receipt = await createMutationReceipt({
    operationId: "metadata-fixture", commandName: "agentwheel ownership release", reason: "Release reviewed ownership",
    noCommit: false, workspaceRoot: f.workspace, repositoryRoot: null, expectedHead: null, expectedManifestDigest: null,
    revisionMode: "off", provider: null, preexistingPaths: [], paths: [], runtimeJournals: [], status: "prepared",
  });
  const mutation = GovernedMutation.activateExisting(receipt, undefined, { path: "fixture", release: async () => {} });
  mutations.push(mutation);
}
async function journal(f: Awaited<ReturnType<typeof fixture>>, audit = true): Promise<ApplyJournal> {
  const observation = await observeOwnershipRuntime(f.runtimePath, f.transport);
  const guards = {
    inventory: [{ stateKey: scope.stateKey, revision: f.before.revision }],
    runtime: [{ path: "runtime.md", hash: await f.transport.hashPath(f.runtimePath), snapshotDigest: observation.snapshotDigest }],
  };
  const content = JSON.stringify({ reviewed: true });
  return {
    version: 2, mutation: mutationMetadataForApplyJournal(), mode: "uninstall", adapter: "openclaw", ...scope,
    targetRoot: f.target, baseRevision: f.before.revision, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    operations: [], completed: [], manifest: withManifestRevision({ ...f.before, generatedAt: "2026-01-02T00:00:00.000Z" }),
    ...(audit ? { metadataAudit: { ...guards, kind: "ownership-release" as const, workspaceRoot: f.workspace,
      operationId: "metadata-fixture", planDigest: "a".repeat(64), auditFiles: [{ path: ".agentwheel/ownership-releases/metadata-fixture.json", content,
        sha256: createHash("sha256").update(content).digest("hex") }] } } : { metadataGuards: guards }),
  };
}

describe.skipIf(process.getuid?.() === 0)("confined run-as ownership metadata", () => {
  it("observes kinds, modes and ignored runtime bytes using the service helper", async () => {
    const f = await fixture();
    const directory = join(f.target, "tree"); await mkdir(join(directory, "__pycache__"), { recursive: true });
    const cache = join(directory, "__pycache__", "cache.pyc"); await writeFile(cache, "before");
    const first = await observeOwnershipRuntime(directory, f.transport);
    expect(first.kind).toBe("dir");
    await writeFile(cache, "after");
    expect((await observeOwnershipRuntime(directory, f.transport)).snapshotDigest).not.toBe(first.snapshotDigest);
    await chmod(f.runtimePath, 0o640);
    const beforeMode = await observeOwnershipRuntime(f.runtimePath, f.transport);
    await chmod(f.runtimePath, 0o600);
    expect((await observeOwnershipRuntime(f.runtimePath, f.transport)).snapshotDigest).not.toBe(beforeMode.snapshotDigest);
    expect((await observeOwnershipRuntime(f.runtimePath, localTransport)).kind).toBe("file");
  });

  it("fails before target writes when observation API or caller receipt is absent", async () => {
    const f = await fixture(); const count = f.requests.length;
    expect(() => assertOwnershipMetadataTransportSupported({ ...f.transport, ownershipObservation: undefined })).toThrow(/observations/);
    expect(() => assertOwnershipMetadataTransportSupported(f.transport)).toThrow(/durable mutation receipt/);
    expect(f.requests).toHaveLength(count);
    await expect(observeOwnershipRuntime("/outside", { ...f.transport, kind: "ssh" })).rejects.toThrow(/SSH/);
  });

  it("refuses an unreserved metadata payload even inside an active caller mutation", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    const count = f.requests.length;
    await expect(commitManifestMetadataJournal(value, f.transport)).rejects.toThrow(/durable receipt link/);
    expect(f.requests).toHaveLength(count);
  });

  it("rejects service-writable audit ancestors despite a protected caller receipt", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    const auditDirectory = join(f.workspace, ".agentwheel/ownership-releases");
    await mkdir(auditDirectory, { recursive: true });
    await chmod(f.root, 0o755); await chmod(f.workspace, 0o755);
    await chmod(join(f.workspace, ".agentwheel"), 0o755); await chmod(auditDirectory, 0o777);
    const receiptPath = join(process.env.AGENTWHEEL_MUTATION_STATE_ROOT!, "receipts/metadata-fixture.json");
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    const requestsBefore = f.requests.length;
    await expect(writeApplyJournal(value, f.transport)).rejects.toThrow(/caller|service|writ/i);
    expect(f.requests).toHaveLength(requestsBefore);
    await expect(readFile(metadataAuditPath(value.metadataAudit!, value.metadataAudit!.auditFiles[0]!.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks caller audit ancestors before recovery acquires a target lock", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    await writeApplyJournal(value, f.transport);
    const receipt = await readMutationReceipt("metadata-fixture"); const pinned = receipt.runtimeJournals[0]!;
    const expected = { ...pinned, operationId: receipt.operationId, reason: receipt.reason, noCommit: receipt.noCommit };
    const auditDirectory = join(f.workspace, ".agentwheel/ownership-releases");
    await mkdir(auditDirectory, { recursive: true });
    await chmod(f.root, 0o755); await chmod(f.workspace, 0o755);
    await chmod(join(f.workspace, ".agentwheel"), 0o755); await chmod(auditDirectory, 0o777);
    const targetWritesBefore = f.requests.filter((request) => request.operation === "mkdirExclusive" || request.operation === "writeFileAtomic").length;
    await expect(recoverPendingApply(f.target, "openclaw", f.transport, scope, expected)).rejects.toThrow(/caller|service|writ/i);
    expect(f.requests.filter((request) => request.operation === "mkdirExclusive" || request.operation === "writeFileAtomic")).toHaveLength(targetWritesBefore);
  });

  it("rejects symlinked caller audit descendants before creating a target journal", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    await mkdir(join(f.workspace, ".agentwheel"));
    const alternate = join(f.root, "alternate"); await mkdir(alternate);
    await symlink(alternate, join(f.workspace, ".agentwheel/ownership-releases"));
    const requestsBefore = f.requests.length;
    await expect(writeApplyJournal(value, f.transport)).rejects.toThrow(/caller|service|symlink|writ/i);
    expect(f.requests).toHaveLength(requestsBefore);
  });

  it.each(["002", "777"])("creates private audit ancestors under inherited SGID with umask %s", async (mask) => {
    if (process.env.AGENTWHEEL_AUDIT_UMASK_CHILD !== mask) {
      // A separate forked Vitest process changes umask without mutating a worker thread's process state.
      const run = promisify(execFile);
      await run(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "test/run-as-metadata.test.ts",
        "--pool=forks", "--maxWorkers=1", "-t", `creates private audit ancestors under inherited SGID with umask ${mask}`], {
        cwd: process.cwd(), env: { ...process.env, AGENTWHEEL_AUDIT_UMASK_CHILD: mask }, timeout: 100_000, maxBuffer: 1024 * 1024,
      });
      return;
    }
    const f = await fixture(); await governed(f); const value = await journal(f);
    await chmod(f.workspace, 0o2755);
    const previous = process.umask(Number.parseInt(mask, 8));
    try {
      await writeApplyJournal(value, f.transport);
      await commitManifestMetadataJournal(value, f.transport);
    } finally { process.umask(previous); }
    const auditPath = metadataAuditPath(value.metadataAudit!, value.metadataAudit!.auditFiles[0]!.path);
    expect((await stat(f.workspace)).mode & 0o7777).toBe(0o2755);
    expect((await stat(join(f.workspace, ".agentwheel"))).mode & 0o7777).toBe(0o700);
    expect((await stat(join(f.workspace, ".agentwheel/ownership-releases"))).mode & 0o7777).toBe(0o700);
    expect((await stat(auditPath)).mode & 0o7777).toBe(0o600);
    await assertOwnershipMetadataAuditPaths(value, f.transport);
    expect(await readFile(auditPath, "utf8")).toBe(value.metadataAudit!.auditFiles[0]!.content);
  });

  it("writes audit intent only in the caller workspace and preserves every runtime byte", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    const original = await readFile(f.runtimePath);
    const pathExists = f.transport.pathExists;
    f.transport.pathExists = async (path) => {
      if (path.startsWith(f.workspace)) throw new Error("Caller audit path leaked into target transport");
      return pathExists(path);
    };
    assertOwnershipMetadataTransportSupported(f.transport);
    const lock = await acquireApplyLock(f.target, "openclaw", f.transport, {}, scope);
    try { await writeApplyJournal(value, f.transport); await commitManifestMetadataJournal(value, f.transport); }
    finally { await lock.release(); }
    expect(await readFile(metadataAuditPath(value.metadataAudit!, value.metadataAudit!.auditFiles[0]!.path), "utf8")).toBe(value.metadataAudit!.auditFiles[0]!.content);
    expect(await readFile(f.runtimePath)).toEqual(original);
    expect(await f.transport.pathExists(applyJournalPath(f.target, "openclaw", scope))).toBe(false);
  });

  it.each(["runtime", "inventory"])("refuses stale %s guards before audit or manifest writes", async (change) => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    if (change === "runtime") await writeFile(f.runtimePath, "concurrent bytes");
    else await writeInstallManifest({ ...f.before, adapter: "other", stateKey: "other.user" }, f.transport);
    const before = await readFile(installManifestPath(f.target, "openclaw", scope));
    await writeApplyJournal(value, f.transport);
    await expect(commitManifestMetadataJournal(value, f.transport)).rejects.toThrow(/CAS/);
    expect(await readFile(installManifestPath(f.target, "openclaw", scope))).toEqual(before);
    await expect(readFile(metadataAuditPath(value.metadataAudit!, value.metadataAudit!.auditFiles[0]!.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("checks exact managed-block snapshots through confined target reads (valid=%s)", async (valid) => {
    const f = await fixture(); await governed(f);
    const body = "owned instructions\n";
    const hash = createHash("sha256").update(body).digest("hex");
    const content = `prefix\n<!-- BEGIN openpack:include fixture sha256:${hash} -->\n${body}<!-- END openpack:include fixture -->\nsuffix\n`;
    await writeFile(f.runtimePath, content);
    const value = await journal(f);
    const exact = exactManagedInstructionBlockSnapshot(content, "fixture");
    value.metadataAudit!.runtime[0]!.managedBlock = valid ? exact : { ...exact, prefixHash: "b".repeat(64) };
    await writeApplyJournal(value, f.transport);
    if (valid) await expect(commitManifestMetadataJournal(value, f.transport)).resolves.toMatchObject({ adapter: "openclaw" });
    else await expect(commitManifestMetadataJournal(value, f.transport)).rejects.toThrow(/Managed instruction snapshot CAS/);
    expect(await readFile(f.runtimePath, "utf8")).toBe(content);
  });

  it("recovers after a durable manifest write and rejects stale runtime during recovery", async () => {
    const f = await fixture(); await governed(f); const value = await journal(f);
    const originalWrite = f.transport.writeJsonAtomic;
    let injected = false;
    f.transport.writeJsonAtomic = async (path, data) => {
      await originalWrite(path, data);
      if (!injected && path === installManifestPath(f.target, "openclaw", scope)) { injected = true; throw new Error("Injected after manifest publication"); }
    };
    await writeApplyJournal(value, f.transport);
    await expect(commitManifestMetadataJournal(value, f.transport)).rejects.toThrow(/Injected/);
    const receipt = await readMutationReceipt("metadata-fixture"); const pinned = receipt.runtimeJournals[0]!;
    const expected = { ...pinned, operationId: receipt.operationId, reason: receipt.reason, noCommit: receipt.noCommit };
    await writeFile(f.runtimePath, "stale runtime");
    await expect(recoverPendingApply(f.target, "openclaw", f.transport, scope, expected)).rejects.toThrow(/runtime CAS/);
    await writeFile(f.runtimePath, "preserve runtime\n");
    await expect(recoverPendingApply(f.target, "openclaw", f.transport, scope, expected)).resolves.toMatchObject({ adapter: "openclaw" });
    expect(await f.transport.pathExists(pinned.path)).toBe(false);
  });
});
