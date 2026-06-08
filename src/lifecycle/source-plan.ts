import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import { createInstallPlan, readInstallManifest } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { resolvePackageSource } from "../registry/client.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource, type StagedBundle } from "../staging/staging.js";

export interface SourcePlanOptions {
  source: string;
  targetRoot: string;
  adapter: AdapterConfig;
  driver?: string;
  mode?: "pinned" | "tracking";
}

export interface SourcePlanResult {
  plan: InstallPlan;
  bundle: StagedBundle;
  resolvedSource: string;
  registryEntryName?: string;
}

export async function createSourcePlan(options: SourcePlanOptions): Promise<SourcePlanResult> {
  const resolvedInput = await resolvePackageSource(options.source, options.targetRoot);
  const resolvedSource = resolvedInput.source;
  const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedSource));
  const bundle = await stageSource(driver, resolvedSource, {
    workspaceRoot: options.targetRoot,
    adapter: options.adapter,
    cacheRoot: join(options.targetRoot, ".agentwheel", "cache"),
    mode: options.mode,
  });
  const manifest = await readInstallManifest(options.targetRoot, options.adapter.name);
  const plan = await createInstallPlan(bundle, options.adapter, options.targetRoot, manifest);
  return { plan, bundle, resolvedSource, registryEntryName: resolvedInput.registryEntry?.name };
}
