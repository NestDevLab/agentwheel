import type { AdapterConfig } from "../model/adapter.js";

export const hermesAdapter: AdapterConfig = {
  name: "hermes",
  displayName: "Hermes",
  targets: {
    instructions: { enabled: true, dest: ".hermes/AGENTS.md" },
    rules: { enabled: true, dest: ".hermes/rules" },
    skills: { enabled: true, dest: ".hermes/skills" },
    commands: { enabled: true, dest: ".hermes/commands" },
    mcp: { enabled: true, dest: ".hermes/mcp" },
    hooks: { enabled: true, dest: ".hermes/hooks" },
  },
};
