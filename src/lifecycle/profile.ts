import { rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveAdapter } from "../adapters/resolve.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { readMergedWorkspaceConfig, resolveConfigPath, type WorkspacePackage, type WorkspaceProfileRuntime } from "../model/workspace.js";
import { resolvePackageSource } from "../registry/client.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource } from "../staging/staging.js";

export interface ProfileSyncOptions {
  workspaceRoot: string;
  profile: string;
  source?: string;
  driver?: string;
  mode?: "pinned" | "tracking";
  dryRun?: boolean;
  executePlugins?: boolean;
  allowAdapterCode?: boolean;
  warn?: (message: string) => void;
}

export interface ProfileSyncResult {
  runtime: string;
  targetRoot: string;
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
  for (const pkg of packages) {
    for (const runtime of profile.runtimes) {
      const target = resolveProfileRuntime(runtime, config, options.workspaceRoot);
      const adapter = await resolveAdapter({
        adapter: target.adapter,
        adapterConfig: runtime.adapterConfig,
        adapterModule: runtime.adapterModule,
        allowAdapterCode: options.allowAdapterCode,
        baseDir: options.workspaceRoot,
        warn: options.warn,
      });
      const driver = getSourceDriver(pkg.driver);
      const bundle = await stageSource(driver, pkg.source, {
        workspaceRoot: options.workspaceRoot,
        adapter,
        cacheRoot: join(options.workspaceRoot, ".agentwheel", "cache"),
        mode: options.mode ?? pkg.mode,
      });
      try {
        const plan = await createInstallPlan(bundle, adapter, target.targetRoot, await readInstallManifest(target.targetRoot, adapter.name));
        results.push({ runtime: adapter.name, targetRoot: target.targetRoot, packageName: pkg.name, plan });
        if (!options.dryRun) {
          await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: runtime.executePlugins ?? options.executePlugins });
        }
      } finally {
        await rm(bundle.root, { recursive: true, force: true });
      }
    }
  }
  return results;
}

function resolveProfileRuntime(runtime: WorkspaceProfileRuntime, config: Awaited<ReturnType<typeof readMergedWorkspaceConfig>>, workspaceRoot: string): { adapter: string; targetRoot: string } {
  if (runtime.agent) {
    const agent = config.agents[runtime.agent];
    if (!agent) throw new Error(`Unknown agent in profile: ${runtime.agent}`);
    return { adapter: agent.adapter, targetRoot: resolveConfigPath(agent.root, workspaceRoot) };
  }
  return {
    adapter: runtime.adapter,
    targetRoot: runtime.targetRoot ? resolveConfigPath(runtime.targetRoot, workspaceRoot) : workspaceRoot,
  };
}

async function packageFromSource(source: string, options: ProfileSyncOptions): Promise<WorkspacePackage> {
  const resolved = await resolvePackageSource(source, options.workspaceRoot);
  const driver = options.driver ?? inferSourceDriverName(resolved.source);
  return {
    name: resolved.registryEntry?.name ?? source,
    source: resolved.source,
    driver: driver as WorkspacePackage["driver"],
    adapter: "openclaw",
    mode: options.mode ?? "pinned",
  };
}
