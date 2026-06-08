import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { InstallManifest, InstallManifestEntry, SourceLock } from "../model/manifest.js";
import { atomicCopy, hashPath } from "../utils/fs.js";
import { mergeJsonFile } from "./json-merge.js";
import { removeStateFiles, writeInstallManifest, writeSourceLock } from "./manifest.js";
import type { InstallPlan } from "./plan.js";
import { mergeCodexTomlMcp } from "./toml-merge.js";

const execFileAsync = promisify(execFile);

export interface ApplyOptions {
  executePlugins?: boolean;
}

export interface UninstallOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface UninstallResult {
  removed: number;
  kept: number;
  removedDrifted: number;
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
      } else if (operation.mergeStrategy === "codex-toml-mcp") {
        await mergeCodexTomlMcp(operation.sourcePath, operation.destPath);
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
        hash: operation.mergeStrategy && operation.currentHash ? operation.currentHash : operation.desiredHash,
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

export async function uninstall(plan: InstallPlan, options: UninstallOptions | boolean = {}): Promise<UninstallResult> {
  const resolvedOptions = typeof options === "boolean" ? { dryRun: options } : options;
  if (plan.hasBlockingChanges) {
    const blockers = plan.operations.filter((operation) => operation.action === "conflict");
    throw new Error(`Refusing to uninstall with blocking changes: ${blockers.map((item) => item.relativeDestPath).join(", ")}`);
  }
  const removable = plan.operations.filter((operation) => operation.action === "remove" || (resolvedOptions.force && operation.action === "keep"));
  const kept = resolvedOptions.force ? [] : plan.operations.filter((operation) => operation.action === "keep");
  const skipped = plan.operations.filter((operation) => operation.action === "skip");
  const removedDrifted = resolvedOptions.force ? plan.operations.filter((operation) => operation.action === "keep").length : 0;
  if (resolvedOptions.dryRun) return { removed: removable.length, kept: kept.length, removedDrifted };
  for (const operation of plan.operations) {
    if (operation.action === "remove" || (resolvedOptions.force && operation.action === "keep")) {
      await rm(operation.destPath, { recursive: true, force: true });
    }
  }
  const preserved = [...kept, ...skipped];
  if (preserved.length > 0) {
    const now = new Date().toISOString();
    await writeInstallManifest({
      version: 1,
      adapter: plan.adapter,
      targetRoot: plan.targetRoot,
      generatedAt: now,
      adapterCode: plan.adapterCode,
      entries: preserved.map((operation) => {
        if (!operation.manifestHash || !operation.desiredHash) {
          throw new Error(`Invalid preserved operation missing manifest/source hash: ${operation.relativeDestPath}`);
        }
        return {
          path: operation.relativeDestPath,
          artifactType: operation.artifactType,
          artifactName: operation.artifactName,
          kind: operation.kind,
          hash: operation.manifestHash,
          sourceHash: operation.desiredHash,
          updatedAt: now,
          channel: operation.channel,
          packageName: operation.packageName,
          semanticCommand: operation.semanticCommand,
          mergeStrategy: operation.mergeStrategy,
        };
      }).sort((a, b) => a.path.localeCompare(b.path)),
    });
  } else {
    await removeStateFiles(plan.targetRoot, plan.adapter);
  }
  return { removed: removable.length, kept: kept.length, removedDrifted };
}
