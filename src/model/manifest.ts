import { z } from "zod";
import { artifactFormatSchema, artifactTypeSchema, composedFromEntrySchema, fileKindSchema } from "./artifact.js";
import { defaultInstallationType, installationTypeSchema } from "./adapter.js";

export const dependencyRoleSchema = z.enum(["root", "direct", "transitive", "fragment"]);
export type DependencyRole = z.infer<typeof dependencyRoleSchema>;
export const legacyUnownedWorkspaceOwner = "legacy:unowned";

export const manifestEntryV1Schema = z.object({
  path: z.string().min(1),
  artifactType: artifactTypeSchema,
  artifactName: z.string().min(1),
  kind: fileKindSchema,
  hash: z.string().min(16),
  sourceHash: z.string().min(16),
  updatedAt: z.string().datetime(),
  channel: z.enum(["managed", "overlay", "addition", "override", "ejected"]).default("managed"),
  packageName: z.string().min(1).optional(),
  semanticCommand: z.array(z.string()).optional(),
  executed: z.boolean().optional(),
  mergeStrategy: z.enum(["json-deep", "yaml-deep", "codex-toml-mcp"]).optional(),
  composedFrom: z.array(composedFromEntrySchema).optional(),
});

export const manifestEntrySchema = manifestEntryV1Schema.extend({
  installName: z.string().min(1),
  logicalSelector: z.string().min(1).optional(),
  graphNodeId: z.string().min(1).optional(),
  dependencyRole: dependencyRoleSchema.default("root"),
  owners: z.array(z.string().min(1)).min(1),
  refCount: z.number().int().positive(),
  workspaceOwner: z.string().min(1).default(legacyUnownedWorkspaceOwner),
  graphLockDigest: z.string().min(1).optional(),
}).transform((entry) => {
  const owners = [...new Set(entry.owners)].sort();
  return {
    ...entry,
    owners,
    refCount: owners.length,
  };
});

export const installManifestV1Schema = z.object({
  version: z.literal(1),
  adapter: z.string().min(1),
  targetRoot: z.string().min(1),
  generatedAt: z.string().datetime(),
  adapterCode: z.object({
    modulePath: z.string().min(1),
    hash: z.string().min(16),
  }).optional(),
  entries: z.array(manifestEntryV1Schema),
}).transform((manifest) => ({
  ...manifest,
  legacy: true as const,
}));

export const installManifestV2Schema = z.object({
  version: z.literal(2),
  adapter: z.string().min(1),
  installationType: installationTypeSchema.default(defaultInstallationType),
  stateKey: z.string().min(1).optional(),
  targetRoot: z.string().min(1),
  generatedAt: z.string().datetime(),
  revision: z.string().min(16),
  adapterCode: z.object({
    modulePath: z.string().min(1),
    hash: z.string().min(16),
  }).optional(),
  entries: z.array(manifestEntrySchema),
}).transform((manifest) => ({
  ...manifest,
  legacy: false as const,
}));

export const installManifestSchema = z.union([installManifestV2Schema, installManifestV1Schema]);

export const sourceLockSchema = z.object({
  version: z.literal(1),
  driver: z.string().min(1),
  source: z.string().min(1),
  resolvedPath: z.string().min(1),
  packageName: z.string().min(1).optional(),
  packageVersion: z.string().min(1).optional(),
  mode: z.enum(["pinned", "tracking"]).default("pinned"),
  requestedRef: z.string().min(1).optional(),
  resolvedCommit: z.string().min(1).optional(),
  sourceHash: z.string().min(16).optional(),
  generatedAt: z.string().datetime(),
  artifacts: z.array(
    z.object({
      type: artifactTypeSchema,
      name: z.string().min(1),
      relativePath: z.string().min(1),
      kind: fileKindSchema,
      hash: z.string().min(16),
      format: artifactFormatSchema.optional(),
      composedFrom: z.array(composedFromEntrySchema).optional(),
    }),
  ),
});

export type InstallManifestEntry = z.infer<typeof manifestEntrySchema>;
export type InstallManifestV1Entry = z.infer<typeof manifestEntryV1Schema>;
export type InstallManifestV2 = z.infer<typeof installManifestV2Schema>;
export type InstallManifestV1 = z.infer<typeof installManifestV1Schema> & { revision: string };
export type InstallManifest = InstallManifestV2 | InstallManifestV1;
export type SourceLock = z.infer<typeof sourceLockSchema>;
