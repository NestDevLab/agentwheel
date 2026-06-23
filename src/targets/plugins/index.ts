import type { Artifact } from "../../model/artifact.js";
import { openClawPluginSpec } from "./openclaw.js";
import type { SemanticPluginSpec } from "./types.js";

export type { SemanticPluginRuntime, SemanticPluginSpec } from "./types.js";

export interface SemanticPluginRequest {
  semantic?: string;
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
}

export async function semanticPluginSpecForArtifact(request: SemanticPluginRequest): Promise<SemanticPluginSpec | undefined> {
  if (request.semantic === "openclaw-plugin") {
    return openClawPluginSpec({
      path: request.sourcePath,
      fallbackPluginName: request.installName,
    });
  }
  return undefined;
}
