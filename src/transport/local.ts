import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { atomicCopy, hashPath, pathExists, writeJsonAtomic } from "../utils/fs.js";
import type { TargetTransport } from "./types.js";

const execFileAsync = promisify(execFile);

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
  atomicCopy,
  rm: (path) => rm(path, { recursive: true, force: true }),
  async execFile(command, args, options = {}) {
    await execFileAsync(command, args, { cwd: options.cwd });
  },
};
