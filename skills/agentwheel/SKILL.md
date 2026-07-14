---
name: agentwheel
description: Use agentwheel to discover, add, install, update, customize, eject, and uninstall agent skills, rules, instructions, commands, MCP, hooks, settings, and plugin artifacts across runtimes.
allowed-tools: [Bash]
license: MIT
metadata:
  author: NestDevLab
  version: "0.14.11"
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
- Do not hand-edit generated runtime files such as `skills/`, `.agents/skills`, `.claude/skills`, `.github/skills`, `~/.hermes/skills`, or generated instructions.
- If a plan reports `drift` or `conflict`, stop and explain it. Do not use `--force` unless the user explicitly approves that scope.
- Gmail, Drive, registry publishing, git commits, pushes, and runtime restarts are separate external side effects. Get explicit approval for them.
- Programmatic adapters execute local code. Use `--adapter-module` only with `--allow-adapter-code` after the user approves that local code execution.
- OpenClaw plugin artifacts are only planned by default. Use `--execute-plugins` only after explicit approval.

## Core Flow

```bash
agentwheel registry search tmux
agentwheel add github:NestDevLab/agent-mesh --skill codex-tmux --adapter codex --installation-type local --mode tracking
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
agentwheel install github:owner/repo --adapter codex,claude
```

Explicit source installs with explicit adapters default to user-level artifacts. Use `--local` for
the current directory or `-t/--target-root <project>` for project/workspace installs. Use `--user`, `--local`, or
`-i/--installation-type <type>` when scope should be explicit.

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
agentwheel add github:owner/repo --adapter openclaw --installation-type local
agentwheel add github:owner/repo --adapter claude --installation-type local
agentwheel add github:owner/repo --adapter codex --installation-type local
agentwheel add github:owner/repo --adapter hermes --installation-type user
agentwheel add github:owner/repo --adapter copilot --installation-type local
```

Select only part of a package:

```bash
agentwheel add github:owner/repo --skill code-review
agentwheel add github:owner/repo --select skills/code-review --select rules/core.md
agentwheel add github:owner/repo --select skills/code-review,rules/core.md
```

Install or persist suggested companion artifacts only when requested:

```bash
agentwheel plan github:owner/repo --skill review --with-suggestions
agentwheel install github:owner/repo --skill review --suggestion brainstorming
agentwheel add github:owner/repo --skill review --with-suggestions --adapter codex --installation-type local
```

Treat OpenPack `suggests` as opt-in soft composition, not as `requires.optional`.
`--with-suggestions` includes all suggestions relevant to selected artifacts as non-blocking
optional graph edges. `--suggestion <alias>` includes one named suggestion and should fail if that
explicit suggestion cannot resolve.

Use a source override when a selected package should replace the same artifact coming from another
source, such as a forked skill overriding a meta-pack dependency. The declaration is explicit and
planning fails if it does not match exactly one losing artifact and one selected replacement:

```bash
agentwheel add github:example-org/agent-toolkit#main \
  --skill self-improve \
  --override 'github:example-upstream/agent-toolkit::skills/self-improve'
```

Equivalent config:

```json
{
  "name": "agent-toolkit-nestdev",
  "source": "github:example-org/agent-toolkit#main",
  "driver": "git",
  "adapter": "codex",
  "installationType": "local",
  "mode": "tracking",
  "select": ["skills/self-improve"],
  "overrides": ["github:example-upstream/agent-toolkit::skills/self-improve"]
}
```

`source::type/name` identifies the artifact being replaced. `github:owner/repo` matches any ref
for that repo; include `#main` or another ref to narrow it. Review `OVERRIDE` lines in
`agentwheel plan`, `agentwheel deps tree`, or `agentwheel deps why` before applying fleet-wide.

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

### Hermes plugin rollout checks

When delivering a Hermes plugin, do not equate source package presence or `plugins.enabled` config with a working runtime install. Verify the gateway host has `$HERMES_HOME/plugins/<plugin-name>/` with the expected `plugin.yaml`/code files, the Agentwheel install manifest contains the plugin artifact, and a canary exercises the middleware path. Use `--execute-plugins` for plugin artifacts when applying, after dry-run and explicit approval.

Preview or apply one configured package:

```bash
agentwheel plan team-agent-pack
agentwheel install team-agent-pack
```

Add and install a source in one step:

```bash
agentwheel install github:owner/repo --adapter codex,claude
```

Explicit source installs with explicit adapters default to documented user-level installs. Pass
`--local` for the current directory or `-t/--target-root <project>` for project/workspace installs, and use `--user`, `--local`,
or `-i/--installation-type <type>` when scope should be explicit. If a package can be installed in
more than one type and no CLI/context default applies, agentwheel fails instead of guessing.

Target selection order is `--target-root`, then `--agent`, then runtime auto-detection from the current directory, then the current directory.

## Status

Use status to see configured packages, lock/manifest state, and pending install work:

```bash
agentwheel status
agentwheel status --agent lab-codex
agentwheel status --all
agentwheel status --profile daily
```

For profile-managed fleets, prefer `agentwheel status --profile <name>` over
direct agent status; profile status uses the same runtime resolution, adapter
config, installation type, and graph lock fingerprinting as
`install --profile <name>`. If a workspace defines a profile named `all`,
`agentwheel status --all` checks that profile.

## Named Agents And Profiles

Global config is `~/.agentwheel/config.json`. Project config is `.agentwheel/config.json`; project values win.

Current config shape:

```json
{
  "schemaVersion": 1,
  "packages": [],
  "registry": {},
  "agents": {
    "lab-codex": { "adapter": "codex", "installationType": "local", "root": "$HOME/project" },
    "lab-claude": { "adapter": "claude", "installationType": "local", "root": "$HOME/project" }
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
agentwheel update --profile daily --dry-run
```

For profile-managed fleets, use `agentwheel update --profile <name>` before
`install --profile <name>` when tracking packages should move forward. If a
workspace defines a profile named `all`, `agentwheel update --all` checks that
profile.

Limit an update to one configured package:

```bash
agentwheel update team-agent-pack --dry-run
agentwheel update team-agent-pack
```

Named package updates preserve artifacts owned by other configured roots, including unrelated drift.

Advance one tracking dependency while unrelated graph nodes remain locked:

```bash
agentwheel update --dependency shared-core --dry-run
agentwheel update --dependency shared-core
agentwheel update --dependency github:your-org/shared-core --agent lab-codex
```

The selector must uniquely match a locked tracking dependency by name, alias, node id, or source.
Its required tracking closure also advances. Configured selections stay unchanged; this mode
rejects package arguments, `--select`, `--skill`, `--frozen-lock`, and `--offline`.

`install` uses the graph lock as input when present. `update` re-resolves tracking packages and writes a new lock. Pinned packages stay on the locked graph unless their declaration changes.

## Drift And Customization

Drift means a managed runtime output changed outside agentwheel. Fix drift by choosing one of the supported customization channels in `.agentwheel/`, then re-run a dry-run:

- Layer local instructions with `agentwheel remember`.
- Add separate local artifacts under `.agentwheel/additions`.
- Override upstream content under `.agentwheel/overrides`.
- Override source precedence with package `overrides` when a forked source should replace a
  colliding upstream artifact.
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
agentwheel install --adapter codex --installation-type local --dry-run
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
