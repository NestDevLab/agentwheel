import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  computeInstallManifestInventoryRevision,
  readInstallManifest,
} from "../install/manifest.js";
import { commitManifestMetadataJournal } from "../install/apply.js";
import { installManifestPath, stateKeyFor } from "../install/paths.js";
import {
  acquireApplyLock,
  listAllApplyJournals,
  mutationMetadataForApplyJournal,
  writeApplyJournal,
  type ApplyJournal,
} from "../install/transaction.js";
import type { InstallManifestEntry, InstallManifestV2 } from "../model/manifest.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { containedArtifactPath, verifyManifestEntryRuntime } from "./ownership.js";
import { managedInstructionSelector } from "../install/instructions-block.js";
import { hasMergeRemovalContent, mergeContributionAbsent } from "../install/merge-removal.js";

export interface RetireStaleOwnershipRequest {
  targetRoot: string;
  adapter: string;
  installationType: string;
  sourceStateKey: string;
  destinationStateKey: string;
  fromWorkspaceRoot: string;
  toWorkspaceRoot: string;
  toFleetId: string;
  planDigest?: string;
  expectedSourceRevision?: string;
  expectedDestinationRevision?: string;
  expectedInventoryRevision?: string;
  abandonIncompleteMergeOwner?: boolean;
  transport?: TargetTransport;
}

export interface RetireStaleOwnershipEntry {
  path: string;
  sourceEntryDigest: string;
  destinationEntryDigest: string;
  runtimeHash: string;
  coverage: "exact" | "abandoned-incomplete-merge";
}

export interface RetireStaleOwnershipPlan {
  adapter: string;
  installationType: string;
  targetRoot: string;
  source: { stateKey: string; manifestPath: string; revision: string; owner: string };
  destination: { stateKey: string; manifestPath: string; revision: string; owner: string; fleetId: string };
  manifestInventoryRevision: string;
  selected: RetireStaleOwnershipEntry[];
  planDigest: string;
}

export interface RetireStaleOwnershipResult extends RetireStaleOwnershipPlan {
  applied: true;
  sourceManifestRemoved: boolean;
  retainedSourceEntries: number;
}

export async function planRetireStaleOwnership(
  request: RetireStaleOwnershipRequest,
): Promise<RetireStaleOwnershipPlan> {
  return observe(request, request.transport ?? localTransport);
}

export async function applyRetireStaleOwnership(
  request: RetireStaleOwnershipRequest,
): Promise<RetireStaleOwnershipResult> {
  assertApplyPreconditions(request);
  const transport = request.transport ?? localTransport;
  const lock = await acquireApplyLock(request.targetRoot, request.adapter, transport, {}, {
    installationType: request.installationType,
    stateKey: request.destinationStateKey,
  });
  try {
    const pending = await listAllApplyJournals(request.targetRoot, request.adapter, transport);
    if (pending.length > 0) {
      throw new Error(`Cannot retire stale ownership while runtime apply journal(s) are pending: ${pending.map((item) => item.path).join(", ")}`);
    }
    const current = await observe(request, transport);
    assertExpected(request.planDigest!, current.planDigest, "plan digest");
    assertExpected(request.expectedSourceRevision!, current.source.revision, "source manifest revision");
    assertExpected(request.expectedDestinationRevision!, current.destination.revision, "destination manifest revision");
    assertExpected(request.expectedInventoryRevision!, current.manifestInventoryRevision, "manifest inventory revision");

    const source = await requireManifest(request, request.sourceStateKey, transport, "source");
    const selectedDigests = new Set(current.selected.map((entry) => entry.sourceEntryDigest));
    const retained = source.entries.filter((entry) => !selectedDigests.has(entryDigest(entry)));
    if (source.entries.length - retained.length !== current.selected.length) {
      throw new Error("Source manifest selection changed while locked; replan required.");
    }
    declareMutationPath(current.source.manifestPath);
    const now = new Date().toISOString();
    const mutation = mutationMetadataForApplyJournal();
    const journal: ApplyJournal = {
      version: mutation ? 2 : 1,
      ...(mutation ? { mutation } : {}),
      mode: "uninstall",
      adapter: request.adapter,
      installationType: request.installationType,
      stateKey: request.sourceStateKey,
      targetRoot: request.targetRoot,
      baseRevision: source.revision,
      createdAt: now,
      updatedAt: now,
      operations: [],
      completed: [],
      manifest: { ...source, entries: retained },
    };
    await writeApplyJournal(journal, transport);
    await commitManifestMetadataJournal(journal, transport);
    return {
      ...current,
      applied: true,
      sourceManifestRemoved: retained.length === 0,
      retainedSourceEntries: retained.length,
    };
  } finally {
    await lock.release();
  }
}

async function observe(
  request: RetireStaleOwnershipRequest,
  transport: TargetTransport,
): Promise<RetireStaleOwnershipPlan> {
  const normalized = normalizeRequest(request);
  const source = await requireManifest(normalized, normalized.sourceStateKey, transport, "source");
  const destination = await requireManifest(normalized, normalized.destinationStateKey, transport, "destination");
  const sourceOwner = workspaceOwnerForRoot(normalized.fromWorkspaceRoot);
  const destinationOwner = workspaceOwnerForRoot(normalized.toWorkspaceRoot, normalized.toFleetId);
  const destinationByPath = new Map<string, InstallManifestEntry[]>();
  for (const entry of destination.entries) {
    if (entry.workspaceOwner !== destinationOwner) continue;
    const entries = destinationByPath.get(entry.path) ?? [];
    entries.push(entry);
    destinationByPath.set(entry.path, entries);
  }

  const selected: RetireStaleOwnershipEntry[] = [];
  for (const sourceEntry of source.entries) {
    if (sourceEntry.workspaceOwner !== sourceOwner) continue;
    const candidates = destinationByPath.get(sourceEntry.path) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length !== 1) {
      throw new Error(`Destination Fleet manifest has ambiguous ownership for ${sourceEntry.path}.`);
    }
    assertRetirableSourceEntry(sourceEntry, normalized.abandonIncompleteMergeOwner === true);
    const destinationEntry = candidates[0]!;
    const coverage = await assertContributionCoverage(
      sourceEntry,
      destinationEntry,
      normalized.targetRoot,
      transport,
      normalized.abandonIncompleteMergeOwner === true,
    );
    const runtimeHash = coverage === "abandoned-incomplete-merge"
      ? await transport.hashPath(containedArtifactPath(normalized.targetRoot, destinationEntry.path))
      : await verifyManifestEntryRuntime(normalized.targetRoot, destinationEntry, transport);
    selected.push({
      path: sourceEntry.path,
      sourceEntryDigest: entryDigest(sourceEntry),
      destinationEntryDigest: entryDigest(destinationEntry),
      runtimeHash,
      coverage,
    });
  }
  selected.sort((a, b) => a.path.localeCompare(b.path)
    || a.sourceEntryDigest.localeCompare(b.sourceEntryDigest)
    || a.destinationEntryDigest.localeCompare(b.destinationEntryDigest));
  if (selected.length === 0) {
    throw new Error("No stale source ownership entries match an exact path in the destination Fleet manifest.");
  }

  const withoutDigest = {
    adapter: normalized.adapter,
    installationType: normalized.installationType,
    targetRoot: normalized.targetRoot,
    source: {
      stateKey: normalized.sourceStateKey,
      manifestPath: installManifestPath(normalized.targetRoot, normalized.adapter, {
        installationType: normalized.installationType,
        stateKey: normalized.sourceStateKey,
      }),
      revision: source.revision,
      owner: sourceOwner,
    },
    destination: {
      stateKey: normalized.destinationStateKey,
      manifestPath: installManifestPath(normalized.targetRoot, normalized.adapter, {
        installationType: normalized.installationType,
        stateKey: normalized.destinationStateKey,
      }),
      revision: destination.revision,
      owner: destinationOwner,
      fleetId: normalized.toFleetId,
    },
    manifestInventoryRevision: await computeInstallManifestInventoryRevision(
      normalized.targetRoot,
      normalized.adapter,
      transport,
    ),
    selected,
  };
  return { ...withoutDigest, planDigest: digest(withoutDigest) };
}

function normalizeRequest(request: RetireStaleOwnershipRequest): RetireStaleOwnershipRequest {
  const targetRoot = resolve(request.targetRoot);
  const sourceStateKey = exactStateKey(request.adapter, request.sourceStateKey, request.installationType, "source");
  const destinationStateKey = exactStateKey(request.adapter, request.destinationStateKey, request.installationType, "destination");
  if (sourceStateKey === destinationStateKey) throw new Error("Source and destination state keys must differ.");
  if (!request.toFleetId.trim()) throw new Error("Destination Fleet id is required.");
  return {
    ...request,
    targetRoot,
    installationType: request.installationType.trim(),
    sourceStateKey,
    destinationStateKey,
    fromWorkspaceRoot: resolve(request.fromWorkspaceRoot),
    toWorkspaceRoot: resolve(request.toWorkspaceRoot),
    toFleetId: request.toFleetId.trim(),
  };
}

function exactStateKey(adapter: string, value: string, installationType: string, label: string): string {
  if (!value || stateKeyFor(adapter, { installationType, stateKey: value }) !== value) {
    throw new Error(`The ${label} state key must be an exact canonical state key.`);
  }
  return value;
}

async function requireManifest(
  request: RetireStaleOwnershipRequest,
  stateKey: string,
  transport: TargetTransport,
  label: string,
): Promise<InstallManifestV2> {
  const manifest = await readInstallManifest(request.targetRoot, request.adapter, transport, {
    installationType: request.installationType,
    stateKey,
  });
  if (!manifest) throw new Error(`No ${label} install manifest for state key ${stateKey}.`);
  if (manifest.version !== 2) throw new Error(`${label} ownership retirement requires an Agentwheel v2 install manifest.`);
  const actualStateKey = stateKeyFor(manifest.adapter, {
    installationType: manifest.installationType,
    stateKey: manifest.stateKey,
  });
  if (manifest.adapter !== request.adapter
    || manifest.installationType !== request.installationType
    || resolve(manifest.targetRoot) !== request.targetRoot
    || actualStateKey !== stateKey) {
    throw new Error(`${label} install manifest identity does not match the requested adapter, target, installation type, and state key.`);
  }
  return manifest;
}

function assertRetirableSourceEntry(
  entry: InstallManifestEntry,
  abandonIncompleteMergeOwner: boolean,
): void {
  if (entry.semanticPlugin || entry.semanticCommand || entry.executed) {
    throw new Error(`Cannot retire semantic source ownership at ${entry.path}.`);
  }
  if (entry.mergeStrategy && !hasMergeRemovalContent(entry.mergeRemoval)) {
    if (abandonIncompleteMergeOwner) return;
    throw new Error(`Cannot retire incomplete merge ownership at ${entry.path}.`);
  }
}

async function assertContributionCoverage(
  source: InstallManifestEntry,
  destination: InstallManifestEntry,
  targetRoot: string,
  transport: TargetTransport,
  abandonIncompleteMergeOwner: boolean,
): Promise<RetireStaleOwnershipEntry["coverage"]> {
  const sourceManagedBlock = source.mode === "managed-block";
  const destinationManagedBlock = destination.mode === "managed-block";
  const sourceMerge = source.mergeStrategy !== undefined;
  const destinationMerge = destination.mergeStrategy !== undefined;
  const sourceCategory = sourceManagedBlock ? "managed-block" : sourceMerge ? "merge" : "plain";
  const destinationCategory = destinationManagedBlock ? "managed-block" : destinationMerge ? "merge" : "plain";
  if (sourceCategory !== destinationCategory) {
    throw new Error(
      `Destination Fleet ownership category ${destinationCategory} cannot replace stale source category ${sourceCategory} at ${source.path}.`,
    );
  }
  if (sourceCategory === "plain") return "exact";
  if (sourceManagedBlock) {
    const sourceSelector = managedInstructionSelector(source.logicalSelector, source.artifactType, source.artifactName);
    const destinationSelector = managedInstructionSelector(destination.logicalSelector, destination.artifactType, destination.artifactName);
    if (!sourceManagedBlock || !destinationManagedBlock
      || sourceSelector !== destinationSelector) {
      throw new Error(`Destination Fleet does not exactly cover stale source managed block contribution at ${source.path}.`);
    }
    return "exact";
  }

  if (source.mergeStrategy && destination.mergeStrategy) {
    if (!hasMergeRemovalContent(source.mergeRemoval)) {
      if (abandonIncompleteMergeOwner) return "abandoned-incomplete-merge";
      throw new Error(`Cannot retire incomplete merge ownership at ${source.path}.`);
    }
    const exactlyCovered = destination.mergeStrategy === source.mergeStrategy
      && hasMergeRemovalContent(destination.mergeRemoval)
      && contributionSelector(source) === contributionSelector(destination)
      && canonicalJson(source.mergeRemoval) === canonicalJson(destination.mergeRemoval);
    if (exactlyCovered) return "exact";
    const current = await transport.readFile(containedArtifactPath(targetRoot, source.path));
    if (!mergeContributionAbsent(source.mergeRemoval!, source.mergeStrategy, current)) {
      throw new Error(`Destination Fleet does not exactly cover or replace stale source merge contribution at ${source.path}.`);
    }
    return "exact";
  }
  throw new Error(`Unsupported ownership coverage at ${source.path}.`);
}

function contributionSelector(entry: InstallManifestEntry): string {
  return entry.logicalSelector ?? `${entry.artifactType}/${entry.artifactName}`;
}

function assertApplyPreconditions(request: RetireStaleOwnershipRequest): void {
  for (const [label, value] of [
    ["plan digest", request.planDigest],
    ["source manifest revision", request.expectedSourceRevision],
    ["destination manifest revision", request.expectedDestinationRevision],
    ["manifest inventory revision", request.expectedInventoryRevision],
  ] as const) {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Applying stale ownership retirement requires a reviewed lowercase SHA-256 ${label}.`);
    }
  }
}

function assertExpected(expected: string, current: string, label: string): void {
  if (expected !== current) throw new Error(`Stale ${label}: expected ${expected}, found ${current}; replan required.`);
}

function entryDigest(entry: InstallManifestEntry): string {
  return digest(entry);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
