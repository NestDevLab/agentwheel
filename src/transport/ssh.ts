import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { dirname as posixDirname } from "node:path/posix";
import { promisify } from "node:util";
import type { SshTransportConfig, TargetTransport } from "./types.js";

const execFileAsync = promisify(execFile);

export function createSshTransport(config: SshTransportConfig): TargetTransport {
  const endpoint = config.user ? `${config.user}@${config.host}` : config.host;
  const args = baseSshArgs(config, endpoint);

  async function run(command: string): Promise<string> {
    const { stdout } = await execFileAsync("ssh", [...args, command], { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  }

  async function runWithInput(command: string, input: string | Buffer): Promise<void> {
    await spawnWithInput("ssh", [...args, command], input);
  }

  return {
    kind: "ssh",
    description: `ssh://${endpoint}`,
    async pathExists(path) {
      try {
        await run(`test -e ${quoteSh(path)}`);
        return true;
      } catch {
        return false;
      }
    },
    async mkdirExclusive(path) {
      const dir = posixDirname(path);
      try {
        await run(`mkdir -p ${quoteSh(dir)} && mkdir ${quoteSh(path)}`);
      } catch (error) {
        if (isFileExistsError(error)) throw asAlreadyExists(error);
        throw error;
      }
    },
    async hashPath(path) {
      return (await run(`node -e ${quoteSh(remoteHashScript)} -- ${quoteSh(path)}`)).trim();
    },
    readFile(path) {
      return run(`cat -- ${quoteSh(path)}`);
    },
    writeFileAtomic(path, content) {
      const dir = posixDirname(path);
      const temp = `${path}.tmp-agentwheel-${process.pid}-${Date.now()}`;
      return runWithInput(`mkdir -p ${quoteSh(dir)} && cat > ${quoteSh(temp)} && mv ${quoteSh(temp)} ${quoteSh(path)}`, content);
    },
    writeJsonAtomic(path, data) {
      return this.writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
    },
    atomicCopy(source, dest) {
      return copyViaTar(source, dest, args);
    },
    rm(path) {
      return run(`rm -rf -- ${quoteSh(path)}`).then(() => undefined);
    },
    execFile(command, commandArgs, options = {}) {
      const quoted = [command, ...commandArgs].map(quoteSh).join(" ");
      const remoteCommand = options.cwd
        ? `cd ${quoteSh(options.cwd)} && ${quoted}`
        : quoted;
      return run(remoteCommand).then(() => undefined);
    },
  };
}

function baseSshArgs(config: SshTransportConfig, endpoint: string): string[] {
  const args = ["-o", "BatchMode=yes"];
  if (config.port) args.push("-p", String(config.port));
  if (config.identityFile) args.push("-i", config.identityFile);
  args.push(endpoint);
  return args;
}

async function copyViaTar(source: string, dest: string, sshArgs: string[]): Promise<void> {
  const sourceParent = dirname(source);
  const sourceBase = basename(source);
  const destParent = posixDirname(dest);
  const temp = `${dest}.tmp-agentwheel-${process.pid}-${Date.now()}`;
  const remoteCommand = [
    `rm -rf -- ${quoteSh(temp)}`,
    `mkdir -p ${quoteSh(temp)} ${quoteSh(destParent)}`,
    `tar -xf - -C ${quoteSh(temp)}`,
    `rm -rf -- ${quoteSh(dest)}`,
    `mv ${quoteSh(`${temp}/${sourceBase}`)} ${quoteSh(dest)}`,
    `rmdir ${quoteSh(temp)}`,
  ].join(" && ");

  const tar = spawn("tar", ["-cf", "-", "-C", sourceParent, sourceBase], { stdio: ["ignore", "pipe", "pipe"] });
  const ssh = spawn("ssh", [...sshArgs, remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
  tar.stdout.pipe(ssh.stdin);

  const [tarResult, sshResult] = await Promise.all([waitForProcess(tar, "tar"), waitForProcess(ssh, "ssh")]);
  if (tarResult.stderr) throw new Error(tarResult.stderr);
  if (sshResult.stderr) throw new Error(sshResult.stderr);
}

async function spawnWithInput(command: string, args: string[], input: string | Buffer): Promise<void> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(input);
  const result = await waitForProcess(child, command);
  if (result.stderr) throw new Error(result.stderr);
}

function waitForProcess(child: ReturnType<typeof spawn>, label: string): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const message = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stderr: "" });
      else reject(new Error(`${label} exited ${code}${message ? `: ${message}` : ""}`));
    });
  });
}

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isFileExistsError(error: unknown): boolean {
  const text = typeof error === "object" && error !== null
    ? `${"message" in error ? String((error as { message?: unknown }).message) : ""}\n${"stderr" in error ? String((error as { stderr?: unknown }).stderr) : ""}`
    : String(error);
  return text.includes("File exists");
}

function asAlreadyExists(error: unknown): Error & { code: "EEXIST" } {
  const out = error instanceof Error ? error : new Error(String(error));
  (out as Error & { code: "EEXIST" }).code = "EEXIST";
  return out as Error & { code: "EEXIST" };
}

const remoteHashScript = String.raw`
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");
const target = process.argv[1];
const ignoredNames = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);
const ignoredSuffixes = [".pyc", ".pyo"];
function isIgnoredGeneratedEntry(name) {
  return ignoredNames.has(name) || ignoredSuffixes.some((suffix) => name.endsWith(suffix));
}
function hashPath(path) {
  const stats = statSync(path);
  if (stats.isFile()) {
    return createHash("sha256").update("file\0").update(readFileSync(path)).digest("hex");
  }
  if (!stats.isDirectory()) throw new Error("Unsupported path kind: " + path);
  const hash = createHash("sha256").update("dir\0");
  for (const file of listFiles(path)) {
    hash.update(relative(path, file).replaceAll("\\", "/")).update("\0");
    hash.update(hashPath(file)).update("\0");
  }
  return hash.digest("hex");
}
function listFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredGeneratedEntry(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(root);
  return out;
}
process.stdout.write(hashPath(target));
`;
