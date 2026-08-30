---
name: agentwheel
description: Manage and explicitly inspect reusable agent artifacts with Agentwheel. Use when the user asks to search, add, install, update, customize, eject, or uninstall skills, integrations, workflows, or other OpenPack artifacts across runtimes. For automatic capability suggestions, install the separate agentwheel-discovery skill.
allowed-tools: [Bash]
license: MIT
metadata:
  author: NestDevLab
  version: "0.20.0"
---

# agentwheel

Agentwheel discovers reusable artifacts and manages their desired state across runtimes.

agentwheel is the control plane. It reads packages from sources, stores desired state in `.agentwheel/config.json`, plans runtime changes, and writes only through `install`. Treat runtime output directories as generated files.

Mental model:

- `add` records desired packages.
- `install` makes the declared state true in the target runtime.
- `update` re-resolves tracking packages, then applies.
- `skill update <name>` maps a configured skill to its owning package and reconciles only that skill plus its genuine transitive composition inputs; sibling artifacts keep their runtime bytes and manifest/lock state.
- `uninstall` removes configured packages and their managed runtime output.

## Safety Rules

- Prefer `agentwheel plan ...` or `agentwheel install --dry-run` before applying changes.
- Do not hand-edit generated runtime files such as `skills/`, `.agents/skills`, `.claude/skills`, `.github/skills`, `~/.hermes/skills`, or generated instructions.
- If a plan reports `drift` or `conflict`, stop and explain it. Do not use `--force` unless the user explicitly approves that scope.
- Gmail, Drive, registry publishing, git commits, pushes, and runtime reloads/restarts are separate external side effects. Get explicit approval for them.
- Programmatic adapters execute local code. Use `--adapter-module` only with `--allow-adapter-code` after the user approves that local code execution.
- OpenClaw plugin artifacts are only planned by default. Use `--execute-plugins` only after explicit approval.
- Search results are proposals, not approval. Never add, install, enable, or change configuration until the user confirms the artifact and target scope.

## Core Flow

```bash
agentwheel search tmux
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

Explicit source installs with explicit adapters default to user-level artifacts. Use exactly one of
`--user`, `--local`, or `--fleet <fleet-id>` when desired-state scope matters. Use
`-i/--installation-type <type>` for the runtime layout inside that scope and
`-t/--target-root <project>` for an explicit target root. Named fleets are optional.

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

## Explicit Discovery

Search configured registries and public catalogue sources:

```bash
agentwheel search "<query>"
agentwheel search "<query>" --json --limit 10
agentwheel search "<query>" --semantic --json --limit 10
```

Search when the user explicitly asks to find, compare, or evaluate an artifact. Search results are
proposals, not approval, and never change desired state by themselves.

### Semantic catalogue search

Use `--semantic` for a capability request whose wording is unlikely to match catalogue labels, or after bounded lexical search returns only weak matches. It queries the same published catalogue vector index used by the website and validates its checksums against the loaded catalogue before ranking. It is opt-in because first use may download the model and index assets.

```bash
agentwheel search "remember corrections from earlier conversations" --semantic --json --limit 10
```

Do not use `--semantic` for a registry-only search, and never describe a semantic score as proof
that an artifact implements a capability.

Use a trial only for instruction skills. Plugins, MCP servers, hooks, commands, and settings are not trialled because reading them is not equivalent to safely executing them in an isolated runtime.

Install `skills/agentwheel-discovery` separately when the user wants proactive capability-gap
detection, bounded semantic recommendations, and read-only trial suggestions during unrelated work.

Registry maintenance remains explicit:

```bash
agentwheel registry update
agentwheel registry list
```

Inspect an explicit source before adding it:

```bash
agentwheel list github:owner/repo
agentwheel scan github:owner/repo
agentwheel list ./local-agent-pack
agentwheel scan ./local-agent-pack
```

Filter source inspection to specific artifacts:

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

Execute semantic plugin installs only after approval:

```bash
agentwheel install --execute-plugins
```

If an agent or profile runtime declares structured `reloadCommands`, run them after executed semantic
plugin changes only with a separate explicit gate:

```bash
agentwheel install --execute-plugins --reload-runtimes
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
`--user`, `--local`, or `--fleet <fleet-id>` to select one desired-state scope, and use
`-i/--installation-type <type>` for the runtime layout inside that scope. If a package can be
installed in more than one type and no CLI/context default applies, Agentwheel fails instead of
guessing.

Target selection order is `--target-root`, then `--agent`, then runtime auto-detection from the current directory, then the current directory.

## Status

Use status to see configured packages, lock/manifest state, and pending install work:

```bash
agentwheel status
agentwheel status --agent lab-codex
agentwheel status --all
agentwheel status --profile daily
```

For a named fleet, prefer `agentwheel status --fleet <fleet-id> --profile <name>` over
direct agent status; profile status uses the same runtime resolution, adapter
config, installation type, and graph lock fingerprinting as
`install --fleet <fleet-id> --profile <name>`. If that fleet defines a profile named `all`,
`agentwheel status --fleet <fleet-id> --all` checks that profile.

## Named Fleets, Agents, And Profiles

Named fleets are optional control-plane configurations. Select one explicitly with
`--fleet <fleet-id>`; ordinary user and local work does not require fleet registration. User,
local, and fleet scopes are isolated desired state: Agentwheel does not merge them, and no fleet
has global priority.

Named fleets use workspace schema v3 or newer and require a compatible Agentwheel CLI. Upgrade first, verify
`agentwheel --version` and `agentwheel fleet --help`, then create or register fleet state. Do not
downgrade the config, strip named-fleet data, or run an old CLI against it.

Current config shape:

```json
{
  "schemaVersion": 3,
  "fleetId": "example-fleet",
  "packages": [
    {
      "name": "core-agent-pack",
      "source": "github:example-org/core-agent-pack",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking"
    }
  ],
  "agents": {
    "lab-codex": { "adapter": "codex", "installationType": "local", "root": "/workspace/project" }
  },
  "profiles": {
    "daily": {
      "runtimes": [
        { "agent": "lab-codex" }
      ]
    }
  }
}
```

Use named targets:

```bash
agentwheel fleet register example-fleet --root /srv/agentwheel/fleets/example-fleet --required-package core-agent-pack
agentwheel fleet list
agentwheel fleet show example-fleet
agentwheel install --fleet example-fleet --agent lab-codex --dry-run
agentwheel install --fleet example-fleet --all --dry-run
agentwheel install --fleet example-fleet --profile daily --dry-run
```

An intended runtime path owned by another scope is a blocking conflict even when the bytes match.
Use the dedicated fleet normalization workflow: preview the transfer, review its exact plan digest,
then apply only the unchanged plan. Never remove the source declaration first or hand-edit runtime
output to manufacture a clean plan.

```bash
agentwheel fleet normalize example-fleet --from user --package core-agent-pack --json
agentwheel fleet normalize example-fleet --from user --package core-agent-pack \
  --plan-digest <reviewed-sha256> --apply
agentwheel fleet normalize example-fleet --from user --recover
```

`fleetId` in the fleet config must match the registry key. Every repeatable
`--required-package` must name a package declared by that fleet. Recovery is only for a pending
journal and must fail if recorded configs, manifests, or graph locks changed externally.

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

For a named fleet, use `agentwheel update --fleet <fleet-id> --profile <name>` before
`install --fleet <fleet-id> --profile <name>` when tracking packages should move forward. If that
fleet defines a profile named `all`, `agentwheel update --fleet <fleet-id> --all` checks that
profile.

Limit an update to one configured package:

```bash
agentwheel update team-agent-pack --dry-run
agentwheel update team-agent-pack
```

Named package updates preserve artifacts owned by other configured roots, including unrelated drift.

For one configured skill, resolve its owner and reconcile only that skill plus genuine transitive composition inputs:

```bash
agentwheel skill update code-review --fleet example-fleet --profile daily --dry-run
agentwheel skill update code-review --fleet example-fleet --profile daily
```

Pinned owners use install semantics; tracking owners re-resolve. Sibling artifacts from the same package retain their runtime bytes and manifest/graph-lock entries; only composition inputs actually used by the requested skill join the update scope. Unrelated configured packages are not resolved. If ownership is ambiguous, pass `--package <name>`. Use `--adopt` only after explicit approval of the dry-run's unmanaged destinations.

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

For a one-time MCP rename, use a dedicated cutover workspace with one legacy MCP artifact and an
explicit agent `stateKey`. Preview each runtime separately:

```bash
agentwheel mcp retire legacy-mcp --agent legacy-codex --from-workspace-root /exact/old/workspace --dry-run
agentwheel mcp retire legacy-mcp --agent legacy-claude --dry-run
```

Require exactly one `REMOVE`, the expected target and legacy server, and zero drift/conflict.
Unexpected owner, manifest contents, arguments, environment, or MCP fields are blockers. Apply only
after separate runtime approval by replacing `--dry-run` with `--apply`.

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

If a registry short name fails:

```bash
agentwheel registry update
agentwheel search "<query>" --scope registry
```

If npm update checks are noisy:

```bash
agentwheel --no-update-check install --dry-run
AGENTWHEEL_NO_UPDATE_CHECK=1 agentwheel install --dry-run
```

If install fails with `Locked install cache missing or stale for locked graph node`, or a pinned
dependency snapshot lacks a selected artifact:

```bash
agentwheel list <source> --select <artifact>
```

The native fetch refreshes the source cache. If the refreshed content hash matches the lock, stop —
nothing else is stale. If it differs, regenerate only the affected graph locks (lock-only) and
leave them uncommitted: lock commits belong to the approved install. `update --dependency` cannot
recompute an edge whose root node id changed (e.g. after renaming the root package's artifacts);
regenerate the locks instead.
