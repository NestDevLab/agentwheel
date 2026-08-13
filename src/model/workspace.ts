import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { artifactTypeSchema } from "./artifact.js";
import { installationTypeSchema } from "./adapter.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";
import { isSupportedVersionRange } from "../resolve/semver.js";

const artifactSelectorListSchema = z.array(z.string().min(1));

export const workspaceSelectionImportSchema = z.object({
  export: z.string().min(1),
  add: artifactSelectorListSchema.optional(),
  exclude: artifactSelectorListSchema.optional(),
}).strict();

export const workspaceSelectionExportSchema = z.object({
  extends: z.string().min(1).optional(),
  select: artifactSelectorListSchema.optional(),
  add: artifactSelectorListSchema.optional(),
  exclude: artifactSelectorListSchema.optional(),
}).strict().superRefine((selection, ctx) => {
  if (selection.extends && selection.select) {
    ctx.addIssue({
      code: "custom",
      path: ["select"],
      message: "Selection exports may use either select or extends, not both.",
    });
  }
  if (!selection.extends && !selection.select) {
    ctx.addIssue({
      code: "custom",
      path: ["select"],
      message: "Selection exports without extends require select.",
    });
  }
});

export const workspaceExportsSchema = z.object({
  selections: z.record(z.string().min(1), workspaceSelectionExportSchema).default({}),
}).strict();

const workspacePackageBaseSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  driver: z.enum(["local", "git", "skillkit", "vercel-skills", "mcp-registry", "clawhub"]).default("local"),
  adapter: z.string().min(1).default("openclaw"),
  adapterConfig: z.string().min(1).optional(),
  adapterModule: z.string().min(1).optional(),
  adapterCodeHash: z.string().min(16).optional(),
  installationType: installationTypeSchema.optional(),
  mode: z.enum(["pinned", "tracking"]).default("pinned"),
  version: z.string().min(1).refine(isSupportedVersionRange, {
    message: "Version policy must be an exact semver, ~range, ^range, comparator range, or *",
  }).optional(),
  requestedRef: z.string().min(1).optional(),
  select: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  withSuggestions: z.boolean().optional(),
  suggestions: z.array(z.string().min(1)).optional(),
  aliases: z.record(z.string(), z.string().min(1)).optional(),
  overrides: z.array(z.string().min(1)).optional(),
});

export const workspacePackageSchema = workspacePackageBaseSchema.extend({
  selection: workspaceSelectionImportSchema.optional(),
}).superRefine((pkg, ctx) => {
  if (pkg.selection && (pkg.select !== undefined || pkg.skills !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["selection"],
      message: "Packages may use either selection or select/skills, not both.",
    });
  }
});

const workspacePackageV1Schema = workspacePackageBaseSchema.extend({
  selection: z.never().optional(),
});

const commandSchema = z.array(z.string().min(1)).min(1);
const commandListSchema = z.array(commandSchema).min(1).optional();
const installStateKeySchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i);

export const workspaceProfileRuntimeSchema = z.object({
  agent: z.string().min(1).optional(),
  adapter: z.string().min(1).default("openclaw"),
  adapterConfig: z.string().min(1).optional(),
  adapterModule: z.string().min(1).optional(),
  installationType: installationTypeSchema.optional(),
  stateKey: installStateKeySchema.optional(),
  targetRoot: z.string().min(1).optional(),
  executePlugins: z.boolean().optional(),
  reloadRuntimes: z.boolean().optional(),
  reloadCommands: commandListSchema,
});

export const workspaceProfileMemberSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  workspace: z.string().min(1),
  profile: z.string().min(1),
  transport: z.enum(["local", "ssh"]).default("local"),
  host: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().min(1).optional(),
  refreshTtlSeconds: z.number().int().positive().optional(),
}).strict().superRefine((member, ctx) => {
  if (member.transport === "ssh" && !member.host) {
    ctx.addIssue({ code: "custom", path: ["host"], message: "SSH profile members require host" });
  }
  if (member.transport === "ssh" && !member.workspace.startsWith("/")) {
    ctx.addIssue({ code: "custom", path: ["workspace"], message: "SSH profile member workspaces must be absolute" });
  }
});

const workspaceLeafProfileSchema = z.object({
  runtimes: z.array(workspaceProfileRuntimeSchema).min(1),
  members: z.never().optional(),
}).strict();

const workspaceCompositeProfileSchema = z.object({
  members: z.array(workspaceProfileMemberSchema).min(1),
  runtimes: z.never().optional(),
  refreshTtlSeconds: z.number().int().positive().default(86_400),
}).strict().superRefine((profile, ctx) => {
  const seen = new Set<string>();
  for (const [index, member] of profile.members.entries()) {
    if (seen.has(member.id)) {
      ctx.addIssue({ code: "custom", path: ["members", index, "id"], message: "Composite profile member ids must be unique" });
    }
    seen.add(member.id);
  }
});

export const workspaceProfileSchema = z.union([
  workspaceLeafProfileSchema,
  workspaceCompositeProfileSchema,
]);

export const workspaceRegistrySchema = z.object({
  sources: z.array(z.string().min(1)).optional(),
  ttlSeconds: z.number().int().positive().optional(),
}).default({});

export const workspaceTrustSchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  acceptedSources: z.array(z.string().min(1)).optional(),
  denyArtifactTypes: z.array(artifactTypeSchema).optional(),
  requireReviewForTransitive: z.boolean().optional(),
}).default({});

export const workspaceAgentSchema = z.object({
  adapter: z.string().min(1),
  adapterConfig: z.string().min(1).optional(),
  adapterModule: z.string().min(1).optional(),
  root: z.string().min(1),
  installationType: installationTypeSchema.optional(),
  stateKey: installStateKeySchema.optional(),
  transport: z.enum(["local", "ssh"]).default("local"),
  host: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().min(1).optional(),
  reloadCommands: commandListSchema,
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

const workspaceConfigBaseSchema = z.object({
  bootstrapSkills: z.boolean().optional(),
  registry: workspaceRegistrySchema,
  trust: workspaceTrustSchema,
  profiles: z.record(z.string(), workspaceProfileSchema).default({}),
  agents: z.record(z.string(), workspaceAgentSchema).default({}),
});

const workspaceConfigV1Schema = workspaceConfigBaseSchema.extend({
  schemaVersion: z.literal(1),
  packages: z.array(workspacePackageV1Schema).default([]),
  exports: z.never().optional(),
});

const workspaceConfigV2Schema = workspaceConfigBaseSchema.extend({
  schemaVersion: z.literal(2),
  packages: z.array(workspacePackageSchema).default([]),
  exports: workspaceExportsSchema.default({ selections: {} }),
});

export const workspaceConfigSchema = z.discriminatedUnion("schemaVersion", [
  workspaceConfigV1Schema,
  workspaceConfigV2Schema,
]);

export type WorkspacePackage = z.infer<typeof workspacePackageSchema>;
export type WorkspaceSelectionImport = z.infer<typeof workspaceSelectionImportSchema>;
export type WorkspaceSelectionExport = z.infer<typeof workspaceSelectionExportSchema>;
export type WorkspaceExports = z.infer<typeof workspaceExportsSchema>;
export type WorkspaceTrust = z.infer<typeof workspaceTrustSchema>;
export type WorkspaceConfigInput = z.input<typeof workspaceConfigSchema>;
export type WorkspaceProfileRuntime = z.infer<typeof workspaceProfileRuntimeSchema>;
export type WorkspaceProfileMember = z.infer<typeof workspaceProfileMemberSchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
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

export async function writeWorkspaceConfig(workspaceRoot: string, config: WorkspaceConfigInput): Promise<void> {
  await writeJsonAtomic(workspaceConfigPath(workspaceRoot), workspaceConfigSchema.parse(config));
}

export function upsertPackage(config: WorkspaceConfigInput, entry: WorkspacePackage): WorkspaceConfig {
  const parsed = workspaceConfigSchema.parse(config);
  const packages = parsed.packages.filter((candidate) => candidate.name !== entry.name);
  packages.push(entry);
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return workspaceConfigSchema.parse({ ...parsed, packages });
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
  const schemaVersion = global.schemaVersion === 2 || project.schemaVersion === 2 ? 2 : 1;
  const exports = project.schemaVersion === 2
    ? project.exports
    : global.schemaVersion === 2
      ? global.exports
      : undefined;
  return workspaceConfigSchema.parse({
    schemaVersion,
    packages: project.packages.length > 0 ? project.packages : global.packages,
    bootstrapSkills: project.bootstrapSkills ?? global.bootstrapSkills,
    registry: {
      ...global.registry,
      ...project.registry,
      sources: project.registry.sources ?? global.registry.sources,
      ttlSeconds: project.registry.ttlSeconds ?? global.registry.ttlSeconds,
    },
    trust: mergeWorkspaceTrust(global.trust, project.trust),
    profiles: { ...global.profiles, ...project.profiles },
    agents: { ...global.agents, ...project.agents },
    ...(exports ? { exports } : {}),
  });
}

export function resolveConfigPath(path: string, baseRoot: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path.startsWith("/") ? resolve(path) : resolve(baseRoot, path);
}

function emptyWorkspaceConfig(): WorkspaceConfig {
  return { schemaVersion: 1, packages: [], registry: {}, trust: {}, profiles: {}, agents: {} };
}

export function isCompositeWorkspaceProfile(profile: WorkspaceProfile): profile is Extract<WorkspaceProfile, { members: WorkspaceProfileMember[] }> {
  return "members" in profile && Array.isArray(profile.members);
}

async function readConfigPath(path: string): Promise<WorkspaceConfig> {
  if (!(await pathExists(path))) return emptyWorkspaceConfig();
  return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function mergeWorkspaceTrust(global: WorkspaceTrust | undefined, project: WorkspaceTrust | undefined): WorkspaceTrust {
  return {
    allow: sortedUnique([...(global?.allow ?? []), ...(project?.allow ?? [])]),
    acceptedSources: sortedUnique([...(global?.acceptedSources ?? []), ...(project?.acceptedSources ?? [])]),
    denyArtifactTypes: sortedUnique([...(global?.denyArtifactTypes ?? []), ...(project?.denyArtifactTypes ?? [])]) as WorkspaceTrust["denyArtifactTypes"],
    requireReviewForTransitive: project?.requireReviewForTransitive ?? global?.requireReviewForTransitive,
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
