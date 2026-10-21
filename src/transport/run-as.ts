import { execFile, execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { promisify } from "node:util";
import type { RunAsIdentity } from "./run-as-identity.js";
import type { RunAsRequest } from "./run-as-worker.js";
import { trustedRunAsCode } from "./run-as-trust.js";
import { resolveRunAsIdentity } from "./run-as-identity.js";
import { stageRunAsCopy } from "./run-as-staging.js";
import { hashPath } from "../utils/fs.js";
import type { TargetTransport } from "./types.js";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL("./run-as-worker.js", import.meta.url));
const nodePath = process.env.AGENTWHEEL_RUN_AS_NODE ?? "/usr/bin/node";
const runAsTimeoutMs = 120_000;
const commandError = "local-run-as permits only the dedicated OpenClaw config validation operation; arbitrary commands are forbidden.";
const stagedWorkers = new Map<string, { directory: string; worker: string }>();
let cleanupInstalled = false;

function cleanupStagedWorkers(): void {
  for (const { directory } of stagedWorkers.values()) rmSync(directory, { recursive: true, force: true });
  stagedWorkers.clear();
}

function stageWorkerOnce(worker: string): string {
  const existing = stagedWorkers.get(worker);
  if (existing) return existing.worker;
  const directory = mkdtempSync(join("/tmp", "agentwheel-run-as-"));
  try {
    const staged = join(directory, "run-as-worker.mjs");
    copyFileSync(worker, staged);
    const helper = join(directory, "run-as-fs.py");
    const helperSource = fileURLToPath(new URL("./run-as-fs.py", import.meta.url));
    copyFileSync(helperSource, helper);
    chmodSync(helper, 0o444);
    chmodSync(staged, 0o444);
    chmodSync(directory, 0o711);
    stagedWorkers.set(worker, { directory, worker: staged });
    if (!cleanupInstalled) {
      process.once("exit", cleanupStagedWorkers);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          cleanupStagedWorkers();
          process.kill(process.pid, signal);
        });
      }
      cleanupInstalled = true;
    }
    return staged;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type RunAsRunner = (command: string, args: string[], input?: string) => Promise<{ stdout: string }>;

export async function defaultRunAsRunner(command: string, args: string[], input?: string, timeoutMs = runAsTimeoutMs): Promise<{ stdout: string }> {
  if (input === undefined) return execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs });
  return new Promise((resolveResult, reject) => {
    const child = execFile(command, args, { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolveResult({ stdout: String(stdout) });
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}

export function createRunAsTransport(identity: RunAsIdentity, runner: RunAsRunner = defaultRunAsRunner, worker = workerPath, nodeExecutable = nodePath): TargetTransport {
  identity = Object.freeze({ ...identity });
  if (!isAbsolute(identity.root) || resolve(identity.root) !== identity.root || identity.uid <= 0) throw new Error("Invalid run-as target identity.");
  const groups = runner === defaultRunAsRunner
    ? execFileSync("/usr/bin/id", ["-G", identity.user], { encoding: "utf8", timeout: 10_000 }).trim().split(/\s+/).map(Number)
    : [identity.gid];
  if (!groups.length || groups.some((group) => !Number.isSafeInteger(group) || group < 0) || !groups.includes(identity.gid)) throw new Error("Invalid run-as supplementary groups.");
  const trust = (path: string, label: string) => trustedRunAsCode(path, identity.uid, groups, label);
  const executable = trust(nodeExecutable, "Node executable");
  let stagedWorker = worker;
  if (runner === defaultRunAsRunner) {
    accessSync(worker, constants.R_OK);
    const trustedWorker = trust(worker, "worker");
    trust(fileURLToPath(new URL("./run-as-fs.py", import.meta.url)), "filesystem helper");
    // Recovery planning may set TMPDIR to a private 0700 directory. The worker
    // needs a caller-owned staging directory traversable by the service user.
    stagedWorker = stageWorkerOnce(trustedWorker);
  }
  const prefix = ["-n", "-u", identity.user, "-H", "--"];
  let preflight: Promise<void> | undefined;
  function verifyUid(): Promise<void> {
    preflight ??= (async () => {
      let actualUid: string;
      try { actualUid = (await runner("/usr/bin/sudo", [...prefix, "/usr/bin/id", "-u"])).stdout.trim(); }
      catch (error) { throw new Error(`Run-as sudo preflight failed for ${identity.user}: ${error instanceof Error ? error.message : String(error)}`); }
      if (actualUid !== String(identity.uid)) throw new Error(`Run-as sudo returned UID ${actualUid}; expected ${identity.uid}.`);
    })();
    return preflight;
  }
  async function run(operation: RunAsRequest["operation"], path: string, fields: Partial<RunAsRequest> = {}): Promise<unknown> {
    const rel = relative(identity.root, path) || ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Run-as read path escapes ${identity.root}: ${path}`);
    await verifyUid();
    const request: RunAsRequest = { ...fields, version: 1, operation, path: rel };
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 20 * 1024 * 1024) throw new Error("Run-as request exceeds 20 MiB.");
    const args = [...prefix, "/usr/bin/env", "-i", `HOME=${identity.home}`, "PATH=/usr/local/bin:/usr/bin:/bin",
      executable, stagedWorker, "--root", identity.root, "--uid", String(identity.uid), "--gid", String(identity.gid)];
    const { stdout } = await runner("/usr/bin/sudo", args, input);
    if (stdout.length > 20 * 1024 * 1024) throw new Error("Run-as worker result exceeds 20 MiB.");
    const response = JSON.parse(stdout) as { version?: number; result?: unknown; error?: { message: string; code?: string } };
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    if (response.version !== 1 || !("result" in response)) throw new Error("Invalid run-as worker response.");
    const schema = operation === "pathExists" || operation === "probe" ? z.boolean()
      : operation === "hashPath" || operation === "ownershipSnapshot" ? z.string().regex(/^[a-f0-9]{64}$/)
      : operation === "readFile" ? z.string()
      : operation === "listDir" ? z.array(z.string().min(1).refine((name) => !/[\\/\0]/.test(name) && name !== "." && name !== ".."))
      : z.null();
    return schema.parse(response.result);
  }
  let ready: Promise<void> | undefined;
  async function prepareApply(): Promise<void> {
    ready ??= (async () => {
      if (runner === defaultRunAsRunner) {
        const current = resolveRunAsIdentity(identity.user, identity.root);
        if (["user", "uid", "gid", "home", "root"].some((key) => current[key as keyof RunAsIdentity] !== identity[key as keyof RunAsIdentity])) {
          throw new Error("Run-as account identity changed before apply.");
        }
      }
      await run("probe", identity.root);
    })();
    return ready;
  }
  return {
    kind: "local-run-as",
    description: `local-run-as://${identity.user}:${identity.uid}@${identity.root}`,
    homeRoot: identity.home,
    runAsIdentity: Object.freeze({ ...identity }),
    prepareApply,
    pathExists: async (path) => Boolean(await run("pathExists", path)),
    hashPath: async (path) => String(await run("hashPath", path)),
    readFile: async (path) => String(await run("readFile", path)),
    ownershipSnapshot: async (path) => String(await run("ownershipSnapshot", path)),
    listDir: async (path) => (await run("listDir", path)) as string[],
    mkdirExclusive: async (path) => { await prepareApply(); await run("mkdirExclusive", path); },
    writeFileAtomic: async (path, content) => { await prepareApply(); await run("writeFileAtomic", path, { content }); },
    writeJsonAtomic: async (path, data) => { await prepareApply(); await run("writeFileAtomic", path, { content: `${JSON.stringify(data, null, 2)}\n` }); },
    atomicCopy: async (source, dest, kind, expectedHash) => {
      await prepareApply();
      const payload = await stageRunAsCopy(source, kind, expectedHash ?? await hashPath(source));
      await run("copy", dest, { payload });
    },
    copyWithin: async (source, dest) => {
      await prepareApply();
      const rel = relative(identity.root, source);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Run-as backup source escapes target root.");
      await run("copyWithin", dest, { source: rel || "." });
    },
    rm: async (path) => { await prepareApply(); await run("rm", path); },
    validateOpenClawConfig: async (path) => {
      await prepareApply();
      const content = String(await run("readFile", path));
      const directory = mkdtempSync(join("/tmp", "agentwheel-validate-"));
      try {
        const snapshot = join(directory, "openclaw.json");
        writeFileSync(snapshot, content, { mode: 0o444, flag: "wx" });
        chmodSync(snapshot, 0o444);
        chmodSync(directory, 0o711);
        await run("validateOpenClawConfig", path, {
          validatorRoot: process.env.AGENTWHEEL_RUN_AS_OPENCLAW_ROOT ?? "/usr/local/lib/node_modules/openclaw",
          validationSnapshot: snapshot,
        });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
    execFile: async () => { throw new Error(commandError); },
  };
}
