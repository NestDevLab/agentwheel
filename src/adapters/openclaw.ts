import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: { enabled: true, dest: ".openclaw/AGENTS.md" },
    rules: { enabled: true, dest: ".openclaw/rules" },
    skills: { enabled: true, dest: ".openclaw/skills" },
    commands: { enabled: true, dest: ".openclaw/commands" },
    mcp: { enabled: true, dest: ".openclaw/mcp" },
    hooks: { enabled: true, dest: ".openclaw/hooks" },
    plugins: { enabled: true, dest: ".openclaw/plugins", semantic: "openclaw-plugin" },
  },
};
