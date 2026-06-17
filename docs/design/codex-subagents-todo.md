# TODO: Codex Subagents Support

## Goal

Add native Agentwheel support for Codex `subagents` using Codex custom agent files.

Codex supports subagent workflows and custom agents, but the native format is not the same as
Claude's Markdown agent files. Agentwheel should map OpenPack `subagents` to the documented Codex
custom agent layout instead of treating Codex subagents as unsupported.

## Required Behavior

- Install Codex subagents to documented custom agent locations:
  - `local` -> `.codex/agents/`
  - `user` -> `~/.codex/agents/`
- Mark Codex `subagents` as `supported-native` in the compatibility matrix.
- Document the semantic difference:
  - Claude subagents are Markdown definitions under `.claude/agents/`.
  - Codex subagents are TOML custom agent definitions under `.codex/agents/`.
- Do not install Codex subagents as `.codex/agents/<name>/AGENTS.md`.

## Source Formats

Support these OpenPack source forms:

```text
subagents/reviewer.toml
subagents/reviewer.md
subagents/reviewer/AGENTS.md
```

### TOML Pass-Through

For `.toml` sources, install the file directly:

```text
subagents/reviewer.toml -> .codex/agents/reviewer.toml
```

The file should already contain Codex custom agent fields such as:

```toml
name = "reviewer"
description = "PR reviewer focused on correctness and missing tests."
developer_instructions = """
Review code like an owner.
Prioritize correctness, regressions, and missing tests.
"""
```

### Markdown Conversion

For Markdown file sources:

```text
subagents/reviewer.md -> .codex/agents/reviewer.toml
```

For directory sources:

```text
subagents/reviewer/AGENTS.md -> .codex/agents/reviewer.toml
```

Generate TOML with:

```toml
name = "reviewer"
description = "..."
developer_instructions = """
...
"""
```

Mapping rules:

- `name`: slug from file or directory name.
- `description`: frontmatter `description`, else first meaningful Markdown heading or line, else a stable fallback.
- `developer_instructions`: full Markdown body.
- Escape TOML multiline strings correctly.
- Preserve future room for optional fields:
  - `nickname_candidates`
  - `model`
  - `model_reasoning_effort`
  - `sandbox_mode`
  - `mcp_servers`
  - `skills.config`

## Implementation Notes

- Add Codex adapter targets:
  - `subagents.local` -> `.codex/agents`
  - `subagents.user` -> `~/.codex/agents`
- Add a Codex-specific render/transform path for `subagents` so Markdown sources become TOML.
- Keep Claude and Copilot behavior unchanged.
- Keep artifact selection semantics unchanged: users still select `subagents/<name>`.
- If a source format cannot be converted safely, fail planning with a clear error instead of writing an invalid agent file.

## Tests

Add path-resolution coverage:

- Codex local subagent -> `.codex/agents/reviewer.toml`
- Codex user subagent -> `~/.codex/agents/reviewer.toml`

Add install smoke coverage:

- `.toml` pass-through installs unchanged.
- `subagents/reviewer.md` converts to valid TOML.
- `subagents/reviewer/AGENTS.md` converts to valid TOML.
- Existing Claude subagent install still writes `.claude/agents/...`.

Add negative coverage:

- Codex must not write `.codex/agents/reviewer/AGENTS.md`.
- Missing required generated fields should fail before apply.
- Invalid TOML pass-through should fail with a clear diagnostic if validation is added.

## Docs To Update

- `docs/design/artifact-harness-compatibility.md`
- README built-in runtime targets
- Landing runtime matrix, if it still exposes subagent support
- Any adapter smoke matrix tests that encode Codex `subagents` as unsupported

## References

- <https://developers.openai.com/codex/subagents>
- <https://developers.openai.com/codex/config-advanced>
- <https://developers.openai.com/codex/guides/agents-md>
