import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { pathExists } from "../../utils/fs.js";

export interface PluginIdentityRequest {
  root: string;
  fallbackPluginName: string;
}

export interface PluginStateRootRequest {
  targetRoot: string;
  runtime: string;
  installationType: string;
  packageName?: string;
  installName: string;
}

export function pluginStateRoot(request: PluginStateRootRequest): string {
  return join(
    request.targetRoot,
    ".agentwheel",
    "plugins",
    request.runtime,
    request.installationType,
    safeNameSegment(request.packageName ?? "package"),
    safeNameSegment(request.installName),
  );
}

export function agentwheelMarketplaceName(packageName: string | undefined, pluginName: string): string {
  return `agentwheel-${safeNameSegment(packageName ?? "package")}-${safeNameSegment(pluginName)}`;
}

export function safeNameSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "unnamed";
}

export async function jsonPluginName(root: string, relativeManifestPath: string, fallback: string): Promise<string> {
  const manifestPath = join(root, relativeManifestPath);
  if (!(await pathExists(manifestPath))) return fallback;
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
  return typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : fallback;
}

export async function yamlPluginName(root: string, relativeManifestPaths: string[], fallback: string): Promise<string> {
  for (const relativeManifestPath of relativeManifestPaths) {
    const manifestPath = join(root, relativeManifestPath);
    if (!(await pathExists(manifestPath))) continue;
    const document = parseDocument(await readFile(manifestPath, "utf8"));
    const parsed = document.toJSON() as unknown;
    if (!isRecord(parsed)) continue;
    for (const key of ["name", "module", "package"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    const packageValue = parsed.package;
    if (isRecord(packageValue) && typeof packageValue.name === "string" && packageValue.name.trim().length > 0) {
      return packageValue.name.trim();
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
