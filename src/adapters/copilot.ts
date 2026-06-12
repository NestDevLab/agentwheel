import type { AdapterConfig } from "../model/adapter.js";

export const copilotAdapter: AdapterConfig = {
  name: "copilot",
  displayName: "GitHub Copilot",
  targets: {
    instructions: { enabled: true, dest: ".github/copilot-instructions.md" },
    rules: { enabled: true, dest: ".github/instructions" },
    commands: { enabled: true, dest: ".github/prompts" },
    skills: { enabled: true, dest: ".github/skills" },
    subagents: { enabled: true, dest: ".github/agents" },
    mcp: { enabled: true, dest: ".vscode/mcp.json", merge: "json-deep" },
  },
};
