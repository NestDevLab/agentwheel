import type { AdapterConfig } from "../model/adapter.js";

export const claudeAdapter: AdapterConfig = {
  name: "claude",
  displayName: "Claude Code",
  targets: {
    instructions: { enabled: true, dest: ".claude/CLAUDE.md" },
    rules: { enabled: true, dest: ".claude/rules" },
    skills: { enabled: true, dest: ".claude/skills" },
    commands: { enabled: true, dest: ".claude/commands" },
    subagents: { enabled: true, dest: ".claude/agents" },
    mcp: { enabled: true, dest: ".claude/.mcp.json", merge: "json-deep" },
    hooks: { enabled: true, dest: ".claude/settings.json", merge: "json-deep" },
    settings: { enabled: true, dest: ".claude/settings.json", merge: "json-deep" },
  },
};
