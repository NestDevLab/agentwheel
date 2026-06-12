import type { AdapterConfig } from "../model/adapter.js";

export const hermesAdapter: AdapterConfig = {
  name: "hermes",
  displayName: "Hermes",
  targets: {
    instructions: { enabled: true, dest: ".hermes/AGENTS.md" },
    rules: { enabled: true, dest: ".hermes/rules" },
    skills: { enabled: true, dest: ".hermes/skills" },
    commands: { enabled: true, dest: ".hermes/commands" },
    subagents: { enabled: true, dest: ".hermes/agents" },
    mcp: { enabled: true, dest: ".hermes/mcp", merge: "json-deep" },
    hooks: { enabled: true, dest: ".hermes/hooks", merge: "json-deep" },
    settings: { enabled: true, dest: ".hermes/settings.json", merge: "json-deep" },
  },
};
