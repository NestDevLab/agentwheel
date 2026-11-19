import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { renderOpenClawJsonMergeSource } from "./openclaw-json-merge.js";
import { listInstallManifests } from "./manifest.js";
import { stateKeyFor } from "./paths.js";
import type { InstallOperation } from "./plan.js";
import type { MergeRemoval, MergeValue } from "./merge-removal.js";
import type { InstallManifestEntry } from "../model/manifest.js";
import type { TargetTransport } from "../transport/index.js";

export interface JsonKeyClaim {
  path: string[];
  value: MergeValue;
  previous?: MergeValue;
  createdParents: number[];
}

function isObject(value: unknown): value is MergeRemoval {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeJsonKey(key: string): boolean {
  return Boolean(key) && !["__proto__", "prototype", "constructor", "$include"].includes(key);
}

export function jsonKeyLeaves(value: MergeValue, path: string[] = []): JsonKeyClaim[] {
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) throw new Error("Empty objects cannot be claimed as JSON keys.");
    return entries.flatMap(([key, entry]) => {
      if (!safeJsonKey(key)) throw new Error("Unsupported key in OpenClaw settings contribution.");
      return jsonKeyLeaves(entry, [...path, key]);
    });
  }
  if (!path.length) throw new Error("OpenClaw settings contribution must be an object.");
  return [{ path, value, createdParents: [] }];
}

function validate(claims: readonly JsonKeyClaim[]): void {
  for (const [index, claim] of claims.entries()) {
    if (!claim.path.length || claim.path.some((key) => !safeJsonKey(key))
      || isObject(claim.value) || isObject(claim.previous)
      || claim.createdParents.some((depth) => !Number.isInteger(depth) || depth < 1 || depth >= claim.path.length)
      || claims.slice(0, index).some((other) => jsonKeyPathsOverlap(claim.path, other.path))) {
      throw new Error("Invalid or overlapping JSON key claims.");
    }
  }
}

export function readJsonKey(root: MergeRemoval, path: readonly string[]): MergeValue | undefined {
  let value: MergeValue | undefined = root;
  for (const key of path) {
    if (value === undefined) return undefined;
    if (!isObject(value)) throw new Error("Non-object ancestor of a managed JSON key.");
    value = Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return value;
}

function set(root: MergeRemoval, path: readonly string[], value: MergeValue | undefined): void {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) parent[key] = {};
    const child = parent[key];
    if (!isObject(child)) throw new Error("Non-object ancestor of a managed JSON key.");
    parent = child;
  }
  const leaf = path.at(-1)!;
  if (value === undefined) delete parent[leaf];
  else parent[leaf] = value;
}

export function parseKeyOwnedConfig(content: string | undefined): MergeRemoval {
  const value: unknown = content === undefined ? {} : JSON.parse(content);
  if (!isObject(value) || Object.hasOwn(value, "$include")) {
    throw new Error("Key ownership requires a standalone OpenClaw JSON object.");
  }
  return value;
}

export function jsonKeyPathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.slice(0, Math.min(left.length, right.length)).every((key, index) => key === right[index]);
}

export function jsonKeyClaimsOverlap(left: JsonKeyClaim, right: JsonKeyClaim): boolean {
  return jsonKeyPathsOverlap(left.path, right.path)
    || left.createdParents.some((depth) => jsonKeyPathsOverlap(left.path.slice(0, depth), right.path))
    || right.createdParents.some((depth) => jsonKeyPathsOverlap(left.path, right.path.slice(0, depth)));
}

function assertCurrent(config: MergeRemoval, claims: JsonKeyClaim[]): void {
  validate(claims);
  if (claims.some((claim) => !isDeepStrictEqual(readJsonKey(config, claim.path), claim.value))) {
    throw new Error("Managed JSON key changed outside Agentwheel.");
  }
}

export function renderJsonKeyTransition(content: string | undefined, claims: JsonKeyClaim[], released: JsonKeyClaim[]): string {
  validate(claims);
  validate(released);
  const config = parseKeyOwnedConfig(content);
  assertCurrent(config, released);
  for (const claim of released) set(config, claim.path, claim.previous);
  for (const claim of claims) set(config, claim.path, claim.value);
  for (const claim of released) for (const depth of [...claim.createdParents].sort((a, b) => b - a)) {
    const path = claim.path.slice(0, depth);
    const value = readJsonKey(config, path);
    if (isObject(value) && !Object.keys(value).length) set(config, path, undefined);
  }
  return JSON.stringify(config, null, 2) + "\n";
}

export function jsonFileHash(content: string): string {
  return createHash("sha256").update("file\0").update(content).digest("hex");
}

export async function planJsonKeyChange(
  operation: InstallOperation,
  content: string | undefined,
  previous: JsonKeyClaim[],
  removing = false,
): Promise<InstallOperation> {
  if (content === undefined) throw new Error("Key ownership requires an existing OpenClaw configuration.");
  const config = parseKeyOwnedConfig(content);
  assertCurrent(config, previous);
  const desired = removing ? [] : jsonKeyLeaves(await renderOpenClawJsonMergeSource(operation.sourcePath!));
  if (desired.some((claim) => operation.keyMigration?.releasedPaths.some((path) => jsonKeyPathsOverlap(path, claim.path)))) {
    throw new Error("Migrated OpenClaw artifact still declares released keys; remove them from its source.");
  }
  validate(desired);
  for (const claim of desired) {
    const existing = previous.find((old) => isDeepStrictEqual(old.path, claim.path));
    if (existing) {
      if (existing.previous !== undefined) claim.previous = existing.previous;
      claim.createdParents = existing.createdParents;
    } else {
      if (previous.some((old) => jsonKeyPathsOverlap(old.path, claim.path))) {
        throw new Error("Managed JSON key cannot change between a leaf and an object.");
      }
      const baseline = readJsonKey(config, claim.path);
      if (isObject(baseline)) throw new Error("A JSON key claim cannot replace an object.");
      if (baseline !== undefined) claim.previous = baseline;
      for (let depth = 1; depth < claim.path.length; depth++) {
        const parent = claim.path.slice(0, depth);
        if (readJsonKey(config, parent) === undefined || previous.some((old) =>
          old.createdParents.includes(depth) && isDeepStrictEqual(old.path.slice(0, depth), parent))) {
          claim.createdParents.push(depth);
        }
      }
    }
  }
  const released = previous.filter((old) => !desired.some((claim) => isDeepStrictEqual(old.path, claim.path)));
  const unchanged = !removing && !released.length && previous.length === desired.length
    && desired.every((claim) => previous.some((old) => isDeepStrictEqual(old, claim)));
  if (removing && !previous.length && operation.keyMigration) {
    return { ...operation, action: "keep", reason: "preserve the OpenClaw migration fence",
      preserveInManifest: true, currentHash: jsonFileHash(content) };
  }
  return {
    ...operation,
    action: removing ? "remove" : unchanged ? "skip" : "update",
    reason: removing ? "restore the previous values of owned JSON keys" : unchanged ? "owned JSON keys already match" : "apply owned JSON keys",
    currentHash: jsonFileHash(content),
    keyOwnership: desired,
    keyRelease: released,
    keyResultHash: unchanged ? undefined : jsonFileHash(renderJsonKeyTransition(content, desired, released)),
  };
}

export function assertOwnedJsonKeys(content: string, claims: JsonKeyClaim[]): void {
  assertCurrent(parseKeyOwnedConfig(content), claims);
}

export function assertJsonKeyHandoff(
  claims: readonly JsonKeyClaim[], migration: InstallManifestEntry["keyMigration"],
  stateKey: string, workspaceOwner: string | undefined,
): void {
  for (const handoff of migration?.handoffs ?? []) for (const claim of claims) {
    if (!jsonKeyPathsOverlap(handoff.path, claim.path)) continue;
    if (!isDeepStrictEqual(handoff.path, claim.path)
      || handoff.stateKey !== stateKey || handoff.workspaceOwner !== workspaceOwner) {
      throw new Error("OpenClaw key handoff is reserved for another exact recipient.");
    }
  }
}

export async function assertJsonKeyOwnershipInventory(
  operations: InstallOperation[], targetRoot: string, adapter: string, installationType: string,
  stateKey: string | undefined, transport: TargetTransport,
): Promise<void> {
  if (adapter !== "openclaw" || !operations.length) return;
  const scopeKey = stateKeyFor(adapter, { installationType, stateKey });
  for (const item of await listInstallManifests(targetRoot, adapter, transport)) {
    if (item.stateKey === scopeKey) continue;
    for (const entry of item.manifest.entries) for (const operation of operations) {
      if (entry.path !== operation.relativeDestPath || !["create", "update", "skip", "remove"].includes(operation.action)) continue;
      if (!entry.keyOwnership && !operation.keyOwnership) continue;
      if (!entry.keyOwnership || entry.mergeStrategy !== "openclaw-json-keys"
        || !operation.keyOwnership || operation.mergeStrategy !== "openclaw-json-keys" || item.manifest.version !== 2
        || item.manifest.installationType !== installationType) {
        throw new Error("JSON key ownership conflicts with an existing whole-file or legacy claim.");
      }
      validate(entry.keyOwnership);
      const claimedOrReleased = [...operation.keyOwnership, ...(operation.keyRelease ?? [])];
      assertJsonKeyHandoff(claimedOrReleased, entry.keyMigration, scopeKey, operation.workspaceOwner);
      if (claimedOrReleased.some((claim) =>
        entry.keyOwnership!.some((other) => jsonKeyClaimsOverlap(claim, other)))) {
        throw new Error("JSON key ownership overlaps another install state.");
      }
    }
  }
}
