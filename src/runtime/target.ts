import { basename, dirname, join, resolve } from "node:path";
import { findWorkspaceRoot, readMergedWorkspaceConfig, resolveConfigPath, type WorkspaceConfig } from "../model/workspace.js";
import type { SshTransportConfig, TransportKind } from "../transport/index.js";
import { pathExists } from "../utils/fs.js";

export interface RuntimeTarget {
  adapter: string;
  targetRoot: string;
  workspaceRoot: string;
  agentName?: string;
  transport: TransportKind;
  ssh?: SshTransportConfig;
  source: "target-root" | "agent" | "auto-detect" | "cwd";
}

export interface RuntimeTargetRequest {
  cwd?: string;
  targetRoot?: string;
  adapter?: string;
  agent?: string;
  all?: boolean;
  allDetected?: boolean;
  globalRoot?: string;
}

interface RuntimeMarker {
  adapter: string;
  dirs: string[];
}

const runtimeMarkers: RuntimeMarker[] = [
  { adapter: "openclaw", dirs: [".openclaw", ".clawdbot", ".moltbot"] },
  { adapter: "claude", dirs: [".claude"] },
  { adapter: "codex", dirs: [".codex"] },
  { adapter: "hermes", dirs: [".hermes"] },
  { adapter: "copilot", dirs: [".github"] },
];

export async function resolveRuntimeTarget(request: RuntimeTargetRequest = {}): Promise<RuntimeTarget> {
  const cwd = resolve(request.cwd ?? process.cwd());

  if (request.targetRoot) {
    const targetRoot = resolve(request.targetRoot);
    return {
      adapter: request.adapter ?? "openclaw",
      targetRoot,
      workspaceRoot: targetRoot,
      transport: "local",
      source: "target-root",
    };
  }

  const workspaceRoot = await findWorkspaceRoot(cwd);
  const config = await readMergedWorkspaceConfig(workspaceRoot, { globalRoot: request.globalRoot });

  if (request.agent) {
    return targetFromAgent(request.agent, config, workspaceRoot);
  }

  const detected = await detectRuntimeTarget(cwd, request.adapter);
  if (detected) {
    return { ...detected, workspaceRoot: await findWorkspaceRoot(detected.targetRoot), transport: "local", source: "auto-detect" };
  }

  return {
    adapter: request.adapter ?? "openclaw",
    targetRoot: cwd,
    workspaceRoot,
    transport: "local",
    source: "cwd",
  };
}

export async function resolveAllRuntimeTargets(request: RuntimeTargetRequest = {}): Promise<RuntimeTarget[]> {
  if (request.targetRoot) return [await resolveRuntimeTarget(request)];
  if (request.agent) return [await resolveRuntimeTarget(request)];

  const cwd = resolve(request.cwd ?? process.cwd());
  const workspaceRoot = await findWorkspaceRoot(cwd);
  const config = await readMergedWorkspaceConfig(workspaceRoot, { globalRoot: request.globalRoot });
  const targets = Object.entries(config.agents).map(([name]) => targetFromAgent(name, config, workspaceRoot));
  if (targets.length === 0) {
    throw new Error("No agents configured. Add agents to .agentwheel/config.json or pass --target-root.");
  }
  return targets;
}

export async function resolveAllDetectedRuntimeTargets(request: RuntimeTargetRequest = {}): Promise<RuntimeTarget[]> {
  if (request.agent) return [await resolveRuntimeTarget(request)];

  const scanRoot = runtimeScanRoot(request);
  const matches = await detectRuntimeTargets(scanRoot, request.adapter);
  if (matches.length === 0) {
    throw new Error(`No runtime directories detected at ${scanRoot}. Pass --target-root or --agent.`);
  }

  return Promise.all(matches.map(async (match) => ({
    ...match,
    workspaceRoot: await findWorkspaceRoot(match.targetRoot),
    transport: "local" as const,
    source: "auto-detect" as const,
  })));
}

export async function detectRuntimeTarget(cwd = process.cwd(), adapterFilter?: string): Promise<{ adapter: string; targetRoot: string } | undefined> {
  const unique = await detectRuntimeTargets(cwd, adapterFilter);
  if (unique.length > 1) {
    throw new Error(`Multiple runtime directories detected: ${unique.map((item) => `${item.adapter} at ${item.targetRoot}`).join(", ")}. Pass --adapter, --agent, or --all-detected.`);
  }
  return unique[0];
}

export async function detectRuntimeTargets(cwd = process.cwd(), adapterFilter?: string): Promise<Array<{ adapter: string; targetRoot: string }>> {
  const root = resolve(cwd);
  const matches: Array<{ adapter: string; targetRoot: string }> = [];

  for (const marker of runtimeMarkers) {
    if (adapterFilter && marker.adapter !== adapterFilter) continue;
    for (const dir of marker.dirs) {
      if (basename(root) === dir) {
        matches.push({ adapter: marker.adapter, targetRoot: dirname(root) });
      } else if (await pathExists(join(root, dir))) {
        matches.push({ adapter: marker.adapter, targetRoot: root });
      }
    }
  }

  return dedupeTargets(matches);
}

function targetFromAgent(name: string, config: WorkspaceConfig, workspaceRoot: string): RuntimeTarget {
  const agent = config.agents[name];
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }
  return {
    agentName: name,
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
        }
      : undefined,
    source: "agent",
  };
}

function dedupeTargets(matches: Array<{ adapter: string; targetRoot: string }>) {
  const byKey = new Map<string, { adapter: string; targetRoot: string }>();
  for (const match of matches) {
    byKey.set(`${match.adapter}:${match.targetRoot}`, match);
  }
  return [...byKey.values()];
}

function runtimeScanRoot(request: RuntimeTargetRequest): string {
  const root = resolve(request.targetRoot ?? request.cwd ?? process.cwd());
  if (request.targetRoot) return root;
  return runtimeMarkers.some((marker) => marker.dirs.includes(basename(root))) ? dirname(root) : root;
}
