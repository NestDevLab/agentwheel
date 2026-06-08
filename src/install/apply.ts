import { rm } from "node:fs/promises";
import type { InstallManifest, InstallManifestEntry, SourceLock } from "../model/manifest.js";
import { atomicCopy, hashPath } from "../utils/fs.js";
import { removeStateFiles, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallPlan } from "./plan.js";

export async function applyInstallPlan(plan: InstallPlan, sourceLock: SourceLock): Promise<InstallManifest> {
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "drift" || operation.action === "conflict");
    throw new Error(`Refusing to apply with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }

  const entries: InstallManifestEntry[] = [];
  const now = new Date().toISOString();

  for (const operation of plan.operations) {
    if (operation.action === "create" || operation.action === "update") {
      if (!operation.sourcePath || !operation.desiredHash) {
        throw new Error(`Invalid operation missing source/hash: ${operation.relativeDestPath}`);
      }
      await atomicCopy(operation.sourcePath, operation.destPath, operation.kind);
      entries.push({
        path: operation.relativeDestPath,
        artifactType: operation.artifactType,
        artifactName: operation.artifactName,
        kind: operation.kind,
        hash: await hashPath(operation.destPath),
        sourceHash: operation.desiredHash,
        updatedAt: now,
      });
    } else if (operation.action === "skip") {
      if (!operation.desiredHash) {
        throw new Error(`Invalid skip operation missing hash: ${operation.relativeDestPath}`);
      }
      entries.push({
        path: operation.relativeDestPath,
        artifactType: operation.artifactType,
        artifactName: operation.artifactName,
        kind: operation.kind,
        hash: operation.desiredHash,
        sourceHash: operation.desiredHash,
        updatedAt: now,
      });
    } else if (operation.action === "remove") {
      await rm(operation.destPath, { recursive: true, force: true });
    }
  }

  const manifest: InstallManifest = {
    version: 1,
    adapter: plan.adapter,
    targetRoot: plan.targetRoot,
    generatedAt: now,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeInstallManifest(manifest);
  await writeSourceLock(plan.targetRoot, plan.adapter, sourceLock);
  return manifest;
}

export async function uninstall(plan: InstallPlan, dryRun: boolean): Promise<void> {
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "drift" || operation.action === "conflict");
    throw new Error(`Refusing to uninstall with drift: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }
  if (dryRun) return;
  for (const operation of plan.operations) {
    await rm(operation.destPath, { recursive: true, force: true });
  }
  await removeStateFiles(plan.targetRoot, plan.adapter);
}

