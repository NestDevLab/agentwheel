import { rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveAdapter } from "../adapters/resolve.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { readWorkspaceConfig, type WorkspacePackage } from "../model/workspace.js";
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
  packageName: string;
  plan: InstallPlan;
}

export async function syncProfile(options: ProfileSyncOptions): Promise<ProfileSyncResult[]> {
  const config = await readWorkspaceConfig(options.workspaceRoot);
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
      const targetRoot = runtime.targetRoot ?? options.workspaceRoot;
      const adapter = await resolveAdapter({
        adapter: runtime.adapter,
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
        const plan = await createInstallPlan(bundle, adapter, targetRoot, await readInstallManifest(targetRoot, adapter.name));
        results.push({ runtime: adapter.name, packageName: pkg.name, plan });
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
