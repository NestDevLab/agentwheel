import type { AdapterConfig } from "../model/adapter.js";

export const claudeAdapter: AdapterConfig = {
  name: "claude",
  displayName: "Claude Code",
  targets: {
    instructions: {
      local: { enabled: true, dest: "CLAUDE.md", mode: "managed-block" },
      user: { enabled: true, root: "home", dest: ".claude/CLAUDE.md", mode: "managed-block" },
    },
    rules: {
      local: { enabled: true, dest: ".claude/rules", formats: ["markdown-rule", "claude-markdown-rule"] },
      user: { enabled: true, root: "home", dest: ".claude/rules", formats: ["markdown-rule", "claude-markdown-rule"] },
    },
    skills: {
      local: { enabled: true, dest: ".claude/skills" },
      user: { enabled: true, root: "home", dest: ".claude/skills" },
    },
    commands: {
      local: { enabled: true, dest: ".claude/commands" },
      user: { enabled: true, root: "home", dest: ".claude/commands" },
    },
    subagents: {
      local: { enabled: true, dest: ".claude/agents" },
      user: { enabled: true, root: "home", dest: ".claude/agents" },
    },
    plugins: {
      local: { enabled: true, dest: ".claude/plugins", semantic: "claude-plugin" },
      user: { enabled: true, root: "home", dest: ".claude/plugins", semantic: "claude-plugin" },
    },
    mcp: {
      local: { enabled: true, dest: ".mcp.json", merge: "json-deep" },
    },
    hooks: {
      local: { enabled: true, dest: ".claude/settings.json", merge: "json-deep" },
      user: { enabled: true, root: "home", dest: ".claude/settings.json", merge: "json-deep" },
    },
    settings: {
      local: { enabled: true, dest: ".claude/settings.json", merge: "json-deep" },
      user: { enabled: true, root: "home", dest: ".claude/settings.json", merge: "json-deep" },
    },
  },
};
