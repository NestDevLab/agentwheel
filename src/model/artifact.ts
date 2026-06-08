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
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const fileKindSchema = z.enum(["file", "dir"]);
export type FileKind = z.infer<typeof fileKindSchema>;

export const packageAssetSchema = z.object({
  from: z.string().min(1),
  into: z.string().min(1),
  include: z.array(z.string().min(1)).optional(),
  mode: z.enum(["preserve", "copy"]).default("preserve"),
});
export type PackageAsset = z.infer<typeof packageAssetSchema>;

export const artifactSchema = z.object({
  type: artifactTypeSchema,
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  stagedPath: z.string().min(1).optional(),
  relativePath: z.string().min(1),
  kind: fileKindSchema,
  hash: z.string().min(16),
  packageName: z.string().min(1).optional(),
  channel: z.enum(["managed", "overlay", "addition", "override", "ejected"]).default("managed"),
  assets: z.array(packageAssetSchema).optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;
