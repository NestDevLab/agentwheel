import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RunAsIdentity } from "./run-as-identity.js";
import type { ReadOperation, ReadRequest } from "./run-as-worker.js";
import type { TargetTransport } from "./types.js";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL("./run-as-worker.js", import.meta.url));
const nodePath = process.env.AGENTWHEEL_RUN_AS_NODE ?? "/usr/bin/node";
const runAsTimeoutMs = 120_000;
const readonlyError = "local-run-as is read-only in PR1; apply and runtime mutations are not supported.";
const stagedWorkers = new Map<string, { directory: string; worker: string }>();
let cleanupInstalled = false;

function assertTrustedFile(path: string, uid: number, label: string): string {
  if (!isAbsolute(path)) throw new Error(`Run-as ${label} path must be absolute: ${path}`);
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.uid === uid || (stat.mode & 0o022) !== 0) {
    throw new Error(`Run-as ${label} is writable by the service user or is not a regular file: ${path}`);
  }
  return canonical;
}

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
  if (!isAbsolute(identity.root) || resolve(identity.root) !== identity.root || identity.uid <= 0) throw new Error("Invalid run-as target identity.");
  const executable = assertTrustedFile(nodeExecutable, identity.uid, "Node executable");
  let stagedWorker = worker;
  if (runner === defaultRunAsRunner) {
    accessSync(worker, constants.R_OK);
    const trustedWorker = assertTrustedFile(worker, identity.uid, "worker");
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
  async function run(operation: ReadOperation, path: string): Promise<unknown> {
    const rel = relative(identity.root, path) || ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Run-as read path escapes ${identity.root}: ${path}`);
    await verifyUid();
    const request: ReadRequest = { version: 1, operation, path: rel };
    const args = [...prefix, "/usr/bin/env", "-i", `HOME=${identity.home}`, "PATH=/usr/local/bin:/usr/bin:/bin",
      executable, stagedWorker, "--root", identity.root, "--uid", String(identity.uid), "--gid", String(identity.gid)];
    const { stdout } = await runner("/usr/bin/sudo", args, JSON.stringify(request));
    if (stdout.length > 20 * 1024 * 1024) throw new Error("Run-as worker result exceeds 20 MiB.");
    const response = JSON.parse(stdout) as { version?: number; result?: unknown };
    if (response.version !== 1 || !("result" in response)) throw new Error("Invalid run-as worker response.");
    return response.result;
  }
  return {
    kind: "local-run-as",
    description: `local-run-as://${identity.user}:${identity.uid}@${identity.root}`,
    homeRoot: identity.home,
    pathExists: async (path) => Boolean(await run("pathExists", path)),
    hashPath: async (path) => String(await run("hashPath", path)),
    readFile: async (path) => String(await run("readFile", path)),
    listDir: async (path) => (await run("listDir", path)) as string[],
    mkdirExclusive: async () => { throw new Error(readonlyError); },
    writeFileAtomic: async () => { throw new Error(readonlyError); },
    writeJsonAtomic: async () => { throw new Error(readonlyError); },
    atomicCopy: async () => { throw new Error(readonlyError); },
    rm: async () => { throw new Error(readonlyError); },
    execFile: async () => { throw new Error(readonlyError); },
  };
}

export function assertRunAsReadOnly(transport: Pick<TargetTransport, "kind">): void {
  if (transport.kind === "local-run-as") throw new Error(readonlyError);
}
