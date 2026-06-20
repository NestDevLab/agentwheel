import type { AdapterConfig } from "../model/adapter.js";

export const hermesAdapter: AdapterConfig = {
  name: "hermes",
  displayName: "Hermes",
  targets: {
    instructions: {
      local: { enabled: true, dest: "AGENTS.md", mode: "managed-block" },
      // Hermes documents SOUL.md as the user-level instruction surface.
      user: { enabled: true, root: "home", dest: ".hermes/SOUL.md", mode: "managed-block" },
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
