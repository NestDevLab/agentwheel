import { rm } from "node:fs/promises";
import { resolveAdapter } from "../adapters/resolve.js";
import { defaultInstallationType, installRootForAdapterInstallationType, resolveInstallationTypeForAdapter } from "../model/adapter.js";
import { applyCombinedInstallPlan } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { createGraphSourcePlan, type GraphSourcePlanResult } from "./source-plan.js";
import { isCompositeWorkspaceProfile, readMergedWorkspaceConfig, type WorkspacePackage } from "../model/workspace.js";
import { resolvePackageSource, selectorsFromRegistryEntry } from "../registry/client.js";
import { formatReloadCommands, reloadRuntimeAfterPluginChanges } from "../runtime/reload.js";
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
  reloadRuntimes?: boolean;
  allowAdapterCode?: boolean;
  forceDrift?: boolean;
  forceConflict?: boolean;
  replaceConflict?: boolean;
  noDeps?: boolean;
  includeSuggestions?: boolean;
  suggestionAliases?: string[];
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
  graphPlan: GraphSourcePlanResult;
  graphLockDigest: string;
  warnings: string[];
  reloaded?: boolean;
  reloadCommandSummary?: string;
}

export async function syncProfile(options: ProfileSyncOptions): Promise<ProfileSyncResult[]> {
  const config = await readMergedWorkspaceConfig(options.workspaceRoot);
  const profile = config.profiles[options.profile];
  if (!profile) {
    throw new Error(`Unknown profile: ${options.profile}`);
  }
  if (isCompositeWorkspaceProfile(profile)) {
    throw new Error(`Composite profile '${options.profile}' must be executed through member delegation.`);
  }

  const packages = options.source
    ? [await packageFromSource(options.source, options)]
    : config.packages;
  if (packages.length === 0) {
    throw new Error("Profile sync needs a source argument or configured packages.");
  }

  const results: ProfileSyncResult[] = [];
  const selected = normalizeArtifactSelectors(options.select, options.skills);
  if (selected && packages.some((pkg) => pkg.selection)) {
    throw new Error("--select/--skill cannot be combined with a package selection import.");
  }
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
    const graphPlan = await createGraphSourcePlan({
      roots: packages.map((pkg) => ({
        rootId: pkg.name,
        source: pkg.source,
        mode: options.mode ?? pkg.mode,
        version: pkg.version,
        ref: pkg.requestedRef,
        select: pkg.selection ? undefined : selected ?? normalizeArtifactSelectors(pkg.select, pkg.skills),
        selection: pkg.selection,
        aliases: pkg.aliases,
        overrides: pkg.overrides,
        includeSuggestions: options.includeSuggestions === true || pkg.withSuggestions === true,
        suggestionAliases: combinedSuggestionAliases(pkg.suggestions, options.suggestionAliases),
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
      includeSuggestions: options.includeSuggestions,
      suggestionAliases: options.suggestionAliases,
      lockedResolution: options.lockedResolution,
      frozenLock: options.frozenLock,
      offline: options.offline,
      yes: options.yes,
      trustPatterns: options.trustPatterns ?? [],
      readOnly: options.readOnly,
      isTTY: options.isTTY,
      warn: options.warn,
      forceDrift: options.forceDrift,
      forceConflict: options.forceConflict,
      replaceConflict: options.replaceConflict,
    });
    try {
      const result: ProfileSyncResult = {
        runtime: adapter.name,
        targetRoot: installRootForAdapterInstallationType(adapter, target.targetRoot, installationType, transport.kind === "ssh"),
        transport: transport.kind,
        packageName: packages.map((pkg) => pkg.name).join(","),
        plan: graphPlan.plan,
        graphPlan,
        graphLockDigest: graphPlan.graphLockDigest,
        warnings: graphPlan.warnings,
      };
      if (!options.dryRun) {
        const executePlugins = runtime.executePlugins ?? options.executePlugins;
        await applyCombinedInstallPlan(graphPlan.plan, {
          executePlugins,
          transport,
          graphLockDigest: graphPlan.graphLockDigest,
          graphLock: { path: graphPlan.graphLockPath, lock: graphPlan.bundle.graphLock },
        });
        result.reloaded = await reloadRuntimeAfterPluginChanges(graphPlan.plan, target, transport, {
          enabled: runtime.reloadRuntimes ?? options.reloadRuntimes,
          executePlugins,
        });
        result.reloadCommandSummary = result.reloaded ? formatReloadCommands(target.reloadCommands) : undefined;
      }
      results.push(result);
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
  const selectedArtifacts = normalizeArtifactSelectors(options.select, options.skills) ?? selectorsFromRegistryEntry(resolved.registryEntry);
  return {
    name: resolved.registryEntry?.name ?? source,
    source: resolved.source,
    driver: driver as WorkspacePackage["driver"],
    adapter: "openclaw",
    installationType: options.installationType,
    mode: options.mode ?? "pinned",
    select: selectedArtifacts,
    withSuggestions: options.includeSuggestions === true ? true : undefined,
    suggestions: options.suggestionAliases,
  };
}

function combinedSuggestionAliases(packageAliases: string[] | undefined, optionAliases: string[] | undefined): string[] | undefined {
  const aliases = [...(packageAliases ?? []), ...(optionAliases ?? [])].map((item) => item.trim()).filter(Boolean);
  return aliases.length > 0 ? [...new Set(aliases)].sort((a, b) => a.localeCompare(b)) : undefined;
}
