import { join } from "node:path";

export function metadataDir(targetRoot: string): string {
  return join(targetRoot, ".agentweave");
}

export function installManifestPath(targetRoot: string, adapter: string): string {
  return join(metadataDir(targetRoot), `${adapter}.install-manifest.json`);
}

export function sourceLockPath(targetRoot: string, adapter: string): string {
  return join(metadataDir(targetRoot), `${adapter}.source-lock.json`);
}

