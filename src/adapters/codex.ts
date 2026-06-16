import type { AdapterConfig } from "../model/adapter.js";

export const codexAdapter: AdapterConfig = {
  name: "codex",
  displayName: "Codex CLI",
  targets: {
    instructions: {
      local: { enabled: true, dest: "AGENTS.md" },
      user: { enabled: true, root: "home", dest: ".codex/AGENTS.md" },
    },
    rules: {
      local: { enabled: true, dest: ".codex/rules" },
      user: { enabled: true, root: "home", dest: ".codex/rules" },
    },
    skills: {
      local: { enabled: true, dest: ".agents/skills" },
      user: { enabled: true, root: "home", dest: ".agents/skills" },
    },
    mcp: {
      local: { enabled: true, dest: ".codex/config.toml", merge: "codex-toml-mcp" },
      user: { enabled: true, root: "home", dest: ".codex/config.toml", merge: "codex-toml-mcp" },
    },
    hooks: {
      local: { enabled: true, dest: ".codex/hooks.json", merge: "json-deep" },
      user: { enabled: true, root: "home", dest: ".codex/hooks.json", merge: "json-deep" },
    },
  },
};
