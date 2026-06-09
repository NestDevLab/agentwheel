---
name: agentwheel
description: Use agentwheel to discover, install, sync, update, customize, eject, and uninstall agent skills, rules, instructions, commands, MCP, hooks, settings, and plugin artifacts across runtimes.
allowed-tools: [Bash]
---

# agentwheel

Use this skill when a user wants to install, manage, update, remove, or inspect agent skills or other agentwheel-managed artifacts.

agentwheel is the control plane. It reads packages from sources, stages artifacts, plans changes for a runtime adapter, and writes only through `sync`. Treat runtime output directories as generated files.

## Safety Rules

- Prefer `agentwheel plan ...` or `agentwheel sync --dry-run` before applying changes.
- Do not hand-edit generated runtime files such as `.openclaw/skills`, `.claude/skills`, `.codex/skills`, `.hermes/skills`, or generated instructions.
- If a plan reports `drift` or `conflict`, stop and explain it. Do not use `--force` unless the user explicitly approves that scope.
- Gmail, Drive, registry publishing, git commits, pushes, and runtime restarts are separate external side effects. Get explicit approval for them.
- Programmatic adapters execute local code. Use `--adapter-module` only with `--allow-adapter-code` after the user approves that local code execution.
- OpenClaw plugin artifacts are only planned by default. Use `--execute-plugins` only after explicit approval.

## Core Flow

```bash
agentwheel registry search tmux
agentwheel add github:NestDevLab/agent-mesh --skill codex-tmux --adapter codex --mode tracking
agentwheel sync --dry-run
agentwheel sync
```

If a workspace already has configured packages in `.agentwheel/config.json`, run sync without a source:

```bash
agentwheel sync --dry-run
agentwheel sync
```

## Workspace Setup

Initialize an agentwheel workspace:

```bash
agentwheel init
```

Initialize a package authoring directory:

```bash
agentwheel init package
```

`agentwheel init package` creates `agentwheel.json`, `instructions/`, `rules/`, `skills/`, and `instructions/AGENTS.md`.

## Discovery

Refresh and search the optional registry:

```bash
agentwheel registry update
agentwheel registry list
agentwheel registry search <query>
```

Inspect an explicit source before adding it:

```bash
agentwheel list github:owner/repo
agentwheel scan github:owner/repo
agentwheel list ./local-agent-pack
agentwheel scan ./local-agent-pack
```

Filter discovery to specific artifacts:

```bash
agentwheel list github:owner/repo --select skills/review --select rules/core.md
agentwheel list github:owner/repo --skill review
```

## Sources

Use explicit sources when you know the package location:

```bash
agentwheel add github:owner/repo
agentwheel add github:owner/repo#main
agentwheel add git:https://host.example/owner/repo.git#v1.2.3
agentwheel add ./local-agent-pack
agentwheel add /absolute/path/to/agent-pack
agentwheel add skillkit:github:owner/repo
agentwheel add vercel:owner/repo
agentwheel add vercel:skills.sh/owner/repo/skill-name
```

Short names go through the registry:

```bash
agentwheel registry update
agentwheel add <registry-name>
```

Driver inference is automatic for `github:`, `git:`, `skillkit:`, `vercel:`, and local paths. Override it only when needed:

```bash
agentwheel add <source> --driver local
agentwheel add <source> --driver git
agentwheel add <source> --driver skillkit
agentwheel add <source> --driver vercel-skills
```

## Add Packages

Add saves a package entry in `.agentwheel/config.json`; it does not install runtime files by itself.

```bash
agentwheel add github:owner/repo --adapter openclaw
agentwheel add github:owner/repo --adapter claude
agentwheel add github:owner/repo --adapter codex
agentwheel add github:owner/repo --adapter hermes
agentwheel add github:owner/repo --adapter copilot
```

Select only part of a package:

```bash
agentwheel add github:owner/repo --skill code-review
agentwheel add github:owner/repo --select skills/code-review --select rules/core.md
agentwheel add github:owner/repo --select skills/code-review,rules/core.md
```

Use `--name` for a stable local alias:

```bash
agentwheel add github:owner/repo --name team-agent-pack
```

Choose update mode:

```bash
agentwheel add github:owner/repo#v1.0.0 --mode pinned
agentwheel add github:owner/repo#main --mode tracking
```

## Plan And Sync

Plan a source directly:

```bash
agentwheel plan github:owner/repo --adapter codex
agentwheel plan github:owner/repo --adapter codex --target-root /path/to/project
```

Dry-run a source directly:

```bash
agentwheel sync github:owner/repo --adapter codex --dry-run
```

Apply a source directly:

```bash
agentwheel sync github:owner/repo --adapter codex
```

Sync configured packages:

```bash
agentwheel sync --dry-run
agentwheel sync
```

Target selection order is `--target-root`, then `--agent`, then runtime auto-detection from the current directory, then the current directory.

## Named Agents And Profiles

Global config is `~/.agentwheel/config.json`. Project config is `.agentwheel/config.json`; project values win.

Current config shape:

```json
{
  "schemaVersion": 1,
  "packages": [],
  "registry": {},
  "agents": {
    "lab-codex": { "adapter": "codex", "root": "/Users/me/project" },
    "lab-claude": { "adapter": "claude", "root": "/Users/me/project" }
  },
  "profiles": {
    "daily": {
      "runtimes": [
        { "agent": "lab-codex" },
        { "agent": "lab-claude" }
      ]
    }
  }
}
```

Use named targets:

```bash
agentwheel sync --agent lab-codex --dry-run
agentwheel sync --agent lab-codex
agentwheel sync --all --dry-run
agentwheel sync --all
agentwheel sync --profile daily --dry-run
agentwheel sync --profile daily
```

## Adapters

Built-in adapters:

- `openclaw`
- `claude`
- `codex`
- `hermes`
- `copilot`

Use a declarative adapter config:

```bash
agentwheel sync ./my-pack --adapter-config ./my-runtime.jsonc --dry-run
agentwheel sync ./my-pack --adapter-config ./my-runtime.jsonc
```

Use a local programmatic adapter only after approval:

```bash
agentwheel sync ./my-pack --adapter-module ./adapter.ts --allow-adapter-code --dry-run
```

## Update

Preview updates for configured packages:

```bash
agentwheel update --dry-run
```

Apply updates:

```bash
agentwheel update
```

Target configured agents:

```bash
agentwheel update --agent lab-codex --dry-run
agentwheel update --all --dry-run
```

Temporarily limit an update to selected artifacts:

```bash
agentwheel update --skill code-review --dry-run
agentwheel update --select skills/code-review --dry-run
```

`update` skips pinned packages unless the lock indicates they should be updated. Tracking packages can re-resolve upstream.

## Drift And Customization

Drift means a managed runtime output changed outside agentwheel. Fix drift by choosing one of the supported customization channels in `.agentwheel/`, then re-run a dry-run:

- Layer local instructions with `agentwheel remember`.
- Add separate local artifacts under `.agentwheel/additions`.
- Override an upstream item under `.agentwheel/overrides`.
- Eject an item into `.agentwheel/ejected` when the user wants local ownership.

Append durable local instruction text:

```bash
agentwheel remember --runtime codex "Always run the formatter before tests."
agentwheel sync --dry-run
agentwheel sync
```

Eject an artifact:

```bash
agentwheel eject <package-name>/skills/<skill-name>
agentwheel sync --dry-run
agentwheel sync
```

For package names with slashes, keep the full package name:

```bash
agentwheel eject NestDevLab/agent-mesh/skills/codex-tmux
```

## Uninstall

Preview uninstall for the current target:

```bash
agentwheel uninstall --dry-run
```

Uninstall clean managed files:

```bash
agentwheel uninstall
```

Uninstall a selected skill:

```bash
agentwheel uninstall --skill code-review --dry-run
agentwheel uninstall --skill code-review
```

Uninstall a selected artifact:

```bash
agentwheel uninstall --select skills/code-review --dry-run
agentwheel uninstall --select skills/code-review
```

By default, uninstall keeps drifted managed files. Use `--force` only with explicit approval:

```bash
agentwheel uninstall --force
```

## Package Manifest Reference

An agentwheel package uses `agentwheel.json` or `agentwheel.jsonc`:

```json
{
  "schemaVersion": 1,
  "name": "owner/agent-pack",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules", "path": "rules" },
    { "type": "skills", "path": "skills" }
  ]
}
```

Supported artifact types are `instructions`, `rules`, `skills`, `commands`, `subagents`, `mcp`, `hooks`, `settings`, and `plugins`.

Skills convention:

```text
skills/<name>/SKILL.md
```

Skill frontmatter is YAML:

```yaml
---
name: code-review
description: Review code, configuration, or documentation for correctness, safety, maintainability, and missing validation.
allowed-tools: [Bash]
---
```

## Troubleshooting

If there are no configured packages:

```bash
agentwheel add <source> --adapter <runtime>
agentwheel sync --dry-run
```

If the current directory has multiple runtime markers:

```bash
agentwheel sync --adapter codex --dry-run
```

If a selected artifact is missing:

```bash
agentwheel list <source>
```

If registry short names fail:

```bash
agentwheel registry update
agentwheel registry search <query>
```

If npm update checks are noisy:

```bash
agentwheel --no-update-check sync --dry-run
AGENTWHEEL_NO_UPDATE_CHECK=1 agentwheel sync --dry-run
```
