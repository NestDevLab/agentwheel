import type { AdapterConfig } from "../model/adapter.js";

export const copilotAdapter: AdapterConfig = {
  name: "copilot",
  displayName: "GitHub Copilot",
  targets: {
    instructions: {
      local: { enabled: true, dest: ".github/copilot-instructions.md" },
      user: { enabled: true, root: "home", dest: ".copilot/copilot-instructions.md" },
    },
    rules: {
      local: { enabled: true, dest: ".github/instructions" },
    },
    commands: {
      local: { enabled: true, dest: ".github/prompts" },
    },
    skills: {
      local: { enabled: true, dest: ".github/skills" },
      user: { enabled: true, root: "home", dest: ".copilot/skills" },
    },
    subagents: {
      local: { enabled: true, dest: ".github/agents" },
    },
    mcp: {
      local: { enabled: true, dest: ".vscode/mcp.json", merge: "json-deep" },
    },
  },
};
