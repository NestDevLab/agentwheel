<p align="center">
  <img src="assets/logo.png" alt="agentwheel" width="120">
</p>

<h1 align="center">agentwheel</h1>

<p align="center"><strong>One source. Every agent.</strong></p>

<p align="center">
  Weave skills, rules, instructions, commands, subagents, MCP, hooks, settings, and plugins across every AI agent you use,
  from any source, reconciled into each runtime with your private tweaks intact.
</p>

---

## Why agentwheel?

Your AI agents are multiplying. OpenClaw, Claude Code, Codex CLI, Copilot, Hermes — and the next
harness your team adopts. Each one wants its own skills, rules, instructions, commands, subagents,
MCP servers, hooks, and settings, in its own layout.

**agentwheel makes that one declared state.** Add packages to `.agentwheel/config.json`, preview the
runtime changes, then install the declared state into each target. Updates move tracking sources
forward explicitly; installs make the current declaration true.

```bash
npm i -g agentwheel
agentwheel init
agentwheel add github:your-org/agent-pack --adapter codex --installation-type local --mode tracking
agentwheel plan
agentwheel install
```

No lock-in. No central gatekeeper. Packages live in plain git repos or local folders, customizations
live in your workspace, and runtimes stay generated output.

> **Status: early (v0.12).** The public CLI vocabulary is package-manager style:
> `add`, `install`, `update`, and `uninstall`. A hidden `sync` shim remains for old bootstrapped
> skills; use `install` in all new docs and scripts.

## Supported runtimes & resources

agentwheel installs OpenPack resources into five built-in runtimes and into custom harnesses.
Every built-in target is scoped by `--installation-type <type>`; built-ins currently use `local`
for project/workspace installs and `user` for documented user-level installs. If a package can be
installed in more than one type, agentwheel requires `--installation-type` instead of guessing.

- **OpenClaw** — workspace `skills/`, user `~/.openclaw/skills`
- **Claude Code** — `CLAUDE.md`, `.claude/`, and user `~/.claude/`
- **Codex CLI** — `AGENTS.md`, `.agents/skills`, `.codex/`, and user equivalents
- **GitHub Copilot CLI** — `.github/`, user `~/.copilot/`, and documented `.agents` skill alternatives
- **Hermes** — local instructions via `AGENTS.md`; skills are user-only at `~/.hermes/skills`
- **Bring your own** — JSONC config adapters with `--adapter-config`, or programmatic adapters with `--adapter-module`

Supported resource types include instructions, rules, skills, commands, subagents, MCP, hooks,
settings, plugins, and fragments. Runtime compatibility is per artifact and per installation type;
see [`docs/design/artifact-harness-compatibility.md`](docs/design/artifact-harness-compatibility.md).
Fragments are Agentwheel composition inputs, not runtime file-drop targets.

> `rules` is an OpenPack artifact kind, not a portable runtime concept. Codex rules are command
> execution policy, Claude rules are behavioral/path-scoped instructions, and Copilot rule-like
> installs map to path-specific custom instructions. Unsupported rule targets require an explicit
> custom adapter instead of an inferred folder.

## Core Commands

| Command | Meaning |
|---|---|
| `agentwheel add <source>` | Validate and save a package entry in `.agentwheel/config.json`; does not touch runtimes. |
| `agentwheel plan [name-or-source]` | Preview what `install` would reconcile without writing. |
| `agentwheel install` | Reconcile configured packages into the current target or selected fleet. Uses the graph lock as input by default. |
| `agentwheel install <name-or-source>` | Ensure semantics: configured name/source scopes the install; a new source is added and installed. |
| `agentwheel update [name]` | Re-resolve tracking packages, then apply. Pinned packages stay locked. |
| `agentwheel uninstall <name-or-source>` | Remove a configured package from runtimes and config. |
| `agentwheel uninstall <name> --keep-files` | Remove from config/manifest while leaving runtime files unmanaged. |
| `agentwheel status` | Show configured packages, manifest/lock presence, and install state. |

Mental model: **`install` = make what is declared true. `update` = move tracking declarations forward,
then make them true.**
Scoped installs do not remove files owned only by other configured packages; run a full `agentwheel install`
to reconcile those removals.

## Quick Start

```bash
npm i -g agentwheel

agentwheel init
agentwheel add github:your-org/agent-pack --adapter openclaw --installation-type local --mode tracking
agentwheel plan
agentwheel install
```

Prefer pnpm? `pnpm add -g agentwheel` works too.

Contributor install from source:

```bash
git clone https://github.com/NestDevLab/agentwheel
cd agentwheel
pnpm install
pnpm build
pnpm link --global
```

`plan`, `install --dry-run`, and `update --dry-run` show what would change before runtime files are
written. `uninstall` removes clean managed files and keeps drifted files by default; use
`agentwheel uninstall --force` only when you also want to remove drifted managed files.

agentwheel checks npm for newer versions at most once every 24 hours and prints a non-blocking
stderr warning when an update is available. Disable it with `--no-update-check` or
`AGENTWHEEL_NO_UPDATE_CHECK=1`.

## Runtime Targeting

Normal use does not need `--target-root`. Run agentwheel inside a runtime folder and it detects the
target:

```bash
cd ~/.openclaw
agentwheel install
```

Pass `--installation-type local` to install project/workspace-scoped artifacts, or
`--installation-type user` to install documented user-level artifacts. For example, Codex local
skills install into `.agents/skills`, while Codex user skills install into `~/.agents/skills`.
Use a comma-separated adapter list to install the same source into more than one built-in runtime in
one invocation:

```bash
agentwheel install github:your-org/agent-pack --adapter codex,claude --installation-type user --target-root ~
```

When adding a new source this way, Agentwheel saves one package entry per adapter so later installs
do not collapse Codex and Claude state into the same config entry.

For a control-plane setup, define named agents in config. Global config lives at
`~/.agentwheel/config.json`; project config lives at `.agentwheel/config.json`; project values win.

```jsonc
{
  "agents": {
    "lab-openclaw": { "adapter": "openclaw", "installationType": "local", "root": "$HOME/.openclaw-home", "transport": "local" },
    "remote-codex": {
      "adapter": "codex",
      "installationType": "local",
      "root": "/workspace/project",
      "transport": "ssh",
      "host": "agent-host.example",
      "user": "agent",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519"
    }
  },
  "profiles": {
    "daily": {
      "runtimes": [
        { "agent": "lab-openclaw" },
        { "agent": "remote-codex" }
      ]
    }
  }
}
```

```bash
agentwheel install --agent lab-openclaw
agentwheel install --all
agentwheel install --profile daily
agentwheel install --all-detected
```

SSH targets use the same manifest and drift model as local targets. Planning reads the remote
install manifest and hashes remote files before deciding whether a file is up to date, drifted, or
conflicting. SSH hosts need `ssh`, `tar`, and `node` available on `PATH`.

To scaffold a control-plane example:

```bash
agentwheel init --fleet-example
```

Target resolution order is exact: `--target-root` wins, then `--agent`, then auto-detect from the
current directory, then fallback to the current directory. `--all-detected` is an explicit escape hatch
for applying to every runtime marker found in the current directory or `--target-root`; `--all` remains
reserved for configured agents.

## Core Ideas

**Three places, one direction:**

| | Where | What |
|---|---|---|
| **Author** | the package's git repo | upstream content, never edited in place |
| **Workspace** | your repo, under `.agentwheel/` | config, locks, trust decisions, and customizations |
| **Runtime** | `.openclaw/`, `~/.claude/`, `.codex/`, ... | generated output |

Flow: **author + workspace → `install` → runtime**.

## Packages

A package is a git repo or folder with an OpenPack manifest and a canonical layout:

```jsonc
// openpack.json
{
  "schemaVersion": 2,
  "name": "your-org/agent-pack",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules", "path": "rules" },
    { "type": "skills", "path": "skills" }
  ]
}
```

Install only part of a package with `--select <type>/<name>`. `--skill <name>` is a shortcut for
`--select skills/<name>`, and selections saved during `add` are reused by later `install` and
`update` runs.

```bash
agentwheel add github:NestDevLab/agent-mesh --skill codex-tmux --adapter codex --installation-type local
agentwheel plan
agentwheel install
```

Package authors can mark artifacts as required. Required artifacts are always installed and cannot
be deselected:

```jsonc
{
  "type": "rules",
  "path": "rules/core-safety.md",
  "required": true
}
```

## Dependencies And Composition

OpenPack packages can depend on other packages and compose shared markdown fragments:

```jsonc
{
  "schemaVersion": 2,
  "name": "your-org/agent-pack",
  "version": "1.0.0",
  "requires": {
    "core": {
      "source": "github:your-org/core-pack",
      "version": "^1.2.0",
      "select": ["rules/safe-actions.md", "fragments/risk.md"]
    }
  },
  "provides": [
    { "type": "fragments", "path": "fragments" },
    { "type": "skills", "path": "skills" }
  ]
}
```

- **Recursive resolution, locked.** `install` reads the existing graph lock when present; newly
  added packages resolve fresh and then write a deterministic lock.
- **Explicit updates.** `update` re-resolves tracking sources and applies the new graph. Pinned
  packages stay on the locked graph unless their declaration changes.
- **Fragment composition.** Markdown files can transclude shared fragments with
  `<!-- openpack:include fragments/review-style.md -->` or cross-package aliases such as
  `core:fragments/risk.md`.
- **Trust.** New transitive sources prompt before install. Pre-approve with `--trust <glob>` or
  `--yes`, set a workspace trust policy, and manage persisted decisions with `agentwheel trust`.
- **Offline & frozen installs.** `--offline` guarantees zero network; `--frozen-lock` hard-fails if
  resolution would differ from the lock.
- **Introspection.** `agentwheel deps tree` prints the resolved graph; `agentwheel deps why
  <selector>` explains why an artifact is installed.

### Meta-packages (packs)

OpenPack v2 packages can omit `provides` when they declare at least one dependency. These
meta-packages install nothing of their own; they aggregate curated selections from other packages.
Uninstalling a meta-package removes the dependencies it pulled in unless those dependencies are
still owned by another configured package.

```json
{
  "schemaVersion": 2,
  "name": "test/meta-pack",
  "version": "0.1.0",
  "requires": {
    "dep": { "source": "../dep-a", "select": ["rules/a.md"] }
  }
}
```

### Source Overrides

Use package-level `overrides` when a workspace intentionally wants one selected source to replace
an artifact that arrives from another package, such as a forked skill replacing the same skill
pulled in by a meta-package. Overrides are explicit; package array order never decides precedence.

```jsonc
{
  "schemaVersion": 1,
  "packages": [
    {
      "name": "nestdev-must-have-core",
      "source": "github:NestDevLab/agent-must-have#core",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking"
    },
    {
      "name": "agent-toolkit-nestdev",
      "source": "github:example-org/agent-toolkit#main",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking",
      "select": [
        "rules/self-improve-on-correction.md",
        "skills/self-improve"
      ],
      "overrides": [
        "github:example-upstream/agent-toolkit::rules/self-improve-on-correction.md",
        "github:example-upstream/agent-toolkit::skills/self-improve"
      ]
    }
  ]
}
```

The `source::type/name` selector identifies the artifact to replace. `github:owner/repo` matches
that repository at any ref; add `#main` or another ref to narrow it. The replacing package must
select exactly one artifact with the same `type/name`, and the override must match exactly one
losing artifact. Otherwise planning fails instead of hiding a collision.

The same declaration can be created from the CLI:

```bash
agentwheel add github:example-org/agent-toolkit#main \
  --skill self-improve \
  --override 'github:example-upstream/agent-toolkit::skills/self-improve'
```

`agentwheel plan`, `agentwheel deps tree`, and `agentwheel deps why` print `OVERRIDE` lines for
these decisions, and graph locks store them for review.

Migrating an existing legacy package takes one command:

```bash
agentwheel package migrate
```

## Customizing Without Getting Overwritten

Drift detection blocks accidental edits to generated runtime files. Intentional changes live under
`.agentwheel/`:

- **Layer** local instructions with `agentwheel remember`.
- **Add** separate local artifacts under `.agentwheel/additions`.
- **Override content** for an upstream item under `.agentwheel/overrides`.
- **Override source precedence** with package `overrides` when a forked source should replace a
  colliding artifact from another package.
- **Eject** an item into `.agentwheel/ejected` when you want local ownership.

## Custom And Private Runtimes

A runtime adapter is a config with capabilities and paths. Internal runtimes do not need to be
published:

```jsonc
{
  "name": "myco-internal",
  "targets": {
    "instructions": {
      "local": { "dest": ".myco/context/AGENTS.md" }
    },
    "rules": {
      "local": { "dest": ".myco/policy/rules" }
    },
    "skills": {
      "local": { "dest": ".myco/lib/skills" },
      "user": { "root": "home", "dest": ".myco/skills" }
    }
  }
}
```

```bash
agentwheel install ./my-pack --adapter-config ./myco-internal.jsonc
```

For adapter behavior that needs code, load a programmatic adapter module:

```bash
agentwheel install ./my-pack --adapter-module ./myco-adapter.js
```

Built-in runtime targets:

| Runtime | Native supported targets |
|---|---|
| **OpenClaw** | `local: skills/`; `user: ~/.openclaw/skills`; plugins require runtime-specific config |
| **Claude Code** | `local: CLAUDE.md, .claude/skills, .claude/rules, .claude/commands, .claude/agents, .mcp.json, .claude/settings.json`; `user: ~/.claude/...` except project MCP; rules are behavioral/path-scoped |
| **Codex CLI** | `local: AGENTS.md, .agents/skills, .codex/rules, .codex/agents, .codex/config.toml, .codex/hooks.json`; `user: ~/.agents/skills, ~/.codex/...`; rules are command execution policy; subagents are TOML custom agents |
| **Hermes** | `local: AGENTS.md`; `user: ~/.hermes/skills`; rules require explicit adapter config |
| **GitHub Copilot CLI** | `local: .github/copilot-instructions.md, .github/instructions, .github/prompts, .github/skills, .github/agents, .github/mcp.json, .github/hooks`; `user: ~/.copilot/copilot-instructions.md, ~/.copilot/instructions, ~/.copilot/skills, ~/.copilot/agents, ~/.copilot/mcp-config.json, ~/.copilot/hooks`; rule-like artifacts map to instructions |

## Docs

- [`docs/spec/openpack.md`](docs/spec/openpack.md) — OpenPack package spec.
- [`docs/fleet-config.md`](docs/fleet-config.md) — named agents, SSH targets, and profiles.
- [`docs/design/artifact-harness-compatibility.md`](docs/design/artifact-harness-compatibility.md) — artifact/harness compatibility matrix and rule semantics.
- Resource catalogue: https://nestdevlab.github.io/agentwheel/catalogue.html.
- [`DESIGN.md`](DESIGN.md) — architecture and module layout.
- [`LIFECYCLE.md`](LIFECYCLE.md) — publish, install, update, and customization model.

## License

See [`LICENSE`](LICENSE).
