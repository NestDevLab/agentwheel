import type { AdapterConfig } from "../model/adapter.js";

export const copilotAdapter: AdapterConfig = {
  name: "copilot",
  displayName: "GitHub Copilot",
  targets: {
    instructions: { enabled: true, dest: ".github/copilot-instructions.md" },
    rules: { enabled: true, dest: ".github/instructions" },
    commands: { enabled: true, dest: ".github/prompts" },
    skills: { enabled: true, dest: ".github/skills" },
  },
};
