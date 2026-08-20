import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { defaultInstallationType } from "../model/adapter.js";
import { installManifestSchema, installManifestV2Schema, type InstallManifest, type InstallManifestV2, type SourceLock } from "../model/manifest.js";
import { sourceLockSchema } from "../model/manifest.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { installManifestPath, metadataDir, sourceLockPath, type InstallStateScope } from "./paths.js";

export async function readInstallManifest(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<InstallManifest | undefined> {
  const path = installManifestPath(targetRoot, adapter, scope);
  if (!(await transport.pathExists(path))) return undefined;
  const raw = JSON.parse(await transport.readFile(path));
  const parsed = installManifestSchema.parse(raw);
  return {
    ...parsed,
    revision: computeManifestRevision(raw),
  };
}

export interface DiscoveredInstallManifest {
  path: string;
  fileName: string;
  stateKey: string;
  manifest: InstallManifest;
}

// Install state is keyed by target fingerprint, so one runtime root can hold several manifests that
// describe the same directory tree and cannot see each other. Callers that need to reason about the
// whole root -- not just their own slice of it -- must enumerate rather than read a single state key.
export async function listInstallManifests(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
): Promise<DiscoveredInstallManifest[]> {
  const dir = metadataDir(targetRoot);
  const suffix = ".install-manifest.json";
  const prefix = `${adapter}.`;
  const found: DiscoveredInstallManifest[] = [];
  for (const fileName of await transport.listDir(dir)) {
    if (!fileName.endsWith(suffix)) continue;
    const stateKey = fileName.slice(0, -suffix.length);
    if (stateKey !== adapter && !stateKey.startsWith(prefix)) continue;
    const path = join(dir, fileName);
    try {
      const raw = JSON.parse(await transport.readFile(path));
      const parsed = installManifestSchema.parse(raw);
      found.push({ path, fileName, stateKey, manifest: { ...parsed, revision: computeManifestRevision(raw) } });
    } catch (error) {
      throw new Error(`Unreadable install manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return found.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function writeInstallManifest(manifest: InstallManifest, transport: TargetTransport = localTransport): Promise<void> {
  const next = withManifestRevision(manifest);
  await transport.writeJsonAtomic(installManifestPath(next.targetRoot, next.adapter, {
    installationType: next.installationType,
    stateKey: next.stateKey,
  }), stripReadOnlyManifestFields(next));
}

export async function writeSourceLock(
  targetRoot: string,
  adapter: string,
  lock: SourceLock,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<void> {
  await transport.writeJsonAtomic(sourceLockPath(targetRoot, adapter, scope), lock);
}

export async function readSourceLock(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<SourceLock | undefined> {
  const path = sourceLockPath(targetRoot, adapter, scope);
  if (!(await transport.pathExists(path))) return undefined;
  return sourceLockSchema.parse(JSON.parse(await transport.readFile(path)));
}

export async function removeStateFiles(
  targetRoot: string,
  adapter: string,
  transport: TargetTransport = localTransport,
  scope: InstallStateScope = {},
): Promise<void> {
  await transport.rm(installManifestPath(targetRoot, adapter, scope));
  await transport.rm(sourceLockPath(targetRoot, adapter, scope));
}

export function normalizeTargetRoot(path: string): string {
  return resolve(path);
}

export function withManifestRevision(manifest: InstallManifest): InstallManifestV2 {
  if (manifest.version !== 2) {
    throw new Error("Install manifest writes must use version 2");
  }
  const raw = stripReadOnlyManifestFields(manifest) as Record<string, unknown>;
  const normalized = installManifestV2Schema.parse({
    installationType: defaultInstallationType,
    ...raw,
  });
  const withoutRevision = stripRuntimeManifestFields(normalized);
  return {
    ...normalized,
    legacy: false,
    revision: computeManifestRevision(withoutRevision),
  };
}

// Revisions are content hashes of the manifest body with runtime-only/read-only fields removed.
// That makes the apply base check detect any manifest movement without a mutable counter.
export function computeManifestRevision(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(stripRuntimeManifestFields(manifest))).digest("hex");
}

function stripRuntimeManifestFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "revision" || key === "legacy") continue;
    out[key] = stripRuntimeManifestFields(item);
  }
  return out;
}

function stripReadOnlyManifestFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "legacy") continue;
    out[key] = stripReadOnlyManifestFields(item);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
