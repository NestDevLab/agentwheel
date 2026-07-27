import { z } from "zod";

export const searchScopeSchema = z.enum(["all", "registry", "enriched", "vercel"]);
export type SearchScope = z.infer<typeof searchScopeSchema>;

export const searchTypeSchema = z.enum(["package", "skill", "plugin", "mcp", "adapter"]);
export type SearchType = z.infer<typeof searchTypeSchema>;

export const searchEcosystemSchema = z.enum([
  "official",
  "openpack",
  "mcp-registry",
  "clawhub",
  "skillkit",
  "vercel",
]);
export type SearchEcosystem = z.infer<typeof searchEcosystemSchema>;

export const catalogueProvenanceSchema = z.enum(["registry", "enriched", "vercel"]);
export type SearchProvenance = z.infer<typeof catalogueProvenanceSchema>;
export type CatalogueProvenance = SearchProvenance;

export const installabilitySchema = z.enum(["registry", "source", "informational"]);
export type SearchInstallability = z.infer<typeof installabilitySchema>;
export type Installability = SearchInstallability;

const nullableString = z.string().nullable();
const nullableStringArray = z.array(z.string()).nullable();

export const enrichedCatalogueEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ecosystem: searchEcosystemSchema.nullable(),
  type: searchTypeSchema.nullable(),
  description: nullableString,
  tags: nullableStringArray,
  source: nullableString,
  installCommand: nullableString,
  repoUrl: nullableString,
  homepageUrl: nullableString.optional(),
  homepageLinkLabel: nullableString.optional(),
  stars: z.number().finite().nullable().optional(),
  lastPush: nullableString.optional(),
  archived: z.boolean().nullable(),
  provides: nullableStringArray,
  version: nullableString,
  featured: z.boolean().nullable().optional(),
});

export const enrichedCatalogueSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  entries: z.array(enrichedCatalogueEntrySchema),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "id"],
        message: `duplicate catalogue id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
  });
});

export const vercelCatalogueEntrySchema = z.object({
  o: z.string().min(1),
  r: z.string().min(1),
  s: z.string().min(1),
  d: z.string().nullable().optional(),
});

export const vercelCatalogueSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  count: z.number().int().nonnegative(),
  entries: z.array(vercelCatalogueEntrySchema),
}).superRefine((value, context) => {
  if (value.count !== value.entries.length) {
    context.addIssue({
      code: "custom",
      path: ["count"],
      message: `count must equal entries length (${value.entries.length})`,
    });
  }
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    const id = `${entry.o}/${entry.r}/${entry.s}`;
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index],
        message: `duplicate Vercel catalogue id: ${id}`,
      });
    }
    seen.add(id);
  });
});

export const catalogueCacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string().datetime(),
  sources: z.tuple([z.string().url(), z.string().url()]),
  enriched: enrichedCatalogueSchema,
  vercel: vercelCatalogueSchema,
});

export const catalogueCacheEnvelopeSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.string().datetime(),
  sources: z.tuple([z.string().url(), z.string().url()]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  enriched: z.unknown(),
  vercel: z.unknown(),
});

export const searchResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  type: searchTypeSchema,
  ecosystem: searchEcosystemSchema.optional(),
  tags: z.array(z.string()),
  provides: z.array(z.string()),
  source: z.string().min(1).optional(),
  repoUrl: z.string().min(1).optional(),
  installCommand: z.string().min(1).optional(),
  installability: installabilitySchema,
  provenances: z.array(catalogueProvenanceSchema).min(1),
  score: z.number().int().nonnegative(),
  matchedFields: z.array(z.string()),
});

export const searchResponseSchema = z.object({
  schemaVersion: z.literal(1),
  query: z.string(),
  scope: searchScopeSchema,
  fromCache: z.boolean(),
  results: z.array(searchResultSchema),
});

export type EnrichedCatalogueEntry = z.infer<typeof enrichedCatalogueEntrySchema>;
export type EnrichedCatalogue = z.infer<typeof enrichedCatalogueSchema>;
export type VercelCatalogueEntry = z.infer<typeof vercelCatalogueEntrySchema>;
export type VercelCatalogue = z.infer<typeof vercelCatalogueSchema>;
export type CatalogueCache = z.infer<typeof catalogueCacheSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
