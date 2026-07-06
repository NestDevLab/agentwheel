import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { artifactFormatSchema, artifactTypeSchema, packageAssetSchema, packageComposeEntrySchema, packageItemRequireSchema, packageItemSuggestSchema } from "./artifact.js";
import { pathExists } from "../utils/fs.js";

const legacyArtifactTypeSchema = z.enum([
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

const runtimeListSchema = z.array(z.string().min(1));

const packageProvideBaseSchema = z.object({
  path: z.string().min(1),
  format: artifactFormatSchema.optional(),
  assets: z.array(packageAssetSchema).optional(),
  required: z.boolean().optional(),
});

export { packageItemRequireObjectSchema, packageItemRequireSchema } from "./artifact.js";

export const packageItemSchema = z.object({
  format: artifactFormatSchema.optional(),
  requires: z.array(packageItemRequireSchema).optional(),
  suggests: z.array(packageItemSuggestSchema).optional(),
  compose: z.array(packageComposeEntrySchema).optional(),
  runtimes: runtimeListSchema.optional(),
});

export const packageDependencySchema = z.object({
  source: z.string().min(1),
  ref: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  select: z.array(z.string().min(1)).optional(),
  mode: z.enum(["pinned", "tracking"]).optional(),
  optional: z.boolean().optional(),
  integrity: z.string().min(1).optional(),
  runtimes: runtimeListSchema.optional(),
});

export const packageSuggestionSchema = packageDependencySchema.extend({
  reason: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
});

export const packageProvideV1Schema = packageProvideBaseSchema.extend({
  type: legacyArtifactTypeSchema,
});

export const packageProvideSchema = packageProvideBaseSchema.extend({
  type: artifactTypeSchema,
  runtimes: runtimeListSchema.optional(),
  items: z.record(z.string().min(1), packageItemSchema).optional(),
});

export const packageManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  provides: z.array(packageProvideV1Schema).min(1),
});

export const packageManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  name: z.string().min(1),
  version: z.string().min(1),
  runtimes: runtimeListSchema.optional(),
  requires: z.record(z.string().min(1), packageDependencySchema).optional(),
  suggests: z.record(z.string().min(1), packageSuggestionSchema).optional(),
  compose: z.array(packageComposeEntrySchema).optional(),
  provides: z.array(packageProvideSchema).default([]),
}).superRefine((manifest, ctx) => {
  const hasProvides = manifest.provides.length > 0;
  const hasRequires = Object.keys(manifest.requires ?? {}).length > 0;
  if (!hasProvides && !hasRequires) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provides"],
      message: "OpenPack v2 manifest must declare at least one provides entry or one requires dependency",
    });
  }
});

export const packageManifestSchema = z.union([packageManifestV1Schema, packageManifestV2Schema]);

export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageProvide = PackageManifest["provides"][number];
export type PackageAsset = z.infer<typeof packageAssetSchema>;

export const openPackManifestNames = ["openpack.json", "openpack.jsonc"] as const;
export const legacyPackageManifestNames = ["agentwheel.json", "agentwheel.jsonc"] as const;
export const packageManifestNames = [...openPackManifestNames, ...legacyPackageManifestNames] as const;

const warnedLegacyManifestPaths = new Set<string>();

export async function findPackageManifestPath(root: string, options: { warn?: (message: string) => void; warnLegacy?: boolean } = {}): Promise<string | undefined> {
  for (const name of packageManifestNames) {
    const candidate = join(root, name);
    if (!(await pathExists(candidate))) continue;
    if (isLegacyPackageManifestName(name) && options.warnLegacy !== false && !warnedLegacyManifestPaths.has(candidate)) {
      warnedLegacyManifestPaths.add(candidate);
      (options.warn ?? console.warn)(`Deprecated package manifest ${name}; use openpack.json or openpack.jsonc.`);
    }
    return candidate;
  }
  return undefined;
}

export async function readPackageManifest(root: string): Promise<PackageManifest | undefined> {
  const path = await findPackageManifestPath(root);
  if (!path) return undefined;
  const content = await readFile(path, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ");
    throw new Error(`Invalid package manifest ${path}: ${details}`);
  }
  return parsePackageManifest(parsed, path);
}

export function parsePackageManifest(parsed: unknown, path = "package manifest"): PackageManifest {
  if (!isRecord(parsed)) {
    throw new Error(`Invalid package manifest ${path}: expected an object`);
  }
  if (parsed.schemaVersion === 1) {
    const violations = v1OpenPackViolations(parsed);
    if (violations.length > 0) {
      throw new Error(`OpenPack schemaVersion 2 is required for ${violations.join(", ")} in ${path}. Set "schemaVersion": 2.`);
    }
    return parseWithSchema(packageManifestV1Schema, parsed, path) as PackageManifest;
  }
  if (parsed.schemaVersion === 2) {
    return parseWithSchema(packageManifestV2Schema, parsed, path) as PackageManifest;
  }
  throw new Error(`Invalid package manifest ${path}: schemaVersion must be 1 or 2`);
}

function parseWithSchema<T>(schema: z.ZodType<T>, parsed: unknown, path: string): T {
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid package manifest ${path}: ${details}`);
}

function v1OpenPackViolations(manifest: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const key of ["requires", "items", "compose", "runtimes"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) violations.push(key);
  }
  const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
  for (const [index, provide] of provides.entries()) {
    if (!isRecord(provide)) continue;
    if (provide.type === "fragments") violations.push(`provides[${index}].type=fragments`);
    for (const key of ["format", "items", "compose", "runtimes"]) {
      if (Object.prototype.hasOwnProperty.call(provide, key)) violations.push(`provides[${index}].${key}`);
    }
  }
  return violations;
}

function isLegacyPackageManifestName(name: string): boolean {
  return (legacyPackageManifestNames as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
