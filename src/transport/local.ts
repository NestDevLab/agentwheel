import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicCopy, hashPath, pathExists, writeJsonAtomic } from "../utils/fs.js";
import type { TargetTransport } from "./types.js";

export const localTransport: TargetTransport = {
  kind: "local",
  description: "local filesystem",
  pathExists,
  hashPath,
  readFile: (path) => readFile(path, "utf8"),
  async writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, content, "utf8");
    await rename(temp, path);
  },
  writeJsonAtomic,
  atomicCopy,
  rm: (path) => rm(path, { recursive: true, force: true }),
};
