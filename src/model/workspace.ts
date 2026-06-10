import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

export const workspacePackageSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  driver: z.enum(["local", "git", "skillkit", "vercel-skills"]).default("local"),
  adapter: z.string().min(1).default("openclaw"),
  adapterConfig: z.string().min(1).optional(),
  adapterModule: z.string().min(1).optional(),
  adapterCodeHash: z.string().min(16).optional(),
  mode: z.enum(["pinned", "tracking"]).default("pinned"),
  requestedRef: z.string().min(1).optional(),
  select: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  aliases: z.record(z.string(), z.string().min(1)).optional(),
});

export const workspaceProfileRuntimeSchema = z.object({
  agent: z.string().min(1).optional(),
  adapter: z.string().min(1).default("openclaw"),
  adapterConfig: z.string().min(1).optional(),
  adapterModule: z.string().min(1).optional(),
  targetRoot: z.string().min(1).optional(),
  executePlugins: z.boolean().optional(),
});

export const workspaceProfileSchema = z.object({
  runtimes: z.array(workspaceProfileRuntimeSchema).min(1),
});

export const workspaceRegistrySchema = z.object({
  sources: z.array(z.string().min(1)).optional(),
  ttlSeconds: z.number().int().positive().optional(),
}).default({});

export const workspaceAgentSchema = z.object({
  adapter: z.string().min(1),
  root: z.string().min(1),
  transport: z.enum(["local", "ssh"]).default("local"),
  host: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().min(1).optional(),
}).superRefine((agent, ctx) => {
  if (agent.transport !== "ssh") return;
  if (!agent.host) {
    ctx.addIssue({
      code: "custom",
      path: ["host"],
      message: "SSH agents require host",
    });
  }
});

export const workspaceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  packages: z.array(workspacePackageSchema).default([]),
  bootstrapSkills: z.boolean().optional(),
  registry: workspaceRegistrySchema,
  profiles: z.record(z.string(), workspaceProfileSchema).default({}),
  agents: z.record(z.string(), workspaceAgentSchema).default({}),
});

export type WorkspacePackage = z.infer<typeof workspacePackageSchema>;
export type WorkspaceProfileRuntime = z.infer<typeof workspaceProfileRuntimeSchema>;
export type WorkspaceAgent = z.infer<typeof workspaceAgentSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export function workspaceConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agentwheel", "config.json");
}

export async function readWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath(workspaceRoot);
  if (!(await pathExists(path))) return emptyWorkspaceConfig();
  return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeWorkspaceConfig(workspaceRoot: string, config: WorkspaceConfig): Promise<void> {
  await writeJsonAtomic(workspaceConfigPath(workspaceRoot), workspaceConfigSchema.parse(config));
}

export function upsertPackage(config: WorkspaceConfig, entry: WorkspacePackage): WorkspaceConfig {
  const packages = config.packages.filter((candidate) => candidate.name !== entry.name);
  packages.push(entry);
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, packages, bootstrapSkills: config.bootstrapSkills, registry: config.registry ?? {}, profiles: config.profiles ?? {}, agents: config.agents ?? {} };
}

export interface WorkspaceMergeOptions {
  globalRoot?: string;
}

export function globalWorkspaceConfigPath(globalRoot = homedir()): string {
  return join(globalRoot, ".agentwheel", "config.json");
}

export async function findWorkspaceRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await pathExists(workspaceConfigPath(current))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export async function readMergedWorkspaceConfig(projectRoot: string, options: WorkspaceMergeOptions = {}): Promise<WorkspaceConfig> {
  const global = await readConfigPath(globalWorkspaceConfigPath(options.globalRoot));
  const project = await readWorkspaceConfig(projectRoot);
  return mergeWorkspaceConfig(global, project);
}

export function mergeWorkspaceConfig(global: WorkspaceConfig, project: WorkspaceConfig): WorkspaceConfig {
  return workspaceConfigSchema.parse({
    schemaVersion: 1,
    packages: project.packages.length > 0 ? project.packages : global.packages,
    bootstrapSkills: project.bootstrapSkills ?? global.bootstrapSkills,
    registry: {
      ...global.registry,
      ...project.registry,
      sources: project.registry.sources ?? global.registry.sources,
      ttlSeconds: project.registry.ttlSeconds ?? global.registry.ttlSeconds,
    },
    profiles: { ...global.profiles, ...project.profiles },
    agents: { ...global.agents, ...project.agents },
  });
}

export function resolveConfigPath(path: string, baseRoot: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path.startsWith("/") ? resolve(path) : resolve(baseRoot, path);
}

function emptyWorkspaceConfig(): WorkspaceConfig {
  return { schemaVersion: 1, packages: [], registry: {}, profiles: {}, agents: {} };
}

async function readConfigPath(path: string): Promise<WorkspaceConfig> {
  if (!(await pathExists(path))) return emptyWorkspaceConfig();
  return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
