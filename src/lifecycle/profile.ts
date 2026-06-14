import { rm } from "node:fs/promises";
import { resolveAdapter } from "../adapters/resolve.js";
import { applyCombinedInstallPlan } from "../install/index.js";
import type { InstallPlan } from "../install/plan.js";
import { createGraphSourcePlan } from "./source-plan.js";
import { readMergedWorkspaceConfig, resolveConfigPath, type WorkspacePackage, type WorkspaceProfileRuntime, type WorkspaceRestart } from "../model/workspace.js";
import { resolvePackageSource } from "../registry/client.js";
import { inferSourceDriverName } from "../source/identify.js";
import { localTransport, transportForTarget } from "../transport/index.js";
import type { SshTransportConfig, TargetTransport, TransportKind } from "../transport/index.js";
import { normalizeArtifactSelectors } from "../model/selection.js";
import { restartAdviceForPlan, type RuntimeRestartAdvice } from "../runtime/restart.js";
import type { RuntimeTarget } from "../runtime/target.js";

interface ResolvedProfileRuntime {
  adapter: string;
  targetRoot: string;
  workspaceRoot: string;
  agentName?: string;
  transport: TargetTransport;
  ssh?: SshTransportConfig;
  restart?: WorkspaceRestart;
}

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
  restartAdvice?: RuntimeRestartAdvice;
  restartTarget: Pick<RuntimeTarget, "transport" | "ssh">;
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
    const target = resolveProfileRuntime(runtime, config, options.workspaceRoot);
    const adapter = await resolveAdapter({
      adapter: target.adapter,
      adapterConfig: runtime.adapterConfig,
      adapterModule: runtime.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
      baseDir: options.workspaceRoot,
      warn: options.warn,
    });
    const selected = normalizeArtifactSelectors(options.select, options.skills);
    const graphPlan = await createGraphSourcePlan({
      roots: packages.map((pkg) => ({
        rootId: pkg.name,
        source: pkg.source,
        mode: options.mode ?? pkg.mode,
        ref: pkg.requestedRef,
        select: selected ?? normalizeArtifactSelectors(pkg.select, pkg.skills),
        aliases: pkg.aliases,
      })),
      targetRoot: target.targetRoot,
      workspaceRoot: options.workspaceRoot,
      adapter,
      transport: target.transport,
      targetKey: runtime.agent ?? adapter.name,
      targetFingerprintParts: {
        adapter: adapter.name,
        adapterConfig: runtime.adapterConfig,
        adapterModule: runtime.adapterModule,
        adapterCodeHash: adapter.programmatic?.hash,
        targetRoot: target.targetRoot,
        transport: target.transport.kind,
      },
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
        targetRoot: target.targetRoot,
        transport: target.transport.kind,
        packageName: packages.map((pkg) => pkg.name).join(","),
        plan: graphPlan.plan,
        restartAdvice: restartAdviceForPlan(graphPlan.plan, {
          adapter: target.adapter,
          agentName: target.agentName,
          targetRoot: target.targetRoot,
          transport: target.transport.kind,
          ssh: target.ssh,
          restart: target.restart,
        }),
        restartTarget: { transport: target.transport.kind, ssh: target.ssh },
      });
      if (!options.dryRun) {
        await applyCombinedInstallPlan(graphPlan.plan, {
          executePlugins: runtime.executePlugins ?? options.executePlugins,
          transport: target.transport,
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

function resolveProfileRuntime(
  runtime: WorkspaceProfileRuntime,
  config: Awaited<ReturnType<typeof readMergedWorkspaceConfig>>,
  workspaceRoot: string,
): ResolvedProfileRuntime {
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
      restart: runtime.restart ?? agent.restart,
      source: "agent" as const,
    };
    return { ...target, transport: transportForTarget(target) };
  }
  const targetRoot = runtime.targetRoot ? resolveConfigPath(runtime.targetRoot, workspaceRoot) : workspaceRoot;
  return {
    adapter: runtime.adapter,
    targetRoot,
    workspaceRoot,
    restart: runtime.restart,
    transport: localTransport,
  };
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
    mode: options.mode ?? "pinned",
    select: options.select,
    skills: options.skills,
  };
}
