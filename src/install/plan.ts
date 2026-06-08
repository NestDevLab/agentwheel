import { join, relative } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact, ArtifactType, FileKind } from "../model/artifact.js";
import type { InstallManifest } from "../model/manifest.js";
import type { StagedBundle } from "../staging/staging.js";
import { hashPath, pathExists } from "../utils/fs.js";

export type PlanAction = "create" | "update" | "skip" | "remove" | "drift" | "conflict";
export type PlanChannel = "managed" | "overlay" | "addition" | "override" | "ejected";

export interface InstallOperation {
  action: PlanAction;
  artifactType: ArtifactType;
  artifactName: string;
  kind: FileKind;
  sourcePath?: string;
  destPath: string;
  relativeDestPath: string;
  desiredHash?: string;
  currentHash?: string;
  manifestHash?: string;
  reason: string;
  channel: PlanChannel;
  packageName?: string;
}

export interface InstallPlan {
  adapter: string;
  targetRoot: string;
  operations: InstallOperation[];
  hasBlockingChanges: boolean;
}

export async function createInstallPlan(
  bundle: StagedBundle,
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
): Promise<InstallPlan> {
  const desired = new Map<string, InstallOperation>();

  for (const artifact of bundle.artifacts) {
    const op = operationForArtifact(artifact, adapter, targetRoot);
    if (op) {
      desired.set(op.relativeDestPath, op);
    }
  }

  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const operations: InstallOperation[] = [];

  for (const op of desired.values()) {
    const existing = manifestByPath.get(op.relativeDestPath);
    const exists = await pathExists(op.destPath);
    if (!exists) {
      operations.push({ ...op, action: "create", reason: "destination missing" });
      continue;
    }

    const currentHash = await hashPath(op.destPath);
    if (!existing) {
      operations.push({ ...op, action: "conflict", currentHash, reason: "destination exists but is not managed" });
      continue;
    }

    if (currentHash !== existing.hash) {
      operations.push({
        ...op,
        action: "drift",
        currentHash,
        manifestHash: existing.hash,
        reason: "managed destination changed outside agentweave",
      });
      continue;
    }

    if (currentHash === op.desiredHash) {
      operations.push({ ...op, action: "skip", currentHash, manifestHash: existing.hash, reason: "already up to date" });
    } else {
      operations.push({ ...op, action: "update", currentHash, manifestHash: existing.hash, reason: "source changed" });
    }
  }

  for (const entry of manifest?.entries ?? []) {
    if (desired.has(entry.path)) continue;
    const destPath = join(targetRoot, entry.path);
    if (!(await pathExists(destPath))) continue;
    const currentHash = await hashPath(destPath);
    if (currentHash !== entry.hash) {
      operations.push({
        action: "drift",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        currentHash,
        manifestHash: entry.hash,
        reason: "managed stale destination changed outside agentweave",
        channel: entry.channel,
        packageName: entry.packageName,
      });
    } else {
      operations.push({
        action: "remove",
        artifactType: entry.artifactType,
        artifactName: entry.artifactName,
        kind: entry.kind,
        destPath,
        relativeDestPath: entry.path,
        currentHash,
        manifestHash: entry.hash,
        reason: "artifact removed from source",
        channel: entry.channel,
        packageName: entry.packageName,
      });
    }
  }

  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: adapter.name,
    targetRoot,
    operations,
    hasBlockingChanges: operations.some((op) => op.action === "drift" || op.action === "conflict"),
  };
}

function operationForArtifact(artifact: Artifact, adapter: AdapterConfig, targetRoot: string): InstallOperation | undefined {
  const target = adapter.targets[artifact.type];
  if (!target?.enabled) return undefined;

  const destPath = artifact.type === "instructions"
    ? join(targetRoot, target.dest)
    : join(targetRoot, target.dest, artifact.name);

  return {
    action: "create",
    artifactType: artifact.type,
    artifactName: artifact.name,
    kind: artifact.kind,
    sourcePath: artifact.stagedPath ?? artifact.sourcePath,
    destPath,
    relativeDestPath: relative(targetRoot, destPath).replaceAll("\\", "/"),
    desiredHash: artifact.hash,
    reason: "destination missing",
    channel: artifact.channel ?? "managed",
    packageName: artifact.packageName,
  };
}

export function summarizePlan(plan: InstallPlan): Record<PlanAction, number> {
  const summary: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    remove: 0,
    drift: 0,
    conflict: 0,
  };
  for (const operation of plan.operations) {
    summary[operation.action]++;
  }
  return summary;
}
