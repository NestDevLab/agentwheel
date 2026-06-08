import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { artifactTypeSchema, packageAssetSchema } from "./artifact.js";
import { pathExists } from "../utils/fs.js";

export const packageProvideSchema = z.object({
  type: artifactTypeSchema,
  path: z.string().min(1),
  assets: z.array(packageAssetSchema).optional(),
  required: z.boolean().optional(),
});

export const packageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  provides: z.array(packageProvideSchema).min(1),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageProvide = z.infer<typeof packageProvideSchema>;
export type PackageAsset = z.infer<typeof packageAssetSchema>;

export async function findPackageManifestPath(root: string): Promise<string | undefined> {
  for (const name of ["agentwheel.json", "agentwheel.jsonc"]) {
    const candidate = join(root, name);
    if (await pathExists(candidate)) return candidate;
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
  return packageManifestSchema.parse(parsed);
}
