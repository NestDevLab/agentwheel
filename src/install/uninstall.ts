import { join } from "node:path";
import type { InstallManifest } from "../model/manifest.js";
import { hashPath, pathExists } from "../utils/fs.js";
import type { InstallOperation, InstallPlan } from "./plan.js";

export async function createUninstallPlan(manifest: InstallManifest): Promise<InstallPlan> {
  const operations: InstallOperation[] = [];
  for (const entry of manifest.entries) {
    const destPath = join(manifest.targetRoot, entry.path);
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
        reason: "managed destination changed outside agentweave",
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
        reason: "uninstall managed artifact",
        channel: entry.channel,
        packageName: entry.packageName,
      });
    }
  }
  operations.sort((a, b) => a.relativeDestPath.localeCompare(b.relativeDestPath));
  return {
    adapter: manifest.adapter,
    targetRoot: manifest.targetRoot,
    operations,
    hasBlockingChanges: operations.some((operation) => operation.action === "drift" || operation.action === "conflict"),
  };
}
