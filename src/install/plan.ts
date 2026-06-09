import { join, relative } from "node:path";
import type { AdapterConfig, ProgrammaticAdapterApply, ProgrammaticAdapterOperation, ProgrammaticAdapterUninstall } from "../model/adapter.js";
import type { Artifact, ArtifactType, FileKind } from "../model/artifact.js";
import type { InstallManifest } from "../model/manifest.js";
import type { StagedBundle } from "../staging/staging.js";
import { openClawPluginInstallCommand } from "../targets/plugins/openclaw.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";

export type PlanAction = "create" | "update" | "skip" | "remove" | "keep" | "drift" | "conflict" | "plugin" | "program";
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
  semanticCommand?: string[];
  execute?: boolean;
  mergeStrategy?: "json-deep" | "codex-toml-mcp";
  programmaticOperation?: ProgrammaticAdapterOperation;
  programmaticApply?: ProgrammaticAdapterApply;
}

export interface InstallPlan {
  adapter: string;
  targetRoot: string;
  operations: InstallOperation[];
  hasBlockingChanges: boolean;
  adapterCode?: {
    modulePath: string;
    hash: string;
  };
  programmaticApply?: ProgrammaticAdapterApply;
  programmaticUninstall?: ProgrammaticAdapterUninstall;
}

export async function createInstallPlan(
  bundle: StagedBundle,
  adapter: AdapterConfig,
  targetRoot: string,
  manifest?: InstallManifest,
  transport: TargetTransport = localTransport,
): Promise<InstallPlan> {
  const desired = new Map<string, InstallOperation>();

  for (const artifact of bundle.artifacts) {
    const op = operationForArtifact(artifact, adapter, targetRoot);
    if (op) {
      desired.set(op.relativeDestPath, op);
    }
  }

  if (adapter.programmatic?.plan) {
    for (const op of await adapter.programmatic.plan({ targetRoot, adapterName: adapter.name })) {
      desired.set(`programmatic/${op.name}`, {
        action: "program",
        artifactType: "settings",
        artifactName: op.name,
        kind: "file",
        destPath: targetRoot,
        relativeDestPath: `programmatic/${op.name}`,
        desiredHash: adapter.programmatic.hash,
        reason: op.reason ?? "programmatic adapter operation planned",
        channel: "managed",
        programmaticOperation: op,
        programmaticApply: adapter.programmatic.apply,
      });
    }
  }

  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const operations: InstallOperation[] = [];

  for (const op of desired.values()) {
    if (op.action === "plugin") {
      const existing = manifestByPath.get(op.relativeDestPath);
      if (existing && existing.hash === op.desiredHash) {
        operations.push({ ...op, action: "skip", manifestHash: existing.hash, reason: "plugin already planned" });
      } else {
        operations.push(op);
      }
      continue;
    }

    if (op.action === "program") {
      const existing = manifestByPath.get(op.relativeDestPath);
      if (existing && existing.hash === op.desiredHash) {
        operations.push({ ...op, action: "skip", manifestHash: existing.hash, reason: "programmatic operation already applied" });
      } else {
        operations.push(op);
      }
      continue;
    }

    if (op.mergeStrategy) {
      const existing = manifestByPath.get(op.relativeDestPath);
      const exists = await transport.pathExists(op.destPath);
      if (!exists) {
        operations.push({ ...op, action: "create", reason: "merge destination missing" });
        continue;
      }
      const currentHash = await transport.hashPath(op.destPath);
      if (existing && existing.sourceHash === op.desiredHash) {
        operations.push({ ...op, action: "skip", currentHash, manifestHash: existing.hash, reason: "merged source already up to date" });
      } else {
        operations.push({ ...op, action: "update", currentHash, manifestHash: existing?.hash, reason: existing ? "merge source changed" : "merge into existing JSON" });
      }
      continue;
    }

    const existing = manifestByPath.get(op.relativeDestPath);
    const exists = await transport.pathExists(op.destPath);
    if (!exists) {
      operations.push({ ...op, action: "create", reason: "destination missing" });
      continue;
    }

    const currentHash = await transport.hashPath(op.destPath);
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
        reason: "managed destination changed outside agentwheel",
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
    if (!(await transport.pathExists(destPath))) continue;
    const currentHash = await transport.hashPath(destPath);
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
        reason: "managed stale destination changed outside agentwheel",
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
    adapterCode: adapter.programmatic ? { modulePath: adapter.programmatic.modulePath, hash: adapter.programmatic.hash } : undefined,
    programmaticApply: adapter.programmatic?.apply,
    programmaticUninstall: adapter.programmatic?.uninstall,
  };
}

function operationForArtifact(artifact: Artifact, adapter: AdapterConfig, targetRoot: string): InstallOperation | undefined {
  const target = adapter.targets[artifact.type];
  if (!target?.enabled) return undefined;

  if (artifact.type === "plugins" && target.semantic === "openclaw-plugin") {
    const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
    return {
      action: "plugin",
      artifactType: artifact.type,
      artifactName: artifact.name,
      kind: artifact.kind,
      sourcePath,
      destPath: targetRoot,
      relativeDestPath: `plugins/${artifact.name}`,
      desiredHash: artifact.hash,
      reason: "semantic plugin install planned",
      channel: artifact.channel ?? "managed",
      packageName: artifact.packageName,
      semanticCommand: openClawPluginInstallCommand({ path: sourcePath, dryRun: true }),
    };
  }

  const destPath = artifact.type === "instructions" || artifact.type === "settings" || isFileTarget(target.dest)
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
    mergeStrategy: target.merge,
  };
}

function isFileTarget(dest: string): boolean {
  return /\.(json|jsonc|toml|md)$/i.test(dest);
}

export function summarizePlan(plan: InstallPlan): Record<PlanAction, number> {
  const summary: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    remove: 0,
    keep: 0,
    drift: 0,
    conflict: 0,
    plugin: 0,
    program: 0,
  };
  for (const operation of plan.operations) {
    summary[operation.action]++;
  }
  return summary;
}
