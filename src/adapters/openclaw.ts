import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: { enabled: true, dest: ".openclaw/AGENTS.md" },
    rules: { enabled: true, dest: ".openclaw/rules" },
    skills: { enabled: true, dest: ".openclaw/skills" },
    commands: { enabled: true, dest: ".openclaw/commands" },
    mcp: { enabled: true, dest: ".openclaw/mcp", merge: "json-deep" },
    hooks: { enabled: true, dest: ".openclaw/hooks", merge: "json-deep" },
    settings: { enabled: true, dest: ".openclaw/settings.json", merge: "json-deep" },
    plugins: { enabled: true, dest: ".openclaw/plugins", semantic: "openclaw-plugin" },
  },
};
