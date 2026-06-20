import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: {
      user: { enabled: true, root: "home", dest: ".openclaw/workspace/AGENTS.md" },
    },
    skills: {
      local: { enabled: true, dest: "skills" },
      user: { enabled: true, root: "home", dest: ".openclaw/skills" },
    },
    mcp: {
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "json-deep" },
    },
    settings: {
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "json-deep" },
    },
    plugins: {
      local: { enabled: true, dest: ".openclaw/plugins", formats: ["openclaw-plugin"], semantic: "openclaw-plugin" },
    },
  },
};
