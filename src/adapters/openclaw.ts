import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: {
      user: { enabled: true, root: "home", dest: ".openclaw/workspace/AGENTS.md", mode: "managed-block" },
    },
    skills: {
      local: { enabled: true, dest: "skills" },
      user: { enabled: true, root: "home", dest: ".openclaw/skills" },
    },
    subagents: {
      user: { enabled: true, root: "home", dest: ".openclaw/workspace-subagents", semantic: "openclaw-subagent" },
    },
    mcp: {
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "openclaw-json-deep" },
    },
    settings: {
      user: { enabled: true, root: "home", dest: ".openclaw/openclaw.json", merge: "openclaw-json-deep" },
    },
    plugins: {
      local: { enabled: true, dest: ".openclaw/plugins", formats: ["openclaw-plugin", "openclaw-clawhub-plugin"], semantic: "openclaw-plugin" },
    },
  },
};
