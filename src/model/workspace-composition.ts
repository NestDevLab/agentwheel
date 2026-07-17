import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  workspaceConfigPath,
  workspaceExportsSchema,
  workspaceSelectionImportSchema,
  type WorkspaceSelectionExport,
  type WorkspaceSelectionImport,
} from "./workspace.js";
import { normalizeArtifactSelectors } from "./selection.js";
import { pathExists } from "../utils/fs.js";

const selectionSourceConfigSchema = z.object({
  schemaVersion: z.literal(2),
  exports: workspaceExportsSchema,
}).passthrough();

export interface ResolvedSelectionImport {
  configPath: string;
  configHash: string;
  exportHash: string;
  exportName: string;
  extends: string[];
  inherited: string[];
  additions: string[];
  exclusions: string[];
  effective: string[];
}

interface ResolvedSelectionExport {
  chain: string[];
  effective: string[];
}

/**
 * Resolves only the selection-export catalog from an already fetched package
 * source. Runtime configuration in that source is intentionally ignored.
 */
export async function resolveSelectionImport(
  sourceRoot: string,
  sourceDriver: string,
  selection: WorkspaceSelectionImport,
): Promise<ResolvedSelectionImport> {
  const parsedSelection = workspaceSelectionImportSchema.parse(selection);
  if (sourceDriver !== "local" && sourceDriver !== "git") {
    throw new Error(
      `Selection import '${parsedSelection.export}' is unsupported for source driver '${sourceDriver}'. `
      + "Only local and git sources expose a stable project configuration.",
    );
  }

  const path = workspaceConfigPath(sourceRoot);
  if (!(await pathExists(path))) {
    throw new Error(`Selection import '${parsedSelection.export}' requires source config: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Selection import '${parsedSelection.export}' cannot parse ${path}: ${message}`);
  }
  if (!isRecord(raw) || raw.schemaVersion !== 2) {
    throw new Error(`Selection import '${parsedSelection.export}' requires schemaVersion 2 in ${path}.`);
  }

  let sourceConfig: z.infer<typeof selectionSourceConfigSchema>;
  try {
    sourceConfig = selectionSourceConfigSchema.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Selection import '${parsedSelection.export}' has invalid exports in ${path}: ${message}`);
  }

  const selections = sourceConfig.exports.selections;
  let exportSelection: ResolvedSelectionExport;
  let additions: string[];
  let exclusions: string[];
  try {
    exportSelection = resolveExport(parsedSelection.export, selections, []);
    additions = normalizeSelectors(parsedSelection.add, `selection import '${parsedSelection.export}' add`);
    exclusions = normalizeSelectors(parsedSelection.exclude, `selection import '${parsedSelection.export}' exclude`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Selection import '${parsedSelection.export}' in ${path}: ${message}`);
  }
  const effective = applySelection(exportSelection.effective, additions, exclusions);
  const configHash = sha256(stableJson({ selections }));
  const exportHash = sha256(stableJson({
    export: parsedSelection.export,
    chain: exportSelection.chain.map((name) => ({ name, selection: selections[name] })),
  }));

  return {
    configPath: ".agentwheel/config.json",
    configHash,
    exportHash,
    exportName: parsedSelection.export,
    extends: exportSelection.chain,
    inherited: exportSelection.effective,
    additions,
    exclusions,
    effective,
  };
}

function resolveExport(
  name: string,
  selections: Record<string, WorkspaceSelectionExport>,
  stack: string[],
): ResolvedSelectionExport {
  if (stack.includes(name)) {
    throw new Error(`Selection export cycle: ${[...stack, name].join(" -> ")}`);
  }
  if (!Object.prototype.hasOwnProperty.call(selections, name)) {
    throw new Error(`Selection export not found: ${name}`);
  }
  const selection = selections[name]!;

  const nextStack = [...stack, name];
  const inherited = selection.extends
    ? resolveExport(selection.extends, selections, nextStack)
    : { chain: [], effective: normalizeSelectors(selection.select, `selection export '${name}' select`) };
  const additions = normalizeSelectors(selection.add, `selection export '${name}' add`);
  const exclusions = normalizeSelectors(selection.exclude, `selection export '${name}' exclude`);
  return {
    chain: [...inherited.chain, name],
    effective: applySelection(inherited.effective, additions, exclusions),
  };
}

function applySelection(inherited: string[], additions: string[], exclusions: string[]): string[] {
  const excluded = new Set(exclusions);
  return sortedUnique([...inherited, ...additions]).filter((selector) => !excluded.has(selector));
}

function normalizeSelectors(values: string[] | undefined, label: string): string[] {
  try {
    return sortedUnique(normalizeArtifactSelectors(values) ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = stableValue(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
