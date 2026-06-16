import type { AdapterConfig } from "../model/adapter.js";

export const hermesAdapter: AdapterConfig = {
  name: "hermes",
  displayName: "Hermes",
  targets: {
    instructions: {
      local: { enabled: true, dest: "AGENTS.md" },
    },
    skills: {
      user: { enabled: true, root: "home", dest: ".hermes/skills" },
    },
  },
};
