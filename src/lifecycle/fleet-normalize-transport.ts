import { AsyncLocalStorage } from "node:async_hooks";
import { readFile as readLocalFile, readdir as readLocalDir, rm as removeLocal, mkdir, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceScope } from "../model/fleet.js";
import { resolveConfigPath } from "../model/workspace.js";
import { createRunAsTransport, localTransport, type TargetTransport } from "../transport/index.js";
import { resolveRunAsIdentity, type RunAsIdentity } from "../transport/run-as-identity.js";
import { hashPath as hashLocalPath, pathExists as localExists, writeJsonAtomic as writeLocalJson } from "../utils/fs.js";
import { activeMutationMetadata } from "../mutation/coordinator.js";
import { assertNoSymlinkPath, syncMetadataPath } from "../install/transaction.js";

import { assertCallerRunAsWritePath } from "../transport/caller-write-trust.js";
interface Context { endpoints: Map<string, TargetTransport> }
const contexts = new AsyncLocalStorage<Context>();
const inside = (root: string, path: string) => { const rel = relative(root, resolve(path)); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export async function withNormalizationTransports<T>(scopes: WorkspaceScope[], fn: () => Promise<T>): Promise<T> {
  const endpoints = new Map<string, TargetTransport>();
  for (const scope of scopes) for (const agent of Object.values(scope.config.agents)) {
    if (agent.transport !== "local-run-as") continue;
    if (agent.adapterModule) throw new Error("Run-as normalization refuses programmatic adapters before loading code.");
    const identity = resolveRunAsIdentity(agent.runAs!, resolveConfigPath(agent.root, scope.root));
    for (const workspace of scopes) if (inside(identity.root, workspace.root) || inside(workspace.root, identity.root)) {
      throw new Error("Normalization caller workspaces and service homes must be disjoint.");
    }
    for (const root of endpoints.keys()) if (root !== identity.root && (inside(root, identity.root) || inside(identity.root, root))) {
      throw new Error("Normalization service homes must not overlap.");
    }
    const previous = endpoints.get(identity.root);
    if (previous && JSON.stringify(previous.runAsIdentity) !== JSON.stringify(identity)) throw new Error("Normalization cannot infer ownership between service identities sharing a root.");
    if (!previous) endpoints.set(identity.root, createRunAsTransport(identity));
  }
  return contexts.run({ endpoints }, fn);
}
export function normalizationIdentities(): RunAsIdentity[] {
  return [...contexts.getStore()?.endpoints.values() ?? []].map((transport) => ({ ...transport.runAsIdentity! })).sort((a, b) => a.root.localeCompare(b.root));
}
export function normalizationTransport(path: string): TargetTransport {
  const matches = [...contexts.getStore()?.endpoints.entries() ?? []].filter(([root]) => inside(root, path));
  if (matches.length > 1) throw new Error("Ambiguous normalization service root.");
  return matches[0]?.[1] ?? localTransport;
}
export function assertNormalizationMutation(): void {
  if (normalizationIdentities().length && !activeMutationMetadata()) throw new Error("Run-as normalization requires a caller-owned durable mutation receipt.");
}
export function assertNormalizationIdentities(pinned: RunAsIdentity[] | undefined): void {
  if (JSON.stringify(pinned ?? []) !== JSON.stringify(normalizationIdentities())) throw new Error("Normalization service identity changed; no runtime metadata was modified.");
}
export async function normalizationReadFile(path: string, _encoding: "utf8"): Promise<string> {
  const transport = normalizationTransport(path);
  return transport.kind === "local" ? readLocalFile(path, "utf8") : transport.readFile(path);
}
export async function normalizationReadDir(path: string): Promise<string[]> {
  const transport = normalizationTransport(path);
  return transport.kind === "local" ? readLocalDir(path) : transport.listDir(path);
}
export async function normalizationExists(path: string): Promise<boolean> {
  const transport = normalizationTransport(path);
  return transport.kind === "local" ? localExists(path) : transport.pathExists(path);
}
export async function normalizationHash(path: string): Promise<string> {
  const transport = normalizationTransport(path);
  return transport.kind === "local" ? hashLocalPath(path) : transport.hashPath(path);
}
export async function normalizationRemove(path: string, options: { force: boolean }): Promise<void> {
  const transport = normalizationTransport(path);
  if (transport.kind !== "local") { await transport.rm(path); return; }
  await assertNormalizationCallerWrite(path);
  await removeLocal(path, options);
  if (normalizationIdentities().length) await syncMetadataPath(dirname(path), true);
}
export async function normalizationWriteJson(path: string, data: unknown): Promise<void> {
  const transport = normalizationTransport(path);
  if (transport.kind !== "local") { await transport.writeJsonAtomic(path, data); return; }
  if (!normalizationIdentities().length) { await writeLocalJson(path, data); return; }
  await assertNormalizationCallerWrite(path);
  await assertNoSymlinkPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertNormalizationCallerWrite(path);
  const temporary = `${path}.pending-${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(data, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncMetadataPath(dirname(path), true);
    await syncMetadataPath(dirname(dirname(path)), true);
  } finally { await removeLocal(temporary, { force: true }); }
}

export { callerWriteTrustScript as normalizationJournalTrustScript } from "../transport/caller-write-trust.js";
export async function assertCallerNormalizationJournal(path: string): Promise<void> {
  await assertCallerRunAsWritePath(path, normalizationIdentities(), { privateFile: true });
}
export async function assertNormalizationCallerWrite(path: string): Promise<void> {
  if (normalizationTransport(path).kind === "local") await assertCallerRunAsWritePath(path, normalizationIdentities());
}
