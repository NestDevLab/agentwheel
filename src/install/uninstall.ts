import { join } from "node:path";
import { defaultInstallationType } from "../model/adapter.js";
import type { AdapterConfig } from "../model/adapter.js";
import type { InstallManifest, InstallManifestEntry, InstallManifestV1Entry } from "../model/manifest.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import type { DesiredArtifact } from "./desired.js";
import { managedInstructionBlockMode, managedInstructionSelector, readManagedInstructionBlockState } from "./instructions-block.js";
import { createCombinedInstallPlan } from "./plan.js";
import type { InstallOperation, InstallPlan } from "./plan.js";

type ManifestEntry = InstallManifestEntry | InstallManifestV1Entry;

export async function createUninstallPlan(
  manifest: InstallManifest,
  transport: TargetTransport = localTransport,
): Promise<InstallPlan> {
  const operations: InstallOperation[] = [];
  for (const entry of manifest.entries) {
    const semanticPlugin = "semanticPlugin" in entry ? entry.semanticPlugin : undefined;
    const destPath = semanticPlugin ? manifest.targetRoot : join(manifest.targetRoot, entry.path);
    if (!semanticPlugin && !(await transport.pathExists(destPath))) continue;
    const currentHash = semanticPlugin ? entry.hash : await currentEntryHash(entry, destPath, transport);
    if (currentHash !== entry.hash) {
      operations.push({
        action: "keep",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        desiredHash: entry.sourceHash,
        currentHash,
        manifestHash: entry.hash,
        reason: "managed destination changed outside agentwheel; keeping by default",
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
    } else if (entry.mergeStrategy && !("mergeRemoval" in entry && entry.mergeRemoval !== undefined) && !("mergeCreatedDestination" in entry && entry.mergeCreatedDestination === true)) {
      operations.push(legacyMergeKeepOperation(entry, destPath));
    } else {
      operations.push({
        action: "remove",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        desiredHash: entry.sourceHash,
        currentHash,
        manifestHash: entry.hash,
        reason: removalReason(entry, "uninstall managed artifact"),
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: semanticPlugin?.uninstallCommands[0] ?? entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
    }
  }
  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: manifest.adapter,
    installationType: "installationType" in manifest ? manifest.installationType : defaultInstallationType,
    stateKey: "stateKey" in manifest ? manifest.stateKey : undefined,
    targetRoot: manifest.targetRoot,
    operations,
    hasBlockingChanges: operations.some((operation) => operation.action === "conflict"),
    baseRevision: manifest.revision,
    adapterCode: manifest.adapterCode,
  };
}

export async function createOwnershipUninstallPlan(
  manifest: InstallManifest,
  remainingDesired: DesiredArtifact[],
  adapter: AdapterConfig,
  transport: TargetTransport = localTransport,
  options: { graphLockDigest?: string } = {},
): Promise<InstallPlan> {
  const installationType = "installationType" in manifest ? manifest.installationType : defaultInstallationType;
  const stateKey = "stateKey" in manifest ? manifest.stateKey : undefined;
  const desiredPlan = await createCombinedInstallPlan(remainingDesired, adapter, manifest.targetRoot, undefined, transport, { installationType, stateKey });
  const ownersByPath = new Map(
    desiredPlan.operations
      .filter((operation) => operation.owners?.length)
      .map((operation) => [operation.relativeDestPath, operation.owners ?? []]),
  );
  const operations: InstallOperation[] = [];

  for (const entry of manifest.entries) {
    const semanticPlugin = "semanticPlugin" in entry ? entry.semanticPlugin : undefined;
    const destPath = semanticPlugin ? manifest.targetRoot : join(manifest.targetRoot, entry.path);
    if (!semanticPlugin && !(await transport.pathExists(destPath))) continue;
    const currentHash = semanticPlugin ? entry.hash : await currentEntryHash(entry, destPath, transport);
    const remainingOwners = ownersByPath.get(entry.path) ?? [];

    if (remainingOwners.length > 0) {
      operations.push({
        action: "keep",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        desiredHash: entry.sourceHash,
        currentHash,
        manifestHash: entry.hash,
        reason: `still required by ${remainingOwners.join(", ")}`,
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry, remainingOwners),
        graphLockDigest: options.graphLockDigest,
        preserveInManifest: true,
      });
      continue;
    }

    if (currentHash !== entry.hash) {
      operations.push({
        action: "keep",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        desiredHash: entry.sourceHash,
        currentHash,
        manifestHash: entry.hash,
        reason: "managed destination changed outside agentwheel; keeping by default",
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
        graphLockDigest: options.graphLockDigest,
      });
    } else if (entry.mergeStrategy && !("mergeRemoval" in entry && entry.mergeRemoval !== undefined) && !("mergeCreatedDestination" in entry && entry.mergeCreatedDestination === true)) {
      operations.push(legacyMergeKeepOperation(entry, destPath));
    } else {
      operations.push({
        action: "remove",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        desiredHash: entry.sourceHash,
        currentHash,
        manifestHash: entry.hash,
        reason: removalReason(entry, "owner set became empty"),
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: semanticPlugin?.uninstallCommands[0] ?? entry.semanticCommand,
        semanticPlugin,
        execute: entry.executed,
        mergeStrategy: entry.mergeStrategy,
        mode: entry.mode,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry, []),
      });
    }
  }

  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: manifest.adapter,
    installationType,
    stateKey,
    targetRoot: manifest.targetRoot,
    operations,
    hasBlockingChanges: operations.some((operation) => operation.action === "conflict"),
    baseRevision: manifest.revision,
    adapterCode: manifest.adapterCode,
    graphLockDigest: options.graphLockDigest,
  };
}

async function currentEntryHash(entry: ManifestEntry, destPath: string, transport: TargetTransport): Promise<string | undefined> {
  if (entry.mode !== managedInstructionBlockMode) return transport.hashPath(destPath);
  const selector = managedInstructionSelector("logicalSelector" in entry ? entry.logicalSelector : undefined, entry.artifactType, entry.artifactName);
  const state = await readManagedInstructionBlockState(destPath, selector, transport);
  return state.hash;
}

function operationMetadataFromEntry(entry: ManifestEntry, ownersOverride?: string[]): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "graphLockDigest" | "mergeRemoval" | "mergeCreatedDestination"
> {
  if ("owners" in entry) {
    return {
      installName: entry.installName,
      logicalSelector: entry.logicalSelector,
      graphNodeId: entry.graphNodeId,
      dependencyRole: entry.dependencyRole,
      owners: ownersOverride ?? entry.owners,
      graphLockDigest: entry.graphLockDigest,
      mergeRemoval: entry.mergeRemoval,
      mergeCreatedDestination: entry.mergeCreatedDestination,
    };
  }
  return {
    installName: entry.artifactName,
    logicalSelector: `${entry.artifactType}/${entry.artifactName}`,
    dependencyRole: "root",
    owners: ownersOverride?.length ? ownersOverride : [entry.packageName ?? "legacy"],
  };
}

function legacyMergeKeepOperation(entry: ManifestEntry, destPath: string): InstallOperation {
  return {
    action: "keep", artifactType: entry.artifactType, artifactName: entry.artifactName, kind: entry.kind, destPath,
    relativeDestPath: entry.path, desiredHash: entry.sourceHash, currentHash: entry.hash, manifestHash: entry.hash,
    reason: "legacy merge ownership is incomplete; preserving destination and releasing management",
    channel: entry.channel, packageName: entry.packageName, semanticCommand: entry.semanticCommand,
    semanticPlugin: "semanticPlugin" in entry ? entry.semanticPlugin : undefined, execute: entry.executed,
    mergeStrategy: entry.mergeStrategy, mode: entry.mode, composedFrom: entry.composedFrom, preserveInManifest: false,
    ...operationMetadataFromEntry(entry, []),
  };
}

function removalReason(entry: ManifestEntry, fallback: string): string {
  if (!entry.mergeStrategy) return fallback;
  return "mergeCreatedDestination" in entry && entry.mergeCreatedDestination === true
    ? "remove entire file created by Agentwheel as merge destination"
    : "remove managed merge contribution; preserving merge destination";
}
