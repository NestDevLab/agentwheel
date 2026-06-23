import { join } from "node:path";
import type { Artifact } from "../../model/artifact.js";
import { pluginStateRoot, yamlPluginName } from "./common.js";
import type { SemanticPluginSpec } from "./types.js";

export interface HermesPluginSpecRequest {
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
  installationType: string;
}

export async function hermesPluginSpec(request: HermesPluginSpecRequest): Promise<SemanticPluginSpec> {
  if (request.installationType !== "user") {
    throw new Error("Hermes plugins are user-level installs only; pass --installation-type user.");
  }
  const pluginName = await yamlPluginName(request.sourcePath, ["plugin.yaml", "plugin.yml"], request.installName);
  const stateRoot = pluginStateRoot({
    targetRoot: request.targetRoot,
    runtime: "hermes",
    installationType: request.installationType,
    packageName: request.artifact.packageName,
    installName: request.installName,
  });
  const repoRoot = join(stateRoot, "repo");

  return {
    runtime: "hermes",
    pluginName,
    stateRoot,
    installCommands: [["hermes", "plugins", "install", "--force", "--enable", `file://${repoRoot}`]],
    uninstallCommands: [["hermes", "plugins", "remove", pluginName]],
  };
}
