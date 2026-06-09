import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import { createInstallPlan, readInstallManifest } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { resolvePackageSource } from "../registry/client.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource, type StagedBundle } from "../staging/staging.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";

export interface SourcePlanOptions {
  source: string;
  targetRoot: string;
  workspaceRoot?: string;
  adapter: AdapterConfig;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skills?: string[];
  transport?: TargetTransport;
}

export interface SourcePlanResult {
  plan: InstallPlan;
  bundle: StagedBundle;
  resolvedSource: string;
  registryEntryName?: string;
}

export async function createSourcePlan(options: SourcePlanOptions): Promise<SourcePlanResult> {
  const workspaceRoot = options.workspaceRoot ?? options.targetRoot;
  const resolvedInput = await resolvePackageSource(options.source, workspaceRoot);
  const resolvedSource = resolvedInput.source;
  const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedSource));
  const bundle = await stageSource(driver, resolvedSource, {
    workspaceRoot,
    adapter: options.adapter,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: options.mode,
    select: options.select,
    skills: options.skills,
  });
  const transport = options.transport ?? localTransport;
  const manifest = await readInstallManifest(options.targetRoot, options.adapter.name, transport);
  const plan = await createInstallPlan(bundle, options.adapter, options.targetRoot, manifest, transport);
  return { plan, bundle, resolvedSource, registryEntryName: resolvedInput.registryEntry?.name };
}
