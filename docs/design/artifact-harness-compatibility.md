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
| Codex | `rules` | Command policy `.rules` files | `unsupported` | Codex command-policy files are not the OpenPack behavioral `rules` artifact. The built-in Codex adapter rejects `rules`; use custom packaging only when explicitly targeting Codex command policy. |
| Claude Code | `rules` | Rules files | `supported-native` | Behavioral instructions, optionally path-scoped with frontmatter such as `paths`. |
| GitHub Copilot CLI | `rules` | Custom instructions | `mapped-as-instructions` | Agentwheel writes `.github/instructions/*.instructions.md` or `~/.copilot/instructions/*.instructions.md`; these are instructions, not command policy. |
| OpenClaw | `rules` | None documented | `custom-adapter-only` | Built-in installs reject rules unless a custom adapter explicitly defines a target. |
| Hermes | `rules` | None documented | `custom-adapter-only` | Built-in installs reject rules unless a custom adapter explicitly defines a target. |

Built-in adapters also validate concrete artifact formats before install planning. For example,
Claude `rules` accept Markdown rule formats, Copilot rule artifacts render as instruction Markdown,
and plugin targets require harness-specific plugin format/semantic values such as `openclaw-plugin`,
`openclaw-clawhub-plugin`, `claude-plugin`, `codex-plugin`, `copilot-plugin`, or `hermes-plugin`.
OpenPack behavioral `rules` do not map to Codex `.codex/rules` command policy in the built-in
adapter. Invalid or unknown formats fail the package plan before runtime files are written.

## Instructions Delivery

Built-in instruction targets are delivered as managed blocks inside the harness-native instruction
file. Agentwheel reuses `<!-- BEGIN openpack:include ... sha256:... -->` and matching `END` markers,
adds an advisory banner inside the block, and tracks the block hash rather than owning the entire
file. Uninstall removes only the managed block.

If the target instruction file already exists but is unmanaged, install planning raises an adoption
conflict and requires explicit adoption/force flags. This is intentionally conservative even though
the eventual write is a non-destructive append/update of a delimited block.

Claude local instructions are bridge-aware: when `CLAUDE.md` imports or symlinks to `AGENTS.md`,
Agentwheel skips writing `CLAUDE.md` because Claude already sees the `AGENTS.md` block. When
`CLAUDE.md` and `AGENTS.md` are separate files, Agentwheel warns that Copilot may double-read the
content. Known limitation: this warning currently fires only from the Claude/`CLAUDE.md` planning
path, not from the inverse Codex/Copilot path.

## Built-In Matrix

| Harness | Artifact | `local` | `user` | Notes |
|---|---|---|---|---|
| Codex | `instructions` | `supported-native`: `AGENTS.md` managed block | `supported-native`: `~/.codex/AGENTS.md` managed block | Project/user custom instructions. |
| Codex | `skills` | `supported-native`: `.agents/skills/<name>/SKILL.md` | `supported-native`: `~/.agents/skills/<name>/SKILL.md` | `.codex/skills` is not a portable documented target. |
| Codex | `plugins` | `requires-config`: generated local marketplace under `.agentwheel/plugins/codex/...` plus `codex plugin marketplace add` and `codex plugin add` | `requires-config`: generated local marketplace under `~/.agentwheel/plugins/codex/...` plus `codex plugin marketplace add` and `codex plugin add` | Semantic install; no runtime plugin directory copy is planned. |
| Codex | `rules` | `unsupported` | `unsupported` | OpenPack `rules` are behavioral; Codex `.rules` command policy is intentionally out of scope for the built-in adapter. |
| Codex | `mcp` | `supported-native`: `.codex/config.toml` | `supported-native`: `~/.codex/config.toml` | Merged into `[mcp_servers]`. |
| Codex | `hooks` | `supported-native`: `.codex/hooks.json` | `supported-native`: `~/.codex/hooks.json` | Project config must be trusted. |
| Codex | `commands` | `unsupported` | `unsupported` | Custom prompts are deprecated; use skills. |
| Codex | `subagents` | `supported-native`: `.codex/agents/*.toml` | `supported-native`: `~/.codex/agents/*.toml` | TOML custom agent definitions. Markdown OpenPack subagents are rendered to TOML. |
| Codex | `settings` | `planned` | `planned` | Planned: a TOML-deep settings merger is intended for `config.toml`; not yet implemented. |
| Claude Code | `instructions` | `supported-native`: `CLAUDE.md` managed block | `supported-native`: `~/.claude/CLAUDE.md` managed block | Root project instructions are not `.claude/CLAUDE.md`; local writes are skipped when Claude already bridges `AGENTS.md`. |
| Claude Code | `skills` | `supported-native`: `.claude/skills/<name>/SKILL.md` | `supported-native`: `~/.claude/skills/<name>/SKILL.md` | Native skill directories. |
| Claude Code | `plugins` | `requires-config`: generated local marketplace under `.agentwheel/plugins/claude/...` plus `claude plugin marketplace add --scope local` and `claude plugin install --scope local` | `requires-config`: generated local marketplace under `~/.agentwheel/plugins/claude/...` plus `claude plugin marketplace add --scope user` and `claude plugin install --scope user` | Semantic install; no `.claude/plugins` directory copy is planned. |
| Claude Code | `rules` | `supported-native`: `.claude/rules/*.md` | `supported-native`: `~/.claude/rules/*.md` | Behavioral/path-scoped instructions. |
| Claude Code | `commands` | `supported-native`: `.claude/commands/*.md` | `supported-native`: `~/.claude/commands/*.md` | Legacy-compatible command prompts. |
| Claude Code | `subagents` | `supported-native`: `.claude/agents/*.md` | `supported-native`: `~/.claude/agents/*.md` | Markdown subagent definitions. |
| Claude Code | `mcp` | `supported-native`: `.mcp.json` | `unsupported` | Project-shared MCP file lives at repo root. |
| Claude Code | `hooks` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Hooks are settings entries. |
| Claude Code | `settings` | `supported-native`: `.claude/settings.json` | `supported-native`: `~/.claude/settings.json` | Deep-merged JSON settings. |
| GitHub Copilot CLI | `instructions` | `supported-native`: `.github/copilot-instructions.md` managed block | `supported-native`: `~/.copilot/copilot-instructions.md` managed block | Repo-wide or personal instructions. |
| GitHub Copilot CLI | `rules` | `mapped-as-instructions`: `.github/instructions/*.instructions.md` | `mapped-as-instructions`: `~/.copilot/instructions/*.instructions.md` | Custom instructions, not command rules. |
| GitHub Copilot CLI | `commands` | `supported-native`: `.github/prompts/*.prompt.md` | `unsupported` | Prompt files. |
| GitHub Copilot CLI | `skills` | `supported-native`: `.github/skills/<name>/SKILL.md` | `supported-native`: `~/.copilot/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| GitHub Copilot CLI | `plugins` | `unsupported` | `requires-config`: staged local plugin under `~/.agentwheel/plugins/copilot/...` plus `copilot plugin install <path>` | Persistent plugin installs are user-level; local/project plugin dirs are inert. |
| GitHub Copilot CLI | `subagents` | `supported-native`: `.github/agents/*.agent.md` | `supported-native`: `~/.copilot/agents/*.agent.md` | Custom agents for Copilot CLI/coding agent. |
| GitHub Copilot CLI | `mcp` | `supported-native`: `.github/mcp.json` | `supported-native`: `~/.copilot/mcp-config.json` | `.mcp.json` is a documented project alternative; `.vscode/mcp.json` is not Agentwheel's Copilot CLI target. |
| GitHub Copilot CLI | `hooks` | `supported-native`: `.github/hooks/*.json` | `supported-native`: `~/.copilot/hooks/*.json` | Shell-command lifecycle hooks for Copilot agent execution. |
| GitHub Copilot CLI | `settings` | `supported-native`: `.github/settings.json` | `supported-native`: `~/.copilot/settings.json` | Deep-merged JSON settings. |
| OpenClaw | `instructions` | `unsupported` | `supported-native`: `~/.openclaw/workspace/AGENTS.md` managed block | OpenClaw workspace instructions are user-level only in the built-in adapter. |
| OpenClaw | `skills` | `supported-native`: `skills/<name>/SKILL.md` | `supported-native`: `~/.openclaw/skills/<name>/SKILL.md` | `.agents/skills` is documented alternative, not default. |
| OpenClaw | `skills` | `documented-alternative`: `.agents/skills/<name>/SKILL.md` | `documented-alternative`: `~/.agents/skills/<name>/SKILL.md` | Shared agent skill location. |
| OpenClaw | `rules` | `custom-adapter-only` | `custom-adapter-only` | No built-in file-drop target is documented for runtime-native rules. |
| OpenClaw | `subagents` | `unsupported` | `supported-native`: `~/.openclaw/workspace-subagents/<name>/AGENTS.md` plus `~/.openclaw/openclaw.json` | Agent instructions live in per-subagent workspaces; `agents.list[]` and `agents.defaults.subagents.allowAgents` are managed through config merge. |
| OpenClaw | `mcp` | `unsupported` | `supported-native`: `~/.openclaw/openclaw.json` | Deep-merged JSON under `mcp.servers.<name>`. |
| OpenClaw | `settings` | `unsupported` | `supported-native`: `~/.openclaw/openclaw.json` | Deep-merged JSON; `agents.list[]` is covered by settings config-merge. |
| OpenClaw | `plugins` | `requires-config`: semantic `openclaw plugins install --force <path>` or `openclaw plugins install --force clawhub:<name>` for ClawHub wrappers | `unsupported` | Local plugins are directory artifacts staged for CLI install; ClawHub wrappers are generated plugin artifacts. User-level plugin install is not built into the adapter. |
| OpenClaw | other artifacts | `unsupported` | `unsupported` | Add only after official file-drop or config docs are confirmed. |
| Hermes | `instructions` | `supported-native`: `AGENTS.md` managed block | `supported-native`: `~/.hermes/SOUL.md` managed block | Hermes also detects `.hermes.md`, `HERMES.md`, and `CLAUDE.md`; Agentwheel writes project `AGENTS.md` and user `SOUL.md`. |
| Hermes | `skills` | `unsupported` | `supported-native`: `~/.hermes/skills/<name>/SKILL.md` | Local skills require configured external dirs, so they are not file-drop supported. |
| Hermes | `rules` | `custom-adapter-only` | `custom-adapter-only` | No built-in file-drop target is documented for runtime-native rules. |
| Hermes | `mcp` | `unsupported` | `supported-native`: `~/.hermes/config.yaml` | Deep-merged YAML at top-level `mcp_servers:`. |
| Hermes | `settings` | `unsupported` | `supported-native`: `~/.hermes/config.yaml` | Deep-merged YAML, including `delegation:` and `mcp_servers:` keys. |
| Hermes | `plugins` | `unsupported` | `requires-config`: generated local git repo under `~/.agentwheel/plugins/hermes/...` plus `hermes plugins install --force --enable file://<repo>` | Semantic install; no `~/.hermes/plugins` directory copy is planned. |
| Hermes | other artifacts | `unsupported` | `unsupported` | Hooks and local skills require custom adapter/config support. |
| All built-ins | `fragments` | `agentwheel-internal` | `agentwheel-internal` | Fragments compose other artifacts during resolution; they are never runtime file-drop targets. |

## Audit Notes

- Codex custom prompts are documented but deprecated, user-home only, and superseded by skills; the built-in adapter rejects OpenPack `commands`.
- Codex `.codex/rules` command policy is not the behavioral OpenPack `rules` artifact and is not installed by the built-in adapter.
- GitHub Copilot CLI MCP is not mapped to `.vscode/mcp.json`; Agentwheel uses `.github/mcp.json` locally and `~/.copilot/mcp-config.json` for user installs.
- GitHub Copilot CLI hooks are lifecycle shell-command hooks, stored as JSON files under `.github/hooks/` or `~/.copilot/hooks/`.
- Copilot rule-like artifacts are custom instructions. They do not provide command execution policy like Codex rules.
- Copilot rules, commands, and subagents are normalized to native suffixes: `.instructions.md`, `.prompt.md`, and `.agent.md`.
- OpenClaw subagents require both a workspace directory and config registration. Agentwheel renders Markdown OpenPack subagents to `workspace-subagents/<name>/AGENTS.md`; fleet settings provide the `agents.list[]` entries and parent allowlist.
- OpenClaw, Claude, Codex, Copilot, and Hermes plugins are semantic operations. Agentwheel stages runtime-specific marketplaces, plugin directories, git shims, or generated ClawHub wrappers and runs the runtime CLI; it does not copy plugin sources into `.openclaw/plugins`, `.claude/plugins`, `plugins`, `.github/plugins`, `.copilot/plugins`, or `.hermes/plugins`.
- Runtime reloads/restarts are not implied by plugin execution. Configure target `reloadCommands`
  and pass `--reload-runtimes` or `--restart-runtimes` to run them after executed semantic plugin
  changes.
- Hermes local skills remain unsupported by default because local/project discovery requires configured `external_dirs`; user skills install to `~/.hermes/skills`.
- OpenClaw and Hermes built-ins do not emulate rules through legacy file drops such as `.openclaw/rules` or `.hermes/rules`; rules remain custom-adapter-only unless native runtime support is documented.
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
