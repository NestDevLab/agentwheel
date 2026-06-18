import { z } from "zod";

export const artifactTypeSchema = z.enum([
  "instructions",
  "rules",
  "skills",
  "commands",
  "subagents",
  "mcp",
  "hooks",
  "settings",
  "plugins",
  "fragments",
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const fileKindSchema = z.enum(["file", "dir"]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const artifactFormatSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "artifact format must be a stable identifier");
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export const packageAssetSchema = z.object({
  from: z.string().min(1),
  into: z.string().min(1),
  include: z.array(z.string().min(1)).optional(),
  mode: z.enum(["preserve", "copy"]).default("preserve"),
});
export type PackageAsset = z.infer<typeof packageAssetSchema>;

export const packageComposeEntrySchema = z.object({
  include: z.string().min(1),
  markers: z.boolean().optional(),
  optional: z.boolean().optional(),
});
export type PackageComposeEntry = z.infer<typeof packageComposeEntrySchema>;

export const packageItemRequireObjectSchema = z.object({
  selector: z.string().min(1),
  optional: z.boolean().optional(),
  runtimes: z.array(z.string().min(1)).optional(),
}).passthrough();

export const packageItemRequireSchema = z.union([
  z.string().min(1),
  packageItemRequireObjectSchema,
]);
export type PackageItemRequire = z.infer<typeof packageItemRequireSchema>;

export const composedFromEntrySchema = z.object({
  selector: z.string().min(1),
  hash: z.string().min(16),
});
export type ComposedFromEntry = z.infer<typeof composedFromEntrySchema>;

export const artifactSchema = z.object({
  type: artifactTypeSchema,
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  stagedPath: z.string().min(1).optional(),
  relativePath: z.string().min(1),
  kind: fileKindSchema,
  hash: z.string().min(16),
  format: artifactFormatSchema.optional(),
  packageName: z.string().min(1).optional(),
  channel: z.enum(["managed", "overlay", "addition", "override", "ejected"]).default("managed"),
  assets: z.array(packageAssetSchema).optional(),
  required: z.boolean().optional(),
  requires: z.array(packageItemRequireSchema).optional(),
  compose: z.array(packageComposeEntrySchema).optional(),
  runtimes: z.array(z.string().min(1)).optional(),
  composedFrom: z.array(composedFromEntrySchema).optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;
