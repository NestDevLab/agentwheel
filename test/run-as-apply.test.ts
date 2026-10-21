import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernedMutation } from "../src/mutation/coordinator.js";
import { createMutationReceipt, readMutationReceipt } from "../src/mutation/receipts.js";
import { applyCombinedInstallPlan, recoverPendingApply } from "../src/install/apply.js";
import { readInstallManifest } from "../src/install/manifest.js";
import { applyJournalPath } from "../src/install/transaction.js";
import type { InstallOperation, InstallPlan } from "../src/install/plan.js";
import { createRunAsTransport, type RunAsRunner } from "../src/transport/run-as.js";
import { assertSelfContainedOpenClawConfig, executeRequest, type RunAsRequest } from "../src/transport/run-as-worker.js";
import { hashPath } from "../src/utils/fs.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-run-as-apply-")); roots.push(root);
  const target = join(root, "target"), source = join(root, "private-source");
  await mkdir(target, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  const requests: RunAsRequest[] = [];
  let failPath: string | undefined;
  const runner: RunAsRunner = async (_command, _args, input) => {
    if (!input) return { stdout: `${process.getuid!()}\n` };
    const request = JSON.parse(input) as RunAsRequest; requests.push(request);
    try {
      if (request.operation === "copy" && request.path === failPath) throw new Error("Injected pre-copy failure");
      return { stdout: JSON.stringify({ version: 1, result: await executeRequest(target, process.getuid!(), process.getgid!(), request) }) };
    } catch (error) { return { stdout: JSON.stringify({ version: 1, error: { message: String(error), code: (error as NodeJS.ErrnoException).code } }) }; }
  };
  const transport = createRunAsTransport({ user: "fixture", uid: process.getuid!(), gid: process.getgid!(), home: target, root: target }, runner);
  return { target, source, transport, requests, fail: (path: string) => { failPath = path; } };
}
const stateKey = `openclaw.user.${"a".repeat(64)}`;
const scope = { installationType: "user", stateKey };
async function operation(source: string, target: string, name: string, action: "create" | "update" = "create"): Promise<InstallOperation> {
  return { action, artifactType: "skills", artifactName: name, kind: "file", sourcePath: source,
    destPath: join(target, ".openclaw", name), relativeDestPath: `.openclaw/${name}`,
    desiredHash: await hashPath(source), reason: "fixture", channel: "managed", owners: ["fixture"], workspaceOwner: "workspace-root:/fixture" };
}
function plan(targetRoot: string, operations: InstallOperation[], baseRevision: string | null = null): InstallPlan {
  return { adapter: "openclaw", targetRoot, ...scope, baseRevision, operations, hasBlockingChanges: false };
}

describe.skipIf(process.getuid?.() === 0)("confined run-as transactional apply", () => {
  it("installs staged bytes with private modes and commits a service-side manifest", async () => {
    const f = await fixture(); const source = join(f.source, "skill"); await writeFile(source, "private source bytes");
    const op = await operation(source, f.target, "skill");
    const manifest = await applyCombinedInstallPlan(plan(f.target, [op]), { transport: f.transport });
    expect(await readFile(op.destPath, "utf8")).toBe("private source bytes");
    expect((await stat(op.destPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.target, ".openclaw"))).mode & 0o777).toBe(0o700);
    expect((await readInstallManifest(f.target, "openclaw", f.transport, scope))?.revision).toBe(manifest.revision);
    const copy = f.requests.find((request) => request.operation === "copy")!;
    expect(JSON.stringify(copy)).not.toContain(f.source);
    expect(copy).toMatchObject({ path: ".openclaw/skill", payload: { hash: op.desiredHash } });
    expect(f.requests.some((request) => request.operation === "writeFileAtomic" && request.path.startsWith(".agentwheel/"))).toBe(true);
    await expect(stat(applyJournalPath(f.target, "openclaw", scope))).rejects.toMatchObject({ code: "ENOENT" });
    const noop = { ...op, action: "skip" as const, currentHash: op.desiredHash, manifestHash: op.desiredHash };
    const before = f.requests.filter((request) => request.operation === "copy").length;
    await applyCombinedInstallPlan(plan(f.target, [noop], manifest.revision), { transport: f.transport });
    expect(f.requests.filter((request) => request.operation === "copy")).toHaveLength(before);
  }, 60_000);

  it("recovers a failed update through service-owned backups with exact prior modes", async () => {
    const f = await fixture(); const source = join(f.source, "first"); await writeFile(source, "old");
    const first = await operation(source, f.target, "first");
    const manifest = await applyCombinedInstallPlan(plan(f.target, [first]), { transport: f.transport });
    await chmod(first.destPath, 0o640);
    await writeFile(source, "new"); const update = await operation(source, f.target, "first", "update");
    const secondSource = join(f.source, "second"); await writeFile(secondSource, "second");
    const second = await operation(secondSource, f.target, "second"); f.fail(second.relativeDestPath);
    const previousStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(f.source, "mutation-state");
    const receipt = await createMutationReceipt({
      operationId: "backup-recovery", commandName: "agentwheel install", reason: "Recover service-owned backup",
      noCommit: false, workspaceRoot: f.source, repositoryRoot: null, expectedHead: null, expectedManifestDigest: null,
      revisionMode: "off", provider: null, preexistingPaths: [], paths: [], runtimeJournals: [], status: "prepared",
    });
    const mutation = GovernedMutation.activateExisting(receipt, undefined, { path: "test", release: async () => {} });
    try {
      await expect(applyCombinedInstallPlan(plan(f.target, [update, second], manifest.revision), { transport: f.transport })).rejects.toThrow(/Injected/);
    } finally {
      await mutation.fail(new Error("Injected update interruption"));
    }
    expect(await readFile(first.destPath, "utf8")).toBe("new");
    await rm(secondSource);
    const callerReceipt = await readMutationReceipt(receipt.operationId);
    const pinned = callerReceipt.runtimeJournals[0]!;
    try {
      expect(await recoverPendingApply(f.target, "openclaw", f.transport, scope, {
        ...pinned, operationId: callerReceipt.operationId, reason: callerReceipt.reason, noCommit: callerReceipt.noCommit,
      })).toBeUndefined();
    } finally {
      if (previousStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
      else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = previousStateRoot;
    }
    expect(await readFile(first.destPath, "utf8")).toBe("old");
    expect((await stat(first.destPath)).mode & 0o777).toBe(0o640);
    expect((await readInstallManifest(f.target, "openclaw", f.transport, scope))?.revision).toBe(manifest.revision);
    expect(f.requests.filter((request) => request.operation === "copyWithin").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("rejects nested OpenClaw includes before invoking native code", () => {
    for (const content of ['{"$include":"/etc/passwd"}', '{"nested":[{"$include":"relative.json"}]}', '{ // JSONC\n "$include": "outside.json", }']) {
      expect(() => assertSelfContainedOpenClawConfig(content)).toThrow(/does not support \$include/);
    }
    for (const content of ["{$include:'/tmp/external.json'}", "{'$include':'/tmp/external.json'}", '{"safe":true, $include:"/tmp/external.json"}']) {
      expect(() => assertSelfContainedOpenClawConfig(content)).toThrow(/valid JSON\/JSONC syntax/);
    }
    expect(() => assertSelfContainedOpenClawConfig('{ // literal reference\n "env": { "value": "${NAME}" }, }')).not.toThrow();
  });

  it("rejects service-owned validators and arbitrary validation commands", async () => {
    const f = await fixture();
    const packageRoot = join(f.target, "validator"); await mkdir(packageRoot);
    const binary = join(packageRoot, "openclaw.mjs");
    await writeFile(binary, 'throw new Error("must not execute")');
    const config = join(f.target, "config.json"); await writeFile(config, "{}");
    await expect(executeRequest(f.target, process.getuid!(), process.getgid!(), {
      version: 1, operation: "validateOpenClawConfig", path: "config.json", validatorRoot: packageRoot,
    })).rejects.toThrow(/immutable/);
    await expect(executeRequest(f.target, process.getuid!(), process.getgid!(), { version: 1, operation: "execFile", path: ".", command: binary })).rejects.toThrow();
  });

  it("isolates Python startup from service-owned user site packages", async () => {
    const f = await fixture();
    const { execFileSync } = await import("node:child_process");
    const version = execFileSync("/usr/bin/python3", ["-I", "-c", "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"], { encoding: "utf8" }).trim();
    const site = join(f.target, ".local", "lib", `python${version}`, "site-packages");
    await mkdir(site, { recursive: true }); const marker = join(f.target, "injected");
    await writeFile(join(site, "injection.pth"), `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("executed")\n`);
    expect(await executeRequest(f.target, process.getuid!(), process.getgid!(), { version: 1, operation: "probe", path: "." })).toBe(true);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages artifact sources even when they reside beneath the target root", async () => {
    const f = await fixture(); const source = join(f.target, "source"); await writeFile(source, "bytes", { mode: 0o644 });
    const dest = join(f.target, "dest");
    await expect(f.transport.atomicCopy(source, dest, "file", "0".repeat(64))).rejects.toThrow(/hash/);
    expect(f.requests.some((request) => request.operation === "copyWithin")).toBe(false);
    await f.transport.atomicCopy(source, dest, "file", await hashPath(source));
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect(f.requests.at(-1)?.operation).toBe("copy");
  });

  it("rejects executable plans and arbitrary commands before any target write", async () => {
    const f = await fixture(); const source = join(f.source, "skill"); await writeFile(source, "bytes");
    const op = await operation(source, f.target, "skill");
    for (const patch of [{ action: "plugin" }, { semanticCommand: ["sh", "-c", "false"] }, { programmaticOperation: {} }]) {
      await expect(applyCombinedInstallPlan(plan(f.target, [{ ...op, ...patch } as InstallOperation]), { transport: f.transport })).rejects.toThrow(/programmatic adapters and semantic/);
    }
    await expect(f.transport.execFile!("bash", ["-lc", "false"])).rejects.toThrow(/arbitrary commands/);
    expect(f.requests).toEqual([]); expect(await readdir(f.target)).toEqual([]);
  });
});
