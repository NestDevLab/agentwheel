import type { AdapterConfig } from "../model/adapter.js";

export const copilotAdapter: AdapterConfig = {
  name: "copilot",
  displayName: "GitHub Copilot CLI",
  targets: {
    instructions: {
      local: { enabled: true, dest: ".github/copilot-instructions.md" },
      user: { enabled: true, root: "home", dest: ".copilot/copilot-instructions.md" },
    },
    rules: {
      local: { enabled: true, dest: ".github/instructions", formats: ["markdown-rule", "copilot-instruction-rule"], semantic: "copilot-instruction" },
      user: { enabled: true, root: "home", dest: ".copilot/instructions", formats: ["markdown-rule", "copilot-instruction-rule"], semantic: "copilot-instruction" },
    },
    commands: {
      local: { enabled: true, dest: ".github/prompts", semantic: "copilot-prompt" },
    },
    skills: {
      local: { enabled: true, dest: ".github/skills" },
      user: { enabled: true, root: "home", dest: ".copilot/skills" },
    },
    plugins: {
      local: { enabled: true, dest: ".github/plugins", semantic: "copilot-plugin" },
      user: { enabled: true, root: "home", dest: ".copilot/plugins", semantic: "copilot-plugin" },
    },
    subagents: {
      local: { enabled: true, dest: ".github/agents", semantic: "copilot-agent" },
      user: { enabled: true, root: "home", dest: ".copilot/agents", semantic: "copilot-agent" },
    },
    mcp: {
      local: { enabled: true, dest: ".github/mcp.json", merge: "json-deep" },
      user: { enabled: true, root: "home", dest: ".copilot/mcp-config.json", merge: "json-deep" },
    },
    hooks: {
      local: { enabled: true, dest: ".github/hooks" },
      user: { enabled: true, root: "home", dest: ".copilot/hooks" },
    },
    settings: {
      local: { enabled: true, dest: ".github/settings.json", merge: "json-deep" },
      user: { enabled: true, root: "home", dest: ".copilot/settings.json", merge: "json-deep" },
    },
  },
};
