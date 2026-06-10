import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { InstallManifest, InstallManifestEntry, InstallManifestV1Entry } from "../model/manifest.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";
import type { DesiredArtifact } from "./desired.js";
import { createCombinedInstallPlan } from "./plan.js";
import type { InstallOperation, InstallPlan } from "./plan.js";

type ManifestEntry = InstallManifestEntry | InstallManifestV1Entry;

export async function createUninstallPlan(
  manifest: InstallManifest,
  transport: TargetTransport = localTransport,
): Promise<InstallPlan> {
  const operations: InstallOperation[] = [];
  for (const entry of manifest.entries) {
    const destPath = join(manifest.targetRoot, entry.path);
    if (!(await transport.pathExists(destPath))) continue;
    const currentHash = await transport.hashPath(destPath);
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
        mergeStrategy: entry.mergeStrategy,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
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
        reason: "uninstall managed artifact",
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        mergeStrategy: entry.mergeStrategy,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
    }
  }
  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: manifest.adapter,
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
): Promise<InstallPlan> {
  const desiredPlan = await createCombinedInstallPlan(remainingDesired, adapter, manifest.targetRoot, undefined, transport);
  const ownersByPath = new Map(
    desiredPlan.operations
      .filter((operation) => operation.owners?.length)
      .map((operation) => [operation.relativeDestPath, operation.owners ?? []]),
  );
  const operations: InstallOperation[] = [];

  for (const entry of manifest.entries) {
    const destPath = join(manifest.targetRoot, entry.path);
    if (!(await transport.pathExists(destPath))) continue;
    const currentHash = await transport.hashPath(destPath);
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
        mergeStrategy: entry.mergeStrategy,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry, remainingOwners),
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
        mergeStrategy: entry.mergeStrategy,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry),
      });
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
        reason: "owner set became empty",
        channel: entry.channel,
        packageName: entry.packageName,
        semanticCommand: entry.semanticCommand,
        mergeStrategy: entry.mergeStrategy,
        composedFrom: entry.composedFrom,
        ...operationMetadataFromEntry(entry, []),
      });
    }
  }

  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: manifest.adapter,
    targetRoot: manifest.targetRoot,
    operations,
    hasBlockingChanges: operations.some((operation) => operation.action === "conflict"),
    baseRevision: manifest.revision,
    adapterCode: manifest.adapterCode,
  };
}

function operationMetadataFromEntry(entry: ManifestEntry, ownersOverride?: string[]): Pick<
  InstallOperation,
  "installName" | "logicalSelector" | "graphNodeId" | "dependencyRole" | "owners" | "graphLockDigest"
> {
  if ("owners" in entry) {
    return {
      installName: entry.installName,
      logicalSelector: entry.logicalSelector,
      graphNodeId: entry.graphNodeId,
      dependencyRole: entry.dependencyRole,
      owners: ownersOverride ?? entry.owners,
      graphLockDigest: entry.graphLockDigest,
    };
  }
  return {
    installName: entry.artifactName,
    logicalSelector: `${entry.artifactType}/${entry.artifactName}`,
    dependencyRole: "root",
    owners: ownersOverride?.length ? ownersOverride : [entry.packageName ?? "legacy"],
  };
}
