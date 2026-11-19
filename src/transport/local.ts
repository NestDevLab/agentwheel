import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicCopy, hashPath, pathExists, writeJsonAtomic } from "../utils/fs.js";
import type { TargetTransport } from "./types.js";

const execFileAsync = promisify(execFile);

async function assertPrivateMetadataDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const uid = process.geteuid?.();
  if (uid === undefined || basename(absolute) !== ".agentwheel" || await realpath(absolute) !== absolute) {
    throw new Error("Private metadata requires the real .agentwheel directory.");
  }
  const target = dirname(absolute);
  const parents = [];
  for (let directory = dirname(target); ; directory = dirname(directory)) {
    parents.unshift(directory);
    if (directory === dirname(directory)) break;
  }
  for (const directory of parents) {
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid)
      || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      throw new Error("Private metadata requires trusted ancestors of the runtime directory.");
    }
  }
  for (const directory of [target, absolute]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
      throw new Error("Private metadata requires a target and .agentwheel directory writable only by their owner.");
    }
  }
}

async function writePrivateJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(resolve(path));
  if (!/^[a-z0-9._-]+[.](?:install-manifest|apply-journal)[.]json$/iu.test(basename(path))) {
    throw new Error("Unsupported private metadata path.");
  }
  await assertPrivateMetadataDirectory(dir);
  const temp = join(dir, `.agentwheel-private-${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await assertPrivateMetadataDirectory(dir);
    await rename(temp, path);
    const parent = await open(dir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await rm(temp, { force: true });
  }
}

export const localTransport: TargetTransport = {
  kind: "local",
  description: "local filesystem",
  pathExists,
  async mkdirExclusive(path) {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
  },
  hashPath,
  readFile: (path) => readFile(path, "utf8"),
  async listDir(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  async writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  },
  writeJsonAtomic,
  assertPrivateMetadataDirectory,
  writePrivateJsonAtomic,
  atomicCopy,
  rm: (path) => rm(path, { recursive: true, force: true }),
  async execFile(command, args, options = {}) {
    const { stdout } = await execFileAsync(command, args, { cwd: options.cwd });
    return stdout;
  },
};
