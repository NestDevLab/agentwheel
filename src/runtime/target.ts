import { basename, dirname, join, resolve } from "node:path";
import { findWorkspaceRoot, readMergedWorkspaceConfig, resolveConfigPath, type WorkspaceConfig } from "../model/workspace.js";
import { pathExists } from "../utils/fs.js";

export interface RuntimeTarget {
  adapter: string;
  targetRoot: string;
  workspaceRoot: string;
  agentName?: string;
  source: "target-root" | "agent" | "auto-detect" | "cwd";
}

export interface RuntimeTargetRequest {
  cwd?: string;
  targetRoot?: string;
  adapter?: string;
  agent?: string;
  all?: boolean;
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
    return { ...detected, workspaceRoot: await findWorkspaceRoot(detected.targetRoot), source: "auto-detect" };
  }

  return {
    adapter: request.adapter ?? "openclaw",
    targetRoot: cwd,
    workspaceRoot,
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

export async function detectRuntimeTarget(cwd = process.cwd(), adapterFilter?: string): Promise<Omit<RuntimeTarget, "workspaceRoot" | "source"> | undefined> {
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

  const unique = dedupeTargets(matches);
  if (unique.length > 1) {
    throw new Error(`Multiple runtime directories detected: ${unique.map((item) => `${item.adapter} at ${item.targetRoot}`).join(", ")}. Pass --adapter or --agent.`);
  }
  return unique[0];
}

function targetFromAgent(name: string, config: WorkspaceConfig, workspaceRoot: string): RuntimeTarget {
  const agent = config.agents[name];
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }
  return {
    agentName: name,
    adapter: agent.adapter,
    targetRoot: resolveConfigPath(agent.root, workspaceRoot),
    workspaceRoot,
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
