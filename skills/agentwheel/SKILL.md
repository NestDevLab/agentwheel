---
name: agentwheel
description: Use agentwheel to discover, add, install, update, customize, eject, and uninstall agent skills, rules, instructions, commands, MCP, hooks, settings, and plugin artifacts across runtimes.
allowed-tools: [Bash]
---

# agentwheel

Use this skill when a user wants to install, manage, update, remove, or inspect agent skills or other agentwheel-managed artifacts.

agentwheel is the control plane. It reads packages from sources, stores desired state in `.agentwheel/config.json`, plans runtime changes, and writes only through `install`. Treat runtime output directories as generated files.

Mental model:

- `add` records desired packages.
- `install` makes the declared state true in the target runtime.
- `update` re-resolves tracking packages, then applies.
- `uninstall` removes configured packages and their managed runtime output.

## Safety Rules

- Prefer `agentwheel plan ...` or `agentwheel install --dry-run` before applying changes.
- Do not hand-edit generated runtime files such as `.openclaw/skills`, `.claude/skills`, `.codex/skills`, `.hermes/skills`, or generated instructions.
- If a plan reports `drift` or `conflict`, stop and explain it. Do not use `--force` unless the user explicitly approves that scope.
- Gmail, Drive, registry publishing, broad git pushes, and runtime restarts are
  separate external side effects. Get explicit approval when they are not the
  direct requested delivery. For a scoped repository implementation request, the
  matching commit and push are part of completion unless the user explicitly
  says not to.
- Programmatic adapters execute local code. Use `--adapter-module` only with `--allow-adapter-code` after the user approves that local code execution.
- OpenClaw plugin artifacts are only planned by default. Use `--execute-plugins` only after explicit approval.

## Source-First Delivery Contract

Runtime outputs are generated files. A hand edit inside `.codex/`, `.claude/`,
`.openclaw/`, `.hermes/`, or another harness is drift, not delivery.

After updating a repository that is an AgentWheel package, contains
`openpack.json`, or is used as a configured AgentWheel source, proactively check
whether local runtimes need reconciliation:

```bash
agentwheel status
agentwheel install --dry-run
```

If the current request is to implement, install, or roll out the change, apply
through AgentWheel after the dry-run is understood, then verify the installed
runtime files. Do not edit runtime harnesses directly as the final state.

Close the delivery loop:

- commit and push the source package change
- commit and push the relevant AgentWheel workspace config and lock changes
- report any blocked commit, push, drift, or conflict with exact paths

If a runtime hotfix already exists, back-port it to the source package, use an
AgentWheel override/eject path, or remove it before claiming the work is
complete.

## Core Flow

```bash
agentwheel registry search tmux
agentwheel add github:NestDevLab/agent-mesh --skill codex-tmux --adapter codex --mode tracking
agentwheel plan
agentwheel install
```

If a workspace already has configured packages in `.agentwheel/config.json`, install without a source:

```bash
agentwheel plan
agentwheel install
```

To add and install in one step:

```bash
agentwheel install github:owner/repo --adapter codex
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

`agentwheel init package` creates `openpack.json`, `instructions/`, `rules/`, `skills/`, and `instructions/AGENTS.md`.

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

`add` saves a package entry in `.agentwheel/config.json`; it does not install runtime files by itself.

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

## Plan And Install

Preview configured packages:

```bash
agentwheel plan
```

Apply configured packages:

```bash
agentwheel install
```

Preview or apply one configured package:

```bash
agentwheel plan team-agent-pack
agentwheel install team-agent-pack
```

Add and install a source in one step:

```bash
agentwheel install github:owner/repo --adapter codex
```

Target selection order is `--target-root`, then `--agent`, then runtime auto-detection from the current directory, then the current directory.

## Status

Use status to see configured packages, lock/manifest state, and pending install work:

```bash
agentwheel status
agentwheel status --agent lab-codex
agentwheel status --all
```

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
agentwheel install --agent lab-codex --dry-run
agentwheel install --agent lab-codex
agentwheel install --all --dry-run
agentwheel install --all
agentwheel install --profile daily --dry-run
agentwheel install --profile daily
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
agentwheel install ./my-pack --adapter-config ./my-runtime.jsonc --dry-run
agentwheel install ./my-pack --adapter-config ./my-runtime.jsonc
```

Use a local programmatic adapter only after approval:

```bash
agentwheel install ./my-pack --adapter-module ./adapter.ts --allow-adapter-code --dry-run
```

## Update

Preview updates for configured tracking packages:

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

Limit an update to one configured package:

```bash
agentwheel update team-agent-pack --dry-run
agentwheel update team-agent-pack
```

`install` uses the graph lock as input when present. `update` re-resolves tracking packages and writes a new lock. Pinned packages stay on the locked graph unless their declaration changes.

## Drift And Customization

Drift means a managed runtime output changed outside agentwheel. Fix drift by choosing one of the supported customization channels in `.agentwheel/`, then re-run a dry-run:

- Layer local instructions with `agentwheel remember`.
- Add separate local artifacts under `.agentwheel/additions`.
- Override an upstream item under `.agentwheel/overrides`.
- Eject an item into `.agentwheel/ejected` when the user wants local ownership.

Append durable local instruction text:

```bash
agentwheel remember --runtime codex "Always run the formatter before tests."
agentwheel plan
agentwheel install
```

Eject an artifact:

```bash
agentwheel eject <package-name>/skills/<skill-name>
agentwheel plan
agentwheel install
```

For package names with slashes, keep the full package name:

```bash
agentwheel eject NestDevLab/agent-mesh/skills/codex-tmux
```

## Uninstall

Preview uninstall for a configured package:

```bash
agentwheel uninstall team-agent-pack --dry-run
```

Uninstall clean managed files and remove the package from config:

```bash
agentwheel uninstall team-agent-pack
```

Remove from config and manifest but keep runtime files unmanaged:

```bash
agentwheel uninstall team-agent-pack --keep-files
```

By default, uninstall keeps drifted managed files. Use `--force` only with explicit approval:

```bash
agentwheel uninstall team-agent-pack --force
```

## Package Manifest Reference

An OpenPack package uses `openpack.json` or `openpack.jsonc`:

```json
{
  "schemaVersion": 2,
  "name": "owner/agent-pack",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules", "path": "rules" },
    { "type": "skills", "path": "skills" }
  ]
}
```

Supported artifact types are `instructions`, `rules`, `skills`, `commands`, `subagents`, `mcp`, `hooks`, `settings`, `plugins`, and `fragments`.

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
agentwheel plan
agentwheel install
```

If the current directory has multiple runtime markers:

```bash
agentwheel install --adapter codex --dry-run
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
agentwheel --no-update-check install --dry-run
AGENTWHEEL_NO_UPDATE_CHECK=1 agentwheel install --dry-run
```
