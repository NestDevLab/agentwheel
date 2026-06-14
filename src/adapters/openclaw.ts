import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AdapterConfig, ProgrammaticAdapterContext, ProgrammaticAdapterOperation } from "../model/adapter.js";

const builtinHash = createHash("sha256").update("agentwheel:openclaw-agent-skills:v1").digest("hex");

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: { enabled: true, dest: ".openclaw/AGENTS.md" },
    rules: { enabled: true, dest: ".openclaw/rules" },
    skills: { enabled: true, dest: ".openclaw/skills" },
    commands: { enabled: true, dest: ".openclaw/commands" },
    mcp: { enabled: true, dest: ".openclaw/mcp", merge: "json-deep" },
    hooks: { enabled: true, dest: ".openclaw/hooks", merge: "json-deep" },
    settings: { enabled: true, dest: ".openclaw/settings.json", merge: "json-deep" },
    plugins: { enabled: true, dest: ".openclaw/plugins", semantic: "openclaw-plugin" },
  },
};

type OpenClawAgentSkillsOptions = NonNullable<NonNullable<AdapterConfig["openclaw"]>["agentSkills"]>;

export function attachOpenClawProgrammatic(adapter: AdapterConfig): AdapterConfig {
  const agentSkills = adapter.openclaw?.agentSkills;
  if (!agentSkills?.enabled) return adapter;
  const existing = adapter.programmatic;
  return {
    ...adapter,
    programmatic: {
      modulePath: existing ? `${existing.modulePath}+builtin:openclaw` : "builtin:openclaw",
      hash: existing ? stableHash({ existing: existing.hash, builtin: builtinHash }) : builtinHash,
      capabilities: [...new Set([...(existing?.capabilities ?? []), "openclaw-agent-skills"])],
      plan: async (context) => [
        ...await resolveProgrammaticPlan(existing, context),
        ...await planOpenClawAgentSkills(agentSkills, context),
      ],
      apply: async (operation, context) => {
        if (operation.name === "openclaw-agent-skills") {
          await applyOpenClawAgentSkills(operation, context);
          return;
        }
        if (!existing?.apply) throw new Error(`No programmatic apply handler for ${operation.name}`);
        await existing.apply(operation, context);
      },
      uninstall: existing?.uninstall,
    },
  };
}

async function resolveProgrammaticPlan(existing: AdapterConfig["programmatic"], context: ProgrammaticAdapterContext): Promise<ProgrammaticAdapterOperation[]> {
  return existing?.plan ? await existing.plan(context) : [];
}

interface AgentSkillsOperationData {
  configPath: string;
  managedSkills: string[];
  include?: string[];
  exclude?: string[];
  includeAgentsWithoutExplicitSkills: boolean;
}

interface OpenClawConfig {
  agents?: {
    list?: unknown[];
  };
}

async function planOpenClawAgentSkills(options: OpenClawAgentSkillsOptions, context: ProgrammaticAdapterContext): Promise<ProgrammaticAdapterOperation[]> {
  const data = await agentSkillsOperationData(options, context);
  if (!data) return [];
  const config = await readOpenClawConfig(context, data.configPath);
  if (!config) return [];
  const changes = computeAgentSkillsChanges(config, data);
  if (changes.length === 0) return [];
  return [{
    name: "openclaw-agent-skills",
    reason: `update OpenClaw per-agent skill allowlists (${changes.map((change) => change.id).join(", ")})`,
    hash: stableHash({ ...data, changes }),
    data,
  }];
}

async function applyOpenClawAgentSkills(operation: ProgrammaticAdapterOperation, context: ProgrammaticAdapterContext): Promise<void> {
  const data = parseAgentSkillsOperationData(operation.data);
  if (!data) throw new Error("Invalid OpenClaw agent skills operation data");
  const config = await readOpenClawConfig(context, data.configPath);
  if (!config) return;
  const changes = applyAgentSkills(config, data);
  if (changes.length === 0) return;
  if (!context.transport) throw new Error("OpenClaw agent skills operation requires a target transport");
  await context.transport.writeFileAtomic(resolveConfigPath(context.targetRoot, data.configPath), `${JSON.stringify(config, null, 2)}\n`);
}

async function agentSkillsOperationData(options: OpenClawAgentSkillsOptions, context: ProgrammaticAdapterContext): Promise<AgentSkillsOperationData | undefined> {
  const managedSkills = [...new Set((context.artifacts ?? [])
    .filter((artifact) => artifact.type === "skills")
    .map((artifact) => artifact.installName ?? artifact.name)
    .filter(Boolean))]
    .sort();
  if (managedSkills.length === 0) return undefined;
  return {
    configPath: options.configPath,
    managedSkills,
    include: options.agents?.include,
    exclude: options.agents?.exclude,
    includeAgentsWithoutExplicitSkills: options.includeAgentsWithoutExplicitSkills,
  };
}

async function readOpenClawConfig(context: ProgrammaticAdapterContext, configPath: string): Promise<OpenClawConfig | undefined> {
  if (!context.transport) throw new Error("OpenClaw agent skills operation requires a target transport");
  const path = resolveConfigPath(context.targetRoot, configPath);
  if (!(await context.transport.pathExists(path))) return undefined;
  const raw = await context.transport.readFile(path);
  const parsed = JSON.parse(raw) as OpenClawConfig;
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid OpenClaw config: ${path}`);
  return parsed;
}

function resolveConfigPath(targetRoot: string, configPath: string): string {
  if (configPath.startsWith("/") || configPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe OpenClaw config path: ${configPath}`);
  }
  return join(targetRoot, configPath);
}

function computeAgentSkillsChanges(config: OpenClawConfig, data: AgentSkillsOperationData): Array<{ id: string; before: string[]; after: string[] }> {
  const clone = structuredClone(config) as OpenClawConfig;
  return applyAgentSkills(clone, data);
}

function applyAgentSkills(config: OpenClawConfig, data: AgentSkillsOperationData): Array<{ id: string; before: string[]; after: string[] }> {
  const entries = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const changes: Array<{ id: string; before: string[]; after: string[] }> = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id || !shouldManageAgent(id, data)) continue;
    if (entry.skills === undefined && !data.includeAgentsWithoutExplicitSkills) continue;
    if (entry.skills !== undefined && !isStringArray(entry.skills)) continue;

    const before = entry.skills === undefined ? [] : entry.skills;
    const after = appendMissingSkills(before, data.managedSkills);
    if (arraysEqual(before, after)) continue;
    entry.skills = after;
    changes.push({ id, before, after });
  }
  return changes;
}

function shouldManageAgent(id: string, data: AgentSkillsOperationData): boolean {
  const include = data.include ? new Set(data.include) : undefined;
  if (include && !include.has(id)) return false;
  const exclude = data.exclude ? new Set(data.exclude) : undefined;
  return !exclude?.has(id);
}

function appendMissingSkills(current: string[], managed: string[]): string[] {
  const seen = new Set(current);
  const out = [...current];
  for (const skill of managed) {
    if (seen.has(skill)) continue;
    seen.add(skill);
    out.push(skill);
  }
  return out;
}

function parseAgentSkillsOperationData(value: unknown): AgentSkillsOperationData | undefined {
  if (!isRecord(value) || !isStringArray(value.managedSkills) || typeof value.configPath !== "string") return undefined;
  return {
    configPath: value.configPath,
    managedSkills: value.managedSkills,
    include: isStringArray(value.include) ? value.include : undefined,
    exclude: isStringArray(value.exclude) ? value.exclude : undefined,
    includeAgentsWithoutExplicitSkills: value.includeAgentsWithoutExplicitSkills === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
