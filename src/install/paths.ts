import { join } from "node:path";
import { defaultInstallationType } from "../model/adapter.js";

export interface InstallStateScope {
  installationType?: string;
  stateKey?: string;
  targetFingerprint?: string;
  fleetId?: string;
}

export function metadataDir(targetRoot: string): string {
  return join(targetRoot, ".agentwheel");
}

export function stateKeyFor(adapter: string, scope: InstallStateScope = {}): string {
  assertPathSafeAdapterName(adapter);
  if (scope.stateKey) {
    const explicit = sanitizeStateKey(scope.stateKey);
    const adapterScoped = scope.fleetId && explicit !== adapter && !explicit.startsWith(`${adapter}.`)
      ? `${adapter}.${explicit}`
      : explicit;
    const fleetSuffix = scope.fleetId
      ? `.fleet-${sanitizeStateKey(scope.fleetId)}${scope.targetFingerprint ? `.${scope.targetFingerprint}` : ""}`
      : "";
    return sanitizeStateKey(`${adapterScoped}${fleetSuffix}`);
  }
  const installationType = scope.installationType ?? defaultInstallationType;
  const fingerprint = scope.targetFingerprint ? `.${scope.targetFingerprint}` : "";
  return sanitizeStateKey(`${adapter}.${installationType}${fingerprint}`);
}

export function assertPathSafeAdapterName(adapter: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(adapter)) {
    throw new Error(`Adapter name '${adapter}' is not a canonical path-safe identifier.`);
  }
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
