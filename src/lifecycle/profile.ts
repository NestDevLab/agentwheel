import { rm } from "node:fs/promises";
import { resolveAdapter } from "../adapters/resolve.js";
import { defaultInstallationType, installRootForAdapterInstallationType, resolveInstallationTypeForAdapter } from "../model/adapter.js";
import { applyCombinedInstallPlan } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { createGraphSourcePlan } from "./source-plan.js";
import { readMergedWorkspaceConfig, type WorkspacePackage } from "../model/workspace.js";
import { resolvePackageSource } from "../registry/client.js";
import { resolveProfileRuntimeTarget } from "../runtime/target.js";
import { inferSourceDriverName } from "../source/identify.js";
import { transportForTarget } from "../transport/index.js";
import type { TransportKind } from "../transport/index.js";
import { normalizeArtifactSelectors } from "../model/selection.js";

export interface ProfileSyncOptions {
  workspaceRoot: string;
  profile: string;
  source?: string;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skills?: string[];
  installationType?: string;
  dryRun?: boolean;
  executePlugins?: boolean;
  allowAdapterCode?: boolean;
  noDeps?: boolean;
  lockedResolution?: boolean;
  frozenLock?: boolean;
  offline?: boolean;
  yes?: boolean;
  trustPatterns?: string[];
  readOnly?: boolean;
  isTTY?: boolean;
  warn?: (message: string) => void;
}

export interface ProfileSyncResult {
  runtime: string;
  targetRoot: string;
  transport: TransportKind;
  packageName: string;
  plan: InstallPlan;
}

export async function syncProfile(options: ProfileSyncOptions): Promise<ProfileSyncResult[]> {
  const config = await readMergedWorkspaceConfig(options.workspaceRoot);
  const profile = config.profiles[options.profile];
  if (!profile) {
    throw new Error(`Unknown profile: ${options.profile}`);
  }

  const packages = options.source
    ? [await packageFromSource(options.source, options)]
    : config.packages;
  if (packages.length === 0) {
    throw new Error("Profile sync needs a source argument or configured packages.");
  }

  const results: ProfileSyncResult[] = [];
  for (const runtime of profile.runtimes) {
    const target = resolveProfileRuntimeTarget(runtime, config, options.workspaceRoot, options.installationType);
    const transport = transportForTarget(target);
    const adapter = await resolveAdapter({
      adapter: target.adapter,
      adapterConfig: target.adapterConfig,
      adapterModule: target.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
      baseDir: options.workspaceRoot,
      warn: options.warn,
    });
    const installationType = target.installationType ?? defaultInstallationType;
    resolveInstallationTypeForAdapter(adapter, installationType);
    const selected = normalizeArtifactSelectors(options.select, options.skills);
    const graphPlan = await createGraphSourcePlan({
      roots: packages.map((pkg) => ({
        rootId: pkg.name,
        source: pkg.source,
        mode: options.mode ?? pkg.mode,
        ref: pkg.requestedRef,
        select: selected ?? normalizeArtifactSelectors(pkg.select, pkg.skills),
        aliases: pkg.aliases,
        overrides: pkg.overrides,
      })),
      targetRoot: target.targetRoot,
      workspaceRoot: options.workspaceRoot,
      adapter,
      transport,
      targetKey: target.targetKey ?? target.agentName ?? adapter.name,
      targetFingerprintParts: {
        adapter: adapter.name,
        installationType,
        adapterConfig: target.adapterConfig,
        adapterModule: target.adapterModule,
        adapterCodeHash: adapter.programmatic?.hash,
        agentName: target.agentName,
        targetRoot: target.targetRoot,
        transport: transport.kind,
        ssh: target.ssh,
      },
      installationType,
      noDeps: options.noDeps,
      lockedResolution: options.lockedResolution,
      frozenLock: options.frozenLock,
      offline: options.offline,
      yes: options.yes,
      trustPatterns: options.trustPatterns ?? [],
      readOnly: options.readOnly,
      isTTY: options.isTTY,
      warn: options.warn,
    });
    try {
      results.push({
        runtime: adapter.name,
        targetRoot: installRootForAdapterInstallationType(adapter, target.targetRoot, installationType),
        transport: transport.kind,
        packageName: packages.map((pkg) => pkg.name).join(","),
        plan: graphPlan.plan,
      });
      if (!options.dryRun) {
        await applyCombinedInstallPlan(graphPlan.plan, {
          executePlugins: runtime.executePlugins ?? options.executePlugins,
          transport,
          graphLockDigest: graphPlan.graphLockDigest,
          graphLock: { path: graphPlan.graphLockPath, lock: graphPlan.bundle.graphLock },
        });
      }
    } finally {
      await rm(graphPlan.bundle.root, { recursive: true, force: true });
    }
  }
  return results;
}

async function packageFromSource(source: string, options: ProfileSyncOptions): Promise<WorkspacePackage> {
  const resolved = await resolvePackageSource(source, options.workspaceRoot, {
    offline: options.frozenLock === true || options.offline === true,
    warn: options.warn,
  });
  const driver = options.driver ?? inferSourceDriverName(resolved.source);
  return {
    name: resolved.registryEntry?.name ?? source,
    source: resolved.source,
    driver: driver as WorkspacePackage["driver"],
    adapter: "openclaw",
    installationType: options.installationType,
    mode: options.mode ?? "pinned",
    select: options.select,
    skills: options.skills,
  };
}
