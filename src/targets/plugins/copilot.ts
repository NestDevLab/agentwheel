import { join } from "node:path";
import type { Artifact } from "../../model/artifact.js";
import { jsonPluginName, pluginStateRoot } from "./common.js";
import type { SemanticPluginSpec } from "./types.js";

export interface CopilotPluginSpecRequest {
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
  installationType: string;
}

export async function copilotPluginSpec(request: CopilotPluginSpecRequest): Promise<SemanticPluginSpec> {
  if (request.installationType !== "user") {
    throw new Error("Copilot plugins are persistent user-level installs only; pass --installation-type user.");
  }
  const pluginName = await jsonPluginName(request.sourcePath, "plugin.json", request.installName);
  const stateRoot = pluginStateRoot({
    targetRoot: request.targetRoot,
    runtime: "copilot",
    installationType: request.installationType,
    packageName: request.artifact.packageName,
    installName: request.installName,
  });
  const pluginRoot = join(stateRoot, "plugin");

  return {
    runtime: "copilot",
    pluginName,
    stateRoot,
    installCommands: [["copilot", "plugin", "install", pluginRoot]],
    uninstallCommands: [["copilot", "plugin", "uninstall", pluginName]],
  };
}
