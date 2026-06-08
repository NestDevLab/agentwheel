import { z } from "zod";
import { artifactTypeSchema, fileKindSchema } from "./artifact.js";

export const manifestEntrySchema = z.object({
  path: z.string().min(1),
  artifactType: artifactTypeSchema,
  artifactName: z.string().min(1),
  kind: fileKindSchema,
  hash: z.string().min(16),
  sourceHash: z.string().min(16),
  updatedAt: z.string().datetime(),
});

export const installManifestSchema = z.object({
  version: z.literal(1),
  adapter: z.string().min(1),
  targetRoot: z.string().min(1),
  generatedAt: z.string().datetime(),
  entries: z.array(manifestEntrySchema),
});

export const sourceLockSchema = z.object({
  version: z.literal(1),
  driver: z.string().min(1),
  source: z.string().min(1),
  resolvedPath: z.string().min(1),
  generatedAt: z.string().datetime(),
  artifacts: z.array(
    z.object({
      type: artifactTypeSchema,
      name: z.string().min(1),
      relativePath: z.string().min(1),
      kind: fileKindSchema,
      hash: z.string().min(16),
    }),
  ),
});

export type InstallManifestEntry = z.infer<typeof manifestEntrySchema>;
export type InstallManifest = z.infer<typeof installManifestSchema>;
export type SourceLock = z.infer<typeof sourceLockSchema>;

