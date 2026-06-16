# Artifact Harness Compatibility

This matrix records documented file targets for Agentwheel built-in harnesses. Agentwheel should
install only `supported-native` targets by default. `documented-alternative` paths are real, but
not the default target because they are shared or less harness-specific. `requires-config` means a
manual or semantic config step is needed. `unsupported` means Agentwheel must reject the
combination instead of silently writing an inferred path.

## Status Values

| Status | Meaning |
|---|---|
| `supported-native` | Agentwheel installs this artifact for the given harness and installation type. |
| `documented-alternative` | The harness documents the path, but Agentwheel does not use it as the default native target. |
| `requires-config` | Possible only with extra harness config or a semantic command, not plain file-drop. |
| `unsupported` | Not documented as an auto-discovered file target; install planning should fail. |

## Rules Semantics

| Harness | Agentwheel artifact | Semantics |
|---|---|---|
| Codex | `rules` | Command execution policy in `.rules` files, using decisions such as `allow`, `prompt`, and `forbidden`. These are not coding-style instructions. |
| Claude Code | `rules` | Behavioral instructions, optionally path-scoped with frontmatter such as `paths`. |
| GitHub Copilot | `rules` | Mapped to path-specific custom instructions under `.github/instructions/*.instructions.md`; these are instructions, not command policy. |
| OpenClaw | `rules` | `unsupported` until a documented auto-discovered file target is confirmed. |
| Hermes | `rules` | `unsupported` until a documented auto-discovered file target is confirmed. |

## Built-In Matrix

| Harness | Artifact | `local` | `user` | Notes |
|---|---|---|---|---|
| Codex | `instructions` | `supported-native`: `AGENTS.md` | `supported-native`: `~/.codex/AGENTS.md` | Project/user custom instructions. |
| Codex | `skills` | `supported-native`: `.agents/skills/<name>/SKILL.md` | `supported-native`: `~/.agents/skills/<name>/SKILL.md` | `.codex/skills` is not a portable documented target. |
| Codex | `rules` | `supported-native`: `.codex/rules/*.rules` | `supported-native`: `~/.codex/rules/*.rules` | Command permission policy, not behavior instructions. |
| Codex | `mcp` | `supported-native`: `.codex/config.toml` | `supported-native`: `~/.codex/config.toml` | Merged into `[mcp_servers]`. |
| Codex | `hooks` | `supported-native`: `.codex/hooks.json` | `supported-native`: `~/.codex/hooks.json` | Project config must be trusted. |
| Codex | `commands` | `unsupported` | `unsupported` | Custom prompts are deprecated; use skills. |
| Codex | `subagents` | `unsupported` | `unsupported` | Codex subagents are config-driven, not `.codex/agents` file-drop. |
| Codex | `settings` | `unsupported` | `unsupported` | Use `config.toml`-backed artifacts instead of generic JSON settings. |
| Claude Code | `instructions` | `supported-native`: `CLAUDE.md` | `supported-native`: `~/.claude/CLAUDE.md` | Root project instructions are not `.claude/CLAUDE.md`. |
| Claude Code | `skills` | `supported-native`: `.claude/skills/<name>/SKILL.md` | `supported-native`: `~/.claude/skills/<name>/SKILL.md` | Native skill directories. |
| Claude Code | `rules` | `supported-native`: `.claude/rules/*.md` | `supported-native`: `~/.claude/rules/*.md` | Behavioral/path-scoped instructions. |
| Claude Code | `commands` | `supported-native`: `.claude/commands/*.md` | `supported-native`: `~/.claude/commands/*.md` | Legacy-compatible command prompts. |
| Claude Code | `subagents` | `supported-native`: `.claude/agents/*.md` | `supported-native`: `~/.claude/agents/*.md` | Markdown subagent definitions. |
| Claude Code | `mcp` | `supported-native`: `.mcp.json` | `unsupported` | Project-shared MCP file lives at repo root. |
| Claude Code | `hooks` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Hooks are settings entries. |
| Claude Code | `settings` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Deep-merged JSON settings. |
| GitHub Copilot | `instructions` | `supported-native`: `.github/copilot-instructions.md` | `supported-native`: `~/.copilot/copilot-instructions.md` | Repo-wide or personal instructions. |
| GitHub Copilot | `rules` | `supported-native`: `.github/instructions/*.instructions.md` | `unsupported` | Path-specific instructions, not command rules. |
| GitHub Copilot | `commands` | `supported-native`: `.github/prompts/*.prompt.md` | `unsupported` | Prompt files. |
| GitHub Copilot | `skills` | `supported-native`: `.github/skills/<name>/SKILL.md` | `supported-native`: `~/.copilot/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| GitHub Copilot | `subagents` | `supported-native`: `.github/agents/*.agent.md` | `unsupported` | Custom agents for Copilot coding agent. |
| GitHub Copilot | `mcp` | `supported-native`: `.vscode/mcp.json` | `unsupported` | Workspace MCP config. |
| OpenClaw | `skills` | `supported-native`: `skills/<name>/SKILL.md` | `supported-native`: `~/.openclaw/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| OpenClaw | `skills` | `documented-alternative`: `.agents/skills/<name>/SKILL.md` | `documented-alternative`: `~/.agents/skills/<name>/SKILL.md` | Shared agent skill location. |
| OpenClaw | `plugins` | `requires-config`: semantic plugin install | `requires-config` | Not treated as plain file-drop. |
| OpenClaw | other artifacts | `unsupported` | `unsupported` | Add only after official file-drop docs are confirmed. |
| Hermes | `instructions` | `supported-native`: `AGENTS.md` | `unsupported` | Hermes also detects `.hermes.md`, `HERMES.md`, and `CLAUDE.md`; Agentwheel writes `AGENTS.md`. |
| Hermes | `skills` | `unsupported` | `supported-native`: `~/.hermes/skills/<name>/SKILL.md` | Local skills require configured external dirs, so they are not file-drop supported. |
| Hermes | other artifacts | `unsupported` | `unsupported` | Plugins/hooks/MCP require Hermes-specific config or plugin packaging. |

## Sources

- [OpenAI Codex docs](https://developers.openai.com/codex/)
- [Claude directory](https://code.claude.com/docs/en/claude-directory)
- [Claude skills](https://code.claude.com/docs/en/skills)
- [GitHub Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [GitHub Copilot instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [OpenClaw skills](https://docs.openclaw.ai/tools/skills)
- [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
