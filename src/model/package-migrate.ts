import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { legacyPackageManifestNames, openPackManifestNames } from "./package.js";
import { pathExists } from "../utils/fs.js";
import { declareMutationPath } from "../mutation/declarations.js";

export interface PackageMigrateResult {
  changed: boolean;
  from?: string;
  to?: string;
  message: string;
}

export async function migratePackageManifest(root: string): Promise<PackageMigrateResult> {
  const packageRoot = resolve(root);
  for (const name of openPackManifestNames) {
    const path = join(packageRoot, name);
    if (await pathExists(path)) {
      return { changed: false, to: path, message: `Package already uses ${name}.` };
    }
  }

  const legacyName = await firstExistingLegacyManifest(packageRoot);
  if (!legacyName) {
    throw new Error(`No legacy package manifest found at ${packageRoot}`);
  }

  const from = join(packageRoot, legacyName);
  const toName = legacyName.endsWith(".jsonc") ? "openpack.jsonc" : "openpack.json";
  const to = join(packageRoot, toName);
  const content = await readFile(from, "utf8");
  const updated = updateSchemaVersion(content);
  declareMutationPath(from);
  declareMutationPath(to);
  await rename(from, to);
  await writeFile(to, updated, "utf8");
  return { changed: true, from, to, message: `Migrated ${legacyName} to ${toName}.` };
}

async function firstExistingLegacyManifest(root: string): Promise<string | undefined> {
  for (const name of legacyPackageManifestNames) {
    if (await pathExists(join(root, name))) return name;
  }
  return undefined;
}

function updateSchemaVersion(content: string): string {
  const errors: ParseError[] = [];
  parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error("Cannot migrate invalid JSON/JSONC package manifest.");
  }
  const edits = modify(content, ["schemaVersion"], 2, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(content, edits);
}
