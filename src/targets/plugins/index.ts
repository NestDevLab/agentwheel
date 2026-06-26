import type { Artifact } from "../../model/artifact.js";
import { claudePluginSpec } from "./claude.js";
import { codexPluginSpec } from "./codex.js";
import { copilotPluginSpec } from "./copilot.js";
import { hermesPluginSpec } from "./hermes.js";
import { openClawPluginSpec } from "./openclaw.js";
import type { SemanticPluginSpec } from "./types.js";

export type { SemanticPluginRuntime, SemanticPluginSpec } from "./types.js";

export interface SemanticPluginRequest {
  semantic?: string;
  artifact: Artifact;
  installName: string;
  sourcePath: string;
  targetRoot: string;
  installationType: string;
}

export async function semanticPluginSpecForArtifact(request: SemanticPluginRequest): Promise<SemanticPluginSpec | undefined> {
  if (request.semantic === "openclaw-plugin") {
    return openClawPluginSpec({
      path: request.sourcePath,
      format: request.artifact.format,
      fallbackPluginName: request.installName,
    });
  }
  if (request.semantic === "claude-plugin") {
    return claudePluginSpec(request);
  }
  if (request.semantic === "codex-plugin") {
    return codexPluginSpec(request);
  }
  if (request.semantic === "copilot-plugin") {
    return copilotPluginSpec(request);
  }
  if (request.semantic === "hermes-plugin") {
    return hermesPluginSpec(request);
  }
  return undefined;
}
