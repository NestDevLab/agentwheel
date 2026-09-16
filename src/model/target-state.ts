import { posix, resolve } from "node:path";
import { computeTargetFingerprint } from "./graph-lock.js";
import type { TransportKind } from "../transport/index.js";

const targetEvolutionFields = new Set([
  "adapterCodeHash",
  "adapterConfig",
  "adapterModule",
  "targetRoot",
  "transportDescription",
  "ssh",
]);

export interface TargetStateIdentityOptions {
  targetFingerprintParts: unknown;
  workspaceRoot: string;
  targetKey: string;
  resolvedInstallRoot: string;
  transportKind: TransportKind;
}

export interface TargetStateIdentity {
  targetFingerprint: string;
  stateFingerprint: string;
}

export function resolveTargetStateIdentity(options: TargetStateIdentityOptions): TargetStateIdentity {
  return {
    targetFingerprint: computeTargetFingerprint(options.targetFingerprintParts),
    stateFingerprint: computeTargetFingerprint({
      identityVersion: 1,
      contributionScope: {
        workspaceRoot: resolve(options.workspaceRoot),
        targetKey: options.targetKey,
      },
      target: {
        ...persistentTargetParts(options.targetFingerprintParts),
        installRoot: normalizeInstallRoot(options.resolvedInstallRoot, options.transportKind),
        endpoint: targetEndpoint(options.targetFingerprintParts, options.transportKind),
      },
    }),
  };
}

function persistentTargetParts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !targetEvolutionFields.has(key)),
  );
}

function normalizeInstallRoot(path: string, transportKind: TransportKind): string {
  return transportKind === "ssh" ? posix.normalize(path) : resolve(path);
}

function targetEndpoint(value: unknown, transportKind: TransportKind): unknown {
  if (transportKind !== "ssh") return { kind: "local" };
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const ssh = record.ssh && typeof record.ssh === "object" && !Array.isArray(record.ssh)
    ? record.ssh as Record<string, unknown>
    : {};
  if (typeof ssh.host !== "string" || ssh.host.trim().length === 0) {
    throw new Error("SSH endpoint host is required for target state identity; transport description is not an identity source.");
  }
  if (ssh.user !== undefined && (typeof ssh.user !== "string" || ssh.user.trim().length === 0)) {
    throw new Error("SSH target state identity requires a non-empty endpoint user when one is provided.");
  }
  if (ssh.port !== undefined && (!Number.isInteger(ssh.port) || (ssh.port as number) <= 0)) {
    throw new Error("SSH target state identity requires a positive integer endpoint port.");
  }
  return {
    kind: "ssh",
    host: ssh.host.trim(),
    user: ssh.user,
    port: ssh.port ?? 22,
  };
}
