import type { AdapterConfig } from "../model/adapter.js";

export const openClawAdapter: AdapterConfig = {
  name: "openclaw",
  displayName: "OpenClaw",
  targets: {
    instructions: { enabled: true, dest: ".openclaw/AGENTS.md" },
    rules: { enabled: true, dest: ".openclaw/rules" },
    skills: { enabled: true, dest: ".openclaw/skills" },
  },
};

