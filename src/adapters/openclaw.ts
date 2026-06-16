import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    skills: {
      local: { enabled: true, dest: "skills" },
      user: { enabled: true, root: "home", dest: ".openclaw/skills" },
    },
    plugins: {
      local: { enabled: true, dest: ".openclaw/plugins", semantic: "openclaw-plugin" },
    },
  },
};
