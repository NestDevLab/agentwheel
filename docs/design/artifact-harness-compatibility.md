# Artifact Harness Compatibility

This matrix records documented file targets for Agentwheel built-in harnesses. Agentwheel should
install only `supported-native` targets by default. `documented-alternative` paths are real, but
not the default target because they are shared or less harness-specific. `requires-config` means a
manual or semantic config step is needed. `mapped-as-instructions` means Agentwheel writes a
documented instruction artifact because the harness has no native rule concept. `custom-adapter-only`
means the built-in adapter must reject the combination, but a user-provided adapter may define it.
`agentwheel-internal` means the artifact is consumed by Agentwheel itself rather than installed into
a runtime. `unsupported` means Agentwheel must reject the combination instead of silently writing an
inferred path.

## Status Values

| Status | Meaning |
|---|---|
| `supported-native` | Agentwheel installs this artifact for the given harness and installation type. |
| `documented-alternative` | The harness documents the path, but Agentwheel does not use it as the default native target. |
| `mapped-as-instructions` | Agentwheel maps the OpenPack artifact to documented instruction files; semantics are instructions, not runtime-native rules. |
| `custom-adapter-only` | No documented built-in file-drop target exists; users can add an explicit adapter config/module if their runtime supports one. |
| `requires-config` | Possible only with extra harness config or a semantic command, not plain file-drop. |
| `agentwheel-internal` | OpenPack composition-only artifact; Agentwheel reads it while resolving packages, but does not install it into harness folders. |
| `unsupported` | Not documented as an auto-discovered file target; install planning should fail. |

## Rules Semantics

| Harness | Agentwheel artifact | Native concept | Status | Semantics |
|---|---|---|---|---|
| Codex | `rules` | Rules files | `supported-native` | Command execution policy in `.rules` files, using decisions such as `allow`, `prompt`, and `forbidden`. These are not coding-style instructions. |
| Claude Code | `rules` | Rules files | `supported-native` | Behavioral instructions, optionally path-scoped with frontmatter such as `paths`. |
| GitHub Copilot CLI | `rules` | Custom instructions | `mapped-as-instructions` | Agentwheel writes `.github/instructions/*.instructions.md` or `~/.copilot/instructions/*.instructions.md`; these are instructions, not command policy. |
| OpenClaw | `rules` | None documented | `custom-adapter-only` | Built-in installs reject rules unless a custom adapter explicitly defines a target. |
| Hermes | `rules` | None documented | `custom-adapter-only` | Built-in installs reject rules unless a custom adapter explicitly defines a target. |

## Built-In Matrix

| Harness | Artifact | `local` | `user` | Notes |
|---|---|---|---|---|
| Codex | `instructions` | `supported-native`: `AGENTS.md` | `supported-native`: `~/.codex/AGENTS.md` | Project/user custom instructions. |
| Codex | `skills` | `supported-native`: `.agents/skills/<name>/SKILL.md` | `supported-native`: `~/.agents/skills/<name>/SKILL.md` | `.codex/skills` is not a portable documented target. |
| Codex | `rules` | `supported-native`: `.codex/rules/*.rules` | `supported-native`: `~/.codex/rules/*.rules` | Command permission policy, not behavior instructions. |
| Codex | `mcp` | `supported-native`: `.codex/config.toml` | `supported-native`: `~/.codex/config.toml` | Merged into `[mcp_servers]`. |
| Codex | `hooks` | `supported-native`: `.codex/hooks.json` | `supported-native`: `~/.codex/hooks.json` | Project config must be trusted. |
| Codex | `commands` | `unsupported` | `unsupported` | Custom prompts are deprecated; use skills. |
| Codex | `subagents` | `supported-native`: `.codex/agents/*.toml` | `supported-native`: `~/.codex/agents/*.toml` | TOML custom agent definitions. Markdown OpenPack subagents are rendered to TOML. |
| Codex | `settings` | `unsupported` | `unsupported` | Use `config.toml`-backed artifacts instead of generic JSON settings. |
| Claude Code | `instructions` | `supported-native`: `CLAUDE.md` | `supported-native`: `~/.claude/CLAUDE.md` | Root project instructions are not `.claude/CLAUDE.md`. |
| Claude Code | `skills` | `supported-native`: `.claude/skills/<name>/SKILL.md` | `supported-native`: `~/.claude/skills/<name>/SKILL.md` | Native skill directories. |
| Claude Code | `rules` | `supported-native`: `.claude/rules/*.md` | `supported-native`: `~/.claude/rules/*.md` | Behavioral/path-scoped instructions. |
| Claude Code | `commands` | `supported-native`: `.claude/commands/*.md` | `supported-native`: `~/.claude/commands/*.md` | Legacy-compatible command prompts. |
| Claude Code | `subagents` | `supported-native`: `.claude/agents/*.md` | `supported-native`: `~/.claude/agents/*.md` | Markdown subagent definitions. |
| Claude Code | `mcp` | `supported-native`: `.mcp.json` | `unsupported` | Project-shared MCP file lives at repo root. |
| Claude Code | `hooks` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Hooks are settings entries. |
| Claude Code | `settings` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Deep-merged JSON settings. |
| GitHub Copilot CLI | `instructions` | `supported-native`: `.github/copilot-instructions.md` | `supported-native`: `~/.copilot/copilot-instructions.md` | Repo-wide or personal instructions. |
| GitHub Copilot CLI | `rules` | `mapped-as-instructions`: `.github/instructions/*.instructions.md` | `mapped-as-instructions`: `~/.copilot/instructions/*.instructions.md` | Custom instructions, not command rules. |
| GitHub Copilot CLI | `commands` | `supported-native`: `.github/prompts/*.prompt.md` | `unsupported` | Prompt files. |
| GitHub Copilot CLI | `skills` | `supported-native`: `.github/skills/<name>/SKILL.md` | `supported-native`: `~/.copilot/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| GitHub Copilot CLI | `subagents` | `supported-native`: `.github/agents/*.agent.md` | `supported-native`: `~/.copilot/agents/*.agent.md` | Custom agents for Copilot CLI/coding agent. |
| GitHub Copilot CLI | `mcp` | `supported-native`: `.github/mcp.json` | `supported-native`: `~/.copilot/mcp-config.json` | `.mcp.json` is a documented project alternative; `.vscode/mcp.json` is not Agentwheel's Copilot CLI target. |
| GitHub Copilot CLI | `hooks` | `supported-native`: `.github/hooks/*.json` | `supported-native`: `~/.copilot/hooks/*.json` | Shell-command lifecycle hooks for Copilot agent execution. |
| GitHub Copilot CLI | `settings` | `custom-adapter-only` | `custom-adapter-only`: `~/.copilot/settings.json` exists | User settings exist, but Agentwheel does not install generic settings by default. |
| OpenClaw | `skills` | `supported-native`: `skills/<name>/SKILL.md` | `supported-native`: `~/.openclaw/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| OpenClaw | `skills` | `documented-alternative`: `.agents/skills/<name>/SKILL.md` | `documented-alternative`: `~/.agents/skills/<name>/SKILL.md` | Shared agent skill location. |
| OpenClaw | `rules` | `custom-adapter-only` | `custom-adapter-only` | No built-in file-drop target is documented for runtime-native rules. |
| OpenClaw | `plugins` | `requires-config`: semantic plugin install | `unsupported` | Local plugins are not treated as plain file-drop; user-level plugin install is not built into the adapter. |
| OpenClaw | other artifacts | `unsupported` | `unsupported` | Add only after official file-drop docs are confirmed. |
| Hermes | `instructions` | `supported-native`: `AGENTS.md` | `unsupported` | Hermes also detects `.hermes.md`, `HERMES.md`, and `CLAUDE.md`; Agentwheel writes `AGENTS.md`. |
| Hermes | `skills` | `unsupported` | `supported-native`: `~/.hermes/skills/<name>/SKILL.md` | Local skills require configured external dirs, so they are not file-drop supported. |
| Hermes | `rules` | `custom-adapter-only` | `custom-adapter-only` | No built-in file-drop target is documented for runtime-native rules. |
| Hermes | other artifacts | `unsupported` | `unsupported` | Plugins/hooks/MCP require Hermes-specific config or plugin packaging. |
| All built-ins | `fragments` | `agentwheel-internal` | `agentwheel-internal` | Fragments compose other artifacts during resolution; they are never runtime file-drop targets. |

## Audit Notes

- Codex custom prompts are documented but deprecated, user-home only, and superseded by skills; the built-in adapter rejects OpenPack `commands`.
- GitHub Copilot CLI MCP is not mapped to `.vscode/mcp.json`; Agentwheel uses `.github/mcp.json` locally and `~/.copilot/mcp-config.json` for user installs.
- GitHub Copilot CLI hooks are lifecycle shell-command hooks, stored as JSON files under `.github/hooks/` or `~/.copilot/hooks/`.
- Copilot rule-like artifacts are custom instructions. They do not provide command execution policy like Codex rules.
- Copilot rules, commands, and subagents are normalized to native suffixes: `.instructions.md`, `.prompt.md`, and `.agent.md`.
- Hermes local skills remain unsupported by default because local/project discovery requires configured `external_dirs`; user skills install to `~/.hermes/skills`.
- OpenPack `fragments` are Agentwheel composition inputs, not runtime-native artifacts. They should not appear as supported harness file targets.

## Sources

- [OpenAI Codex docs](https://developers.openai.com/codex/)
- [OpenAI Codex rules](https://developers.openai.com/codex/rules)
- [OpenAI Codex subagents](https://developers.openai.com/codex/subagents)
- [Claude directory](https://code.claude.com/docs/en/claude-directory)
- [Claude memory and rules](https://code.claude.com/docs/en/memory)
- [Claude skills](https://code.claude.com/docs/en/skills)
- [GitHub Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [GitHub Copilot instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [GitHub Copilot CLI custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [GitHub Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [GitHub Copilot CLI hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [GitHub Copilot CLI config directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [GitHub Copilot custom instructions support](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [OpenClaw skills](https://docs.openclaw.ai/tools/skills)
- [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
