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
  format?: string;
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
  if (request.format === "openclaw-clawhub-plugin") {
    const metadata = await openClawClawHubPluginMetadata(request.path, request.fallbackPluginName);
    return {
      runtime: "openclaw",
      pluginName: metadata.pluginName,
      installCommands: [openClawPluginInstallCommand({ path: metadata.installSpec, dryRun: true })],
      uninstallCommands: [openClawPluginUninstallCommand(metadata.pluginName)],
    };
  }

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

async function openClawClawHubPluginMetadata(root: string, fallback: string): Promise<{ installSpec: string; pluginName: string }> {
  const metadataPath = join(root, "clawhub.json");
  if (!(await pathExists(metadataPath))) {
    throw new Error("OpenClaw ClawHub plugins must contain clawhub.json");
  }
  const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as {
    installSpec?: unknown;
    runtimeId?: unknown;
    name?: unknown;
  };
  const installSpec = stringField(parsed.installSpec);
  if (!installSpec?.startsWith("clawhub:")) {
    throw new Error("OpenClaw ClawHub plugin metadata must declare installSpec starting with clawhub:");
  }
  const pluginName = stringField(parsed.runtimeId) ?? installNameFor(stringField(parsed.name) ?? fallback);
  return { installSpec, pluginName };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function installNameFor(value: string): string {
  return value
    .split("/")
    .at(-1)!
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || "clawhub-plugin";
}
