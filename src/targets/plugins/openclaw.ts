import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../../utils/fs.js";
import type { SemanticPluginSpec } from "./types.js";

export interface OpenClawPluginInstallRequest {
  path: string;
  dryRun: boolean;
}

export interface OpenClawPluginSpecRequest {
  path: string;
  fallbackPluginName: string;
}

export function openClawPluginInstallCommand(request: OpenClawPluginInstallRequest): string[] {
  // OpenClaw copies local plugin paths by default. Avoid --link for fleet-managed
  // installs so runtime profiles do not depend on source-checkout symlinks.
  return ["openclaw", "plugins", "install", "--force", request.path];
}

export function openClawPluginUninstallCommand(pluginName: string): string[] {
  return ["openclaw", "plugins", "uninstall", pluginName, "--force"];
}

export async function openClawPluginSpec(request: OpenClawPluginSpecRequest): Promise<SemanticPluginSpec> {
  const pluginName = await openClawPluginName(request.path, request.fallbackPluginName);
  return {
    runtime: "openclaw",
    pluginName,
    installCommands: [openClawPluginInstallCommand({ path: request.path, dryRun: true })],
    uninstallCommands: [openClawPluginUninstallCommand(pluginName)],
  };
}

async function openClawPluginName(root: string, fallback: string): Promise<string> {
  for (const manifestName of ["plugin.json", "openclaw.plugin.json"]) {
    const manifestPath = join(root, manifestName);
    if (!(await pathExists(manifestPath))) continue;
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) return parsed.name.trim();
  }
  return fallback;
}
