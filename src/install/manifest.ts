import { resolve } from "node:path";
import { installManifestSchema, type InstallManifest, type SourceLock } from "../model/manifest.js";
import { sourceLockSchema } from "../model/manifest.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { installManifestPath, sourceLockPath } from "./paths.js";

export async function readInstallManifest(targetRoot: string, adapter: string, transport: TargetTransport = localTransport): Promise<InstallManifest | undefined> {
  const path = installManifestPath(targetRoot, adapter);
  if (!(await transport.pathExists(path))) return undefined;
  return installManifestSchema.parse(JSON.parse(await transport.readFile(path)));
}

export async function writeInstallManifest(manifest: InstallManifest, transport: TargetTransport = localTransport): Promise<void> {
  await transport.writeJsonAtomic(installManifestPath(manifest.targetRoot, manifest.adapter), manifest);
}

export async function writeSourceLock(targetRoot: string, adapter: string, lock: SourceLock, transport: TargetTransport = localTransport): Promise<void> {
  await transport.writeJsonAtomic(sourceLockPath(targetRoot, adapter), lock);
}

export async function readSourceLock(targetRoot: string, adapter: string, transport: TargetTransport = localTransport): Promise<SourceLock | undefined> {
  const path = sourceLockPath(targetRoot, adapter);
  if (!(await transport.pathExists(path))) return undefined;
  return sourceLockSchema.parse(JSON.parse(await transport.readFile(path)));
}

export async function removeStateFiles(targetRoot: string, adapter: string, transport: TargetTransport = localTransport): Promise<void> {
  await transport.rm(installManifestPath(targetRoot, adapter));
  await transport.rm(sourceLockPath(targetRoot, adapter));
}

export function normalizeTargetRoot(path: string): string {
  return resolve(path);
}
