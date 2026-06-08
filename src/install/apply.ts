import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { InstallManifest, InstallManifestEntry, SourceLock } from "../model/manifest.js";
import { atomicCopy, hashPath } from "../utils/fs.js";
import { mergeJsonFile } from "./json-merge.js";
import { removeStateFiles, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallPlan } from "./plan.js";

const execFileAsync = promisify(execFile);

export interface ApplyOptions {
  executePlugins?: boolean;
}

export async function applyInstallPlan(plan: InstallPlan, sourceLock: SourceLock, options: ApplyOptions = {}): Promise<InstallManifest> {
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "drift" || operation.action === "conflict");
    throw new Error(`Refusing to apply with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }

  const entries: InstallManifestEntry[] = [];
  const now = new Date().toISOString();

  for (const operation of plan.operations) {
    if (operation.action === "plugin") {
      if (!operation.desiredHash) {
        throw new Error(`Invalid plugin operation missing hash: ${operation.relativeDestPath}`);
      }
      if (options.executePlugins) {
        if (!operation.semanticCommand || operation.semanticCommand.length === 0) {
          throw new Error(`Invalid plugin operation missing command: ${operation.relativeDestPath}`);
        }
        const command = operation.semanticCommand[0];
        const args = operation.semanticCommand.slice(1);
        if (!command) {
          throw new Error(`Invalid plugin operation missing command: ${operation.relativeDestPath}`);
        }
        await execFileAsync(command, args);
      }
      entries.push({
        path: operation.relativeDestPath,
        artifactType: operation.artifactType,
        artifactName: operation.artifactName,
        kind: operation.kind,
        hash: operation.desiredHash,
        sourceHash: operation.desiredHash,
        updatedAt: now,
        channel: operation.channel,
        packageName: operation.packageName,
        semanticCommand: operation.semanticCommand,
        executed: options.executePlugins === true,
      });
    } else if (operation.action === "program") {
      if (!plan.adapterCode || !operation.desiredHash || !operation.programmaticOperation) {
        throw new Error(`Invalid programmatic operation: ${operation.relativeDestPath}`);
      }
      if (operation.programmaticApply) {
        await operation.programmaticApply(operation.programmaticOperation, {
          targetRoot: plan.targetRoot,
          adapterName: plan.adapter,
        });
      }
      entries.push({
        path: operation.relativeDestPath,
        artifactType: operation.artifactType,
        artifactName: operation.artifactName,
        kind: operation.kind,
        hash: operation.desiredHash,
        sourceHash: operation.desiredHash,
        updatedAt: now,
        channel: operation.channel,
        packageName: operation.packageName,
      });
    } else if (operation.action === "create" || operation.action === "update") {
      if (!operation.sourcePath || !operation.desiredHash) {
        throw new Error(`Invalid operation missing source/hash: ${operation.relativeDestPath}`);
      }
      if (operation.mergeStrategy === "json-deep") {
        await mergeJsonFile(operation.sourcePath, operation.destPath);
      } else {
        await atomicCopy(operation.sourcePath, operation.destPath, operation.kind);
      }
      entries.push({
        path: operation.relativeDestPath,
        artifactType: operation.artifactType,
        artifactName: operation.artifactName,
        kind: operation.kind,
        hash: await hashPath(operation.destPath),
        sourceHash: operation.desiredHash,
        updatedAt: now,
        channel: operation.channel,
        packageName: operation.packageName,
        semanticCommand: operation.semanticCommand,
        mergeStrategy: operation.mergeStrategy,
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
        hash: operation.mergeStrategy === "json-deep" && operation.currentHash ? operation.currentHash : operation.desiredHash,
        sourceHash: operation.desiredHash,
        updatedAt: now,
        channel: operation.channel,
        packageName: operation.packageName,
        semanticCommand: operation.semanticCommand,
        mergeStrategy: operation.mergeStrategy,
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
    adapterCode: plan.adapterCode,
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
