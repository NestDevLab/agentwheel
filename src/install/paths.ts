import { join } from "node:path";
import { defaultInstallationType } from "../model/adapter.js";

export interface InstallStateScope {
  installationType?: string;
  stateKey?: string;
  targetFingerprint?: string;
}

export function metadataDir(targetRoot: string): string {
  return join(targetRoot, ".agentwheel");
}

export function stateKeyFor(adapter: string, scope: InstallStateScope = {}): string {
  if (scope.stateKey) return sanitizeStateKey(scope.stateKey);
  const installationType = scope.installationType ?? defaultInstallationType;
  const fingerprint = scope.targetFingerprint ? `.${scope.targetFingerprint}` : "";
  return sanitizeStateKey(`${adapter}.${installationType}${fingerprint}`);
}

export function installManifestPath(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, scope)}.install-manifest.json`);
}

export function sourceLockPath(targetRoot: string, adapter: string, scope: InstallStateScope = {}): string {
  return join(metadataDir(targetRoot), `${stateKeyFor(adapter, scope)}.source-lock.json`);
}

function sanitizeStateKey(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}
