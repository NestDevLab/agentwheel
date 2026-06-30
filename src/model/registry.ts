import { z } from "zod";

export const registryEntrySchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  type: z.enum(["package", "skill", "plugin", "mcp", "adapter"]).default("package"),
  description: z.string().default(""),
  tags: z.array(z.string().min(1)).default([]),
  select: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  homepageUrl: z.string().min(1).optional(),
  homepageLinkLabel: z.string().min(1).optional(),
  sourceUrl: z.string().min(1).optional(),
  sourceLinkLabel: z.string().min(1).optional(),
  openpack: z.object({
    schemaVersion: z.number().int().positive().optional(),
    specVersion: z.string().min(1).optional(),
  }).passthrough().optional(),
});

export const registryIndexSchema = z.union([
  z.array(registryEntrySchema),
  z.object({
    schemaVersion: z.literal(1).optional(),
    entries: z.array(registryEntrySchema),
  }),
]).transform((value) => Array.isArray(value) ? value : value.entries);

export const registryCacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string().datetime(),
  sources: z.array(z.string().min(1)),
  entries: z.array(registryEntrySchema),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type RegistryCache = z.infer<typeof registryCacheSchema>;
