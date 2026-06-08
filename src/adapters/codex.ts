import type { AdapterConfig } from "../model/adapter.js";

export const codexAdapter: AdapterConfig = {
  name: "codex",
  displayName: "Codex CLI",
  targets: {
    instructions: { enabled: true, dest: ".codex/AGENTS.md" },
    rules: { enabled: true, dest: ".codex/rules" },
    skills: { enabled: true, dest: ".codex/skills" },
    commands: { enabled: true, dest: ".codex/commands" },
    subagents: { enabled: true, dest: ".codex/agents" },
    mcp: { enabled: true, dest: ".codex/config.toml", merge: "codex-toml-mcp" },
    hooks: { enabled: true, dest: ".codex/hooks.json", merge: "json-deep" },
    settings: { enabled: true, dest: ".codex/settings.json", merge: "json-deep" },
  },
};
