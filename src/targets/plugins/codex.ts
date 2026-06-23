import { join } from "node:path";
import type { Artifact } from "../../model/artifact.js";
import { agentwheelMarketplaceName, jsonPluginName, pluginStateRoot } from "./common.js";
import type { SemanticPluginSpec } from "./types.js";

export interface CodexPluginSpecRequest {
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
  installationType: string;
}

export async function codexPluginSpec(request: CodexPluginSpecRequest): Promise<SemanticPluginSpec> {
  const pluginName = await jsonPluginName(request.sourcePath, ".codex-plugin/plugin.json", request.installName);
  const marketplaceName = agentwheelMarketplaceName(request.artifact.packageName, pluginName);
  const stateRoot = pluginStateRoot({
    targetRoot: request.targetRoot,
    runtime: "codex",
    installationType: request.installationType,
    packageName: request.artifact.packageName,
    installName: request.installName,
  });
  const marketplaceRoot = join(stateRoot, "marketplace");
  const selector = `${pluginName}@${marketplaceName}`;

  return {
    runtime: "codex",
    pluginName,
    marketplaceName,
    stateRoot,
    installCommands: [
      ["codex", "plugin", "marketplace", "add", marketplaceRoot, "--json"],
      ["codex", "plugin", "add", selector, "--json"],
    ],
    uninstallCommands: [
      ["codex", "plugin", "remove", selector, "--json"],
      ["codex", "plugin", "marketplace", "remove", marketplaceName, "--json"],
    ],
  };
}
