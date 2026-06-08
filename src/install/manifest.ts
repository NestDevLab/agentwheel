import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { installManifestSchema, type InstallManifest, type SourceLock } from "../model/manifest.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";
import { installManifestPath, sourceLockPath } from "./paths.js";

export async function readInstallManifest(targetRoot: string, adapter: string): Promise<InstallManifest | undefined> {
  const path = installManifestPath(targetRoot, adapter);
  if (!(await pathExists(path))) return undefined;
  return installManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeInstallManifest(manifest: InstallManifest): Promise<void> {
  await writeJsonAtomic(installManifestPath(manifest.targetRoot, manifest.adapter), manifest);
}

export async function writeSourceLock(targetRoot: string, adapter: string, lock: SourceLock): Promise<void> {
  await writeJsonAtomic(sourceLockPath(targetRoot, adapter), lock);
}

export async function removeStateFiles(targetRoot: string, adapter: string): Promise<void> {
  await rm(installManifestPath(targetRoot, adapter), { force: true });
  await rm(sourceLockPath(targetRoot, adapter), { force: true });
}

export function normalizeTargetRoot(path: string): string {
  return resolve(path);
}

