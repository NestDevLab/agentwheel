import type { AdapterConfig } from "../model/adapter.js";

export const hermesAdapter: AdapterConfig = {
  name: "hermes",
  displayName: "Hermes",
  targets: {
    instructions: {
      local: { enabled: true, dest: "AGENTS.md" },
      user: { enabled: true, root: "home", dest: ".hermes/SOUL.md" },
    },
    skills: {
      user: { enabled: true, root: "home", dest: ".hermes/skills" },
    },
    mcp: {
      user: { enabled: true, root: "home", dest: ".hermes/config.yaml", merge: "yaml-deep" },
    },
    settings: {
      user: { enabled: true, root: "home", dest: ".hermes/config.yaml", merge: "yaml-deep" },
    },
    plugins: {
      user: { enabled: true, root: "home", dest: ".hermes/plugins", semantic: "hermes-plugin" },
    },
  },
};
