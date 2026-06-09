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
import { localTransport, transportForTarget } from "../transport/index.js";
import type { SshTransportConfig, TargetTransport, TransportKind } from "../transport/index.js";

export interface ProfileSyncOptions {
  workspaceRoot: string;
  profile: string;
  source?: string;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skills?: string[];
  dryRun?: boolean;
  executePlugins?: boolean;
  allowAdapterCode?: boolean;
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
        select: options.select ?? pkg.select,
        skills: options.select ? undefined : pkg.skills,
      });
      try {
        const manifest = await readInstallManifest(target.targetRoot, adapter.name, target.transport);
        const plan = await createInstallPlan(bundle, adapter, target.targetRoot, manifest, target.transport);
        results.push({ runtime: adapter.name, targetRoot: target.targetRoot, transport: target.transport.kind, packageName: pkg.name, plan });
        if (!options.dryRun) {
          await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: runtime.executePlugins ?? options.executePlugins, transport: target.transport });
        }
      } finally {
        await rm(bundle.root, { recursive: true, force: true });
      }
    }
  }
  return results;
}

function resolveProfileRuntime(
  runtime: WorkspaceProfileRuntime,
  config: Awaited<ReturnType<typeof readMergedWorkspaceConfig>>,
  workspaceRoot: string,
): { adapter: string; targetRoot: string; transport: TargetTransport } {
  if (runtime.agent) {
    const agent = config.agents[runtime.agent];
    if (!agent) throw new Error(`Unknown agent in profile: ${runtime.agent}`);
    const target = {
      agentName: runtime.agent,
      adapter: agent.adapter,
      targetRoot: agent.transport === "ssh" ? agent.root : resolveConfigPath(agent.root, workspaceRoot),
      workspaceRoot,
      transport: agent.transport,
      ssh: agent.transport === "ssh"
        ? {
            host: agent.host ?? "",
            user: agent.user,
            port: agent.port,
            identityFile: agent.identityFile ? resolveConfigPath(agent.identityFile, workspaceRoot) : undefined,
          } satisfies SshTransportConfig
        : undefined,
      source: "agent" as const,
    };
    return { adapter: target.adapter, targetRoot: target.targetRoot, transport: transportForTarget(target) };
  }
  return {
    adapter: runtime.adapter,
    targetRoot: runtime.targetRoot ? resolveConfigPath(runtime.targetRoot, workspaceRoot) : workspaceRoot,
    transport: localTransport,
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
    select: options.select,
    skills: options.skills,
  };
}
