import type { AdapterConfig } from "../model/adapter.js";
import { claudeAdapter } from "./claude.js";
import { copilotAdapter } from "./copilot.js";
import { codexAdapter } from "./codex.js";
import { hermesAdapter } from "./hermes.js";
import { openClawAdapter } from "./openclaw.js";

const adapters = [openClawAdapter, claudeAdapter, codexAdapter, hermesAdapter, copilotAdapter];

export function getAdapter(name: string): AdapterConfig {
  const adapter = adapters.find((candidate) => candidate.name === name);
  if (!adapter) {
    throw new Error(`Unknown adapter: ${name}`);
  }
  return adapter;
}

export function listAdapters(): AdapterConfig[] {
  return [...adapters];
}
