import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
});

export const workspaceProfileRuntimeSchema = z.object({
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

export const workspaceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  packages: z.array(workspacePackageSchema).default([]),
  registry: workspaceRegistrySchema,
  profiles: z.record(z.string(), workspaceProfileSchema).default({}),
});

export type WorkspacePackage = z.infer<typeof workspacePackageSchema>;
export type WorkspaceProfileRuntime = z.infer<typeof workspaceProfileRuntimeSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export function workspaceConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agentwheel", "config.json");
}

export async function readWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath(workspaceRoot);
  if (!(await pathExists(path))) return { schemaVersion: 1, packages: [], registry: {}, profiles: {} };
  return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeWorkspaceConfig(workspaceRoot: string, config: WorkspaceConfig): Promise<void> {
  await writeJsonAtomic(workspaceConfigPath(workspaceRoot), workspaceConfigSchema.parse(config));
}

export function upsertPackage(config: WorkspaceConfig, entry: WorkspacePackage): WorkspaceConfig {
  const packages = config.packages.filter((candidate) => candidate.name !== entry.name);
  packages.push(entry);
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, packages, registry: config.registry ?? {}, profiles: config.profiles ?? {} };
}
