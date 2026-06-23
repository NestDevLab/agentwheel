import { join } from "node:path";
import type { Artifact } from "../../model/artifact.js";
import { agentwheelMarketplaceName, jsonPluginName, pluginStateRoot } from "./common.js";
import type { SemanticPluginSpec } from "./types.js";

export interface ClaudePluginSpecRequest {
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
  installationType: string;
}

export async function claudePluginSpec(request: ClaudePluginSpecRequest): Promise<SemanticPluginSpec> {
  const pluginName = await jsonPluginName(request.sourcePath, ".claude-plugin/plugin.json", request.installName);
  const marketplaceName = agentwheelMarketplaceName(request.artifact.packageName, pluginName);
  const stateRoot = pluginStateRoot({
    targetRoot: request.targetRoot,
    runtime: "claude",
    installationType: request.installationType,
    packageName: request.artifact.packageName,
    installName: request.installName,
  });
  const marketplaceRoot = join(stateRoot, "marketplace");
  const scope = claudeScope(request.installationType);
  const selector = `${pluginName}@${marketplaceName}`;

  return {
    runtime: "claude",
    pluginName,
    marketplaceName,
    stateRoot,
    installCommands: [
      ["claude", "plugin", "marketplace", "add", marketplaceRoot, "--scope", scope],
      ["claude", "plugin", "install", selector, "--scope", scope],
    ],
    uninstallCommands: [
      ["claude", "plugin", "uninstall", selector, "--scope", scope],
      ["claude", "plugin", "marketplace", "remove", marketplaceName, "--scope", scope],
    ],
  };
}

function claudeScope(installationType: string): string {
  if (installationType === "user" || installationType === "local") return installationType;
  if (installationType === "project") return "project";
  throw new Error(`Claude plugins support installation types user, local, or project; got '${installationType}'.`);
}
