import { resolve } from "node:path";
import { readInstallManifest, writeInstallManifest } from "../install/manifest.js";
import { stateKeyFor, type InstallStateScope } from "../install/paths.js";
import { assertExactMergeContribution, hasMergeRemovalContent } from "../install/merge-removal.js";
import { managedInstructionSelector, readManagedInstructionBlockState } from "../install/instructions-block.js";
import { defaultInstallationType } from "../model/adapter.js";
import type { InstallManifestEntry } from "../model/manifest.js";
import { acquireApplyLock, assertGovernedRuntimeTransportSupported, readApplyJournal } from "../install/transaction.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
export { workspaceOwnerForRoot } from "../model/workspace-owner.js";

export interface OwnershipHandoffRequest extends InstallStateScope {
  targetRoot: string;
  adapter: string;
  artifactType: string;
  artifactName: string;
  fromWorkspaceRoot: string;
  toWorkspaceRoot: string;
  toFleetId?: string;
  expectedHash?: string;
  expectedRevision?: string;
  transport?: TargetTransport;
}

export interface OwnershipHandoffPlan {
  adapter: string;
  installationType?: string;
  stateKey?: string;
  targetRoot: string;
  selector: string;
  path: string;
  artifactHash: string;
  manifestRevision: string;
  fromOwner: string;
  toOwner: string;
}

export async function planArtifactOwnershipHandoff(request: OwnershipHandoffRequest): Promise<OwnershipHandoffPlan> {
  return validateOwnershipHandoff(request, request.transport ?? localTransport);
}

export async function applyArtifactOwnershipHandoff(request: OwnershipHandoffRequest): Promise<OwnershipHandoffPlan> {
  if (!request.expectedHash || !request.expectedRevision) {
    throw new Error("Applying an ownership handoff requires expectedHash and expectedRevision from a reviewed dry-run.");
  }
  const transport = request.transport ?? localTransport;
  assertGovernedRuntimeTransportSupported(transport);
  const scope = { installationType: request.installationType, stateKey: request.stateKey };
  const lock = await acquireApplyLock(request.targetRoot, request.adapter, transport, {}, scope);
  try {
    if (await readApplyJournal(request.targetRoot, request.adapter, transport, scope)) {
      throw new Error("Cannot hand off ownership while an apply journal is pending. Recover or abort it first.");
    }
    const plan = await validateOwnershipHandoff(request, transport);
    const manifest = await readInstallManifest(request.targetRoot, request.adapter, transport, scope);
    if (!manifest || manifest.version !== 2) {
      throw new Error("Ownership handoff requires an Agentwheel v2 install manifest.");
    }
    assertManifestIdentity(manifest, request);
    if (manifest.revision !== request.expectedRevision) {
      throw new Error(`Manifest revision changed while locked: expected ${request.expectedRevision}, found ${manifest.revision}`);
    }
    const matches = manifest.entries.filter((entry) =>
      entry.artifactType === request.artifactType && entry.artifactName === request.artifactName
    );
    const selected = matches[0];
    if (!selected || matches.length !== 1) {
      throw new Error(`Ownership handoff selection changed while locked: ${request.artifactType}/${request.artifactName}`);
    }
    if (selected.workspaceOwner !== plan.fromOwner || selected.hash !== request.expectedHash) {
      throw new Error(`Ownership handoff preconditions changed while locked: ${request.artifactType}/${request.artifactName}`);
    }
    await writeInstallManifest({
      ...manifest,
      entries: manifest.entries.map((entry) =>
        entry.artifactType === request.artifactType && entry.artifactName === request.artifactName
          ? { ...entry, workspaceOwner: plan.toOwner }
          : entry),
    }, transport);
    return plan;
  } finally {
    await lock.release();
  }
}

async function validateOwnershipHandoff(
  request: OwnershipHandoffRequest,
  transport: TargetTransport,
): Promise<OwnershipHandoffPlan> {
  if (request.expectedHash) assertSha256(request.expectedHash, "expected artifact hash");
  if (request.expectedRevision) assertSha256(request.expectedRevision, "expected manifest revision");
  const scope = { installationType: request.installationType, stateKey: request.stateKey };
  const manifest = await readInstallManifest(request.targetRoot, request.adapter, transport, scope);
  if (!manifest) throw new Error(`No install manifest for ${request.adapter} at ${request.targetRoot}`);
  if (manifest.version !== 2) throw new Error("Ownership handoff requires an Agentwheel v2 install manifest.");
  assertManifestIdentity(manifest, request);
  if (request.expectedRevision && manifest.revision !== request.expectedRevision) {
    throw new Error(`Manifest revision precondition failed: expected ${request.expectedRevision}, found ${manifest.revision}`);
  }

  const matches = manifest.entries.filter((entry) =>
    entry.artifactType === request.artifactType && entry.artifactName === request.artifactName
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one managed artifact for ${request.artifactType}/${request.artifactName}, found ${matches.length}`,
    );
  }
  const entry = matches[0];
  const fromOwner = workspaceOwnerForRoot(request.fromWorkspaceRoot);
  const toOwner = workspaceOwnerForRoot(request.toWorkspaceRoot, request.toFleetId);
  if (fromOwner === toOwner) throw new Error("Ownership handoff requires different workspace roots.");
  if (entry.workspaceOwner !== fromOwner) {
    throw new Error(`Old owner precondition failed for ${entry.path}: expected ${fromOwner}, found ${entry.workspaceOwner}`);
  }
  if (request.expectedHash && entry.hash !== request.expectedHash) {
    throw new Error(`Manifest hash precondition failed for ${entry.path}: expected ${request.expectedHash}, found ${entry.hash}`);
  }

  const destPath = containedArtifactPath(request.targetRoot, entry.path);
  if (!(await transport.pathExists(destPath))) throw new Error(`Managed artifact is missing: ${entry.path}`);
  const currentHash = await verifiedEntryHash(entry, destPath, transport);
  if (request.expectedHash && currentHash !== request.expectedHash) {
    throw new Error(`Current hash precondition failed for ${entry.path}: expected ${request.expectedHash}, found ${currentHash}`);
  }

  return {
    adapter: request.adapter,
    installationType: request.installationType,
    stateKey: request.stateKey,
    targetRoot: request.targetRoot,
    selector: `${request.artifactType}/${request.artifactName}`,
    path: entry.path,
    artifactHash: currentHash,
    manifestRevision: manifest.revision,
    fromOwner,
    toOwner,
  };
}

async function verifiedEntryHash(
  entry: InstallManifestEntry,
  destPath: string,
  transport: TargetTransport,
): Promise<string> {
  if (entry.semanticPlugin) throw new Error(`Ownership handoff cannot verify semantic plugin state at ${destPath}`);
  if (entry.mode === "managed-block") {
    const selector = managedInstructionSelector(entry.logicalSelector, entry.artifactType, entry.artifactName);
    const state = await readManagedInstructionBlockState(destPath, selector, transport);
    if (!state.hasBlock || state.drifted || state.hash !== entry.hash) {
      throw new Error(`Managed artifact is drifted at ${destPath}: managed block is missing or changed`);
    }
    return entry.hash;
  }
  if (entry.mergeStrategy) {
    if (!hasMergeRemovalContent(entry.mergeRemoval)) {
      throw new Error(`Ownership handoff cannot verify incomplete merge ownership at ${destPath}`);
    }
    assertExactMergeContribution(entry.mergeRemoval!, entry.mergeStrategy, await transport.readFile(destPath));
    return entry.hash;
  }
  const currentHash = await transport.hashPath(destPath);
  if (currentHash !== entry.hash) {
    throw new Error(`Managed artifact is drifted at ${destPath}: manifest ${entry.hash}, current ${currentHash}`);
  }
  return currentHash;
}

function containedArtifactPath(targetRoot: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error(`Unsafe managed artifact path: ${relativePath}`);
  }
  const root = resolve(targetRoot);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Managed artifact path escapes target root: ${relativePath}`);
  }
  return candidate;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function assertManifestIdentity(
  manifest: { adapter: string; installationType: string; stateKey?: string; targetRoot: string },
  request: OwnershipHandoffRequest,
): void {
  const requestedInstallationType = request.installationType ?? defaultInstallationType;
  const requestedStateKey = stateKeyFor(request.adapter, {
    installationType: requestedInstallationType,
    stateKey: request.stateKey,
  });
  const manifestStateKey = stateKeyFor(manifest.adapter, {
    installationType: manifest.installationType,
    stateKey: manifest.stateKey,
  });
  const mismatches: string[] = [];
  if (manifest.targetRoot !== request.targetRoot) mismatches.push(`targetRoot ${manifest.targetRoot}`);
  if (manifest.adapter !== request.adapter) mismatches.push(`adapter ${manifest.adapter}`);
  if (manifest.installationType !== requestedInstallationType) {
    mismatches.push(`installationType ${manifest.installationType}`);
  }
  if (manifestStateKey !== requestedStateKey) mismatches.push(`stateKey ${manifestStateKey}`);
  if (mismatches.length > 0) {
    throw new Error(`Install manifest identity does not match requested target: ${mismatches.join(", ")}`);
  }
}
