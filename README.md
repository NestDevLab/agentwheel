<p align="center">
  <img src="assets/logo.png" alt="agentwheel" width="120">
</p>

<h1 align="center">agentwheel</h1>

<p align="center"><strong>One source. Every agent.</strong></p>

<p align="center">
  Weave your skills, rules, and instructions across every AI agent you use —
  from any source, kept in sync, with your private tweaks intact.
</p>

---

## Why agentwheel?

Your AI agents are multiplying. Claude here, Codex there, a couple of custom runtimes in the corner — and every one of them wants its skills, its rules, its own little `AGENTS.md`, in its own folder, in its own format.

So you copy-paste. You forget which agent has the latest version. You tweak a rule for one and it drifts out of sync with the rest. Multiply that by a team, and "keep the agents aligned" quietly becomes a part-time job.

**agentwheel makes it one job, done once.** Point it at your skills and instructions, tell it which agents you run, and it installs everything where each one expects it — then keeps it that way. Update upstream and your agents update. Make a local tweak and it survives the next update. Add a brand-new runtime nobody's ever heard of? Drop in a small config and it's a first-class target too.

```bash
npm i -g agentwheel
agentwheel add github:your-org/agent-pack
cd ~/.openclaw
agentwheel sync --dry-run    # show me what would change
agentwheel sync              # install into the detected runtime
```

No lock-in. No central gatekeeper. Your packages live in plain git repos, your customizations live in your own repo, and anything reachable by a URL just works.

---

> **Status: early (v0.6).** The lifecycle core is real and tested — local/git/skillkit/vercel
> sources, optional registry discovery, plan/sync/update/drift/uninstall, overlays, eject/remember,
> profiles, runtime auto-detection, fleet targeting, asset-includes, selective installs,
> update notifications, rich JSON merge, and pluggable adapters.
> Expect sharp edges.

## What it does

- **Installs** skills, rules, and instructions into each runtime's native location.
- **Keeps them in sync** — re-runnable, idempotent, with a manifest and drift detection so nothing silently clobbers your work.
- **Pluggable adapters** — each runtime is described by a small config; add your own without forking.
- **Pluggable sources** — pull packages from local paths, git, or skill ecosystems.
- **Your customizations are first-class** — layer, extend, override, or take full ownership, and survive updates.

## Quick start

```bash
npm i -g agentwheel

agentwheel init
agentwheel add github:your-org/agent-pack --adapter openclaw --mode tracking
cd ~/.openclaw
agentwheel sync --dry-run
agentwheel sync
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

`plan`, `sync --dry-run`, and `update --dry-run` show exactly what would change before anything is written. They're the commands to trust.

`uninstall` removes clean managed files by default and keeps drifted files in place with a warning.
Use `agentwheel uninstall --force` only when you also want to remove drifted managed files.

agentwheel checks npm for newer versions at most once every 24 hours and prints a non-blocking
stderr warning when an update is available. Disable it with `--no-update-check` or
`AGENTWHEEL_NO_UPDATE_CHECK=1`.

## Runtime targeting

Normal use no longer needs `--target-root`. Run agentwheel inside a runtime folder and it detects
the target:

```bash
cd ~/.openclaw
agentwheel sync github:your-org/agent-pack
```

If the current directory is already the runtime directory (`~/.openclaw`), agentwheel uses its
parent as the root so output lands in `~/.openclaw/skills`, not `~/.openclaw/.openclaw/skills`.
If the current directory contains a runtime directory (`./.openclaw`), that directory is used as
the target under the current project.

For a control-plane setup, define named agents in config. Global config lives at
`~/.agentwheel/config.json`; project config lives at `.agentwheel/config.json`; project values win.

```jsonc
{
  "agents": {
    "lab-openclaw": { "adapter": "openclaw", "root": "/Users/me/.openclaw-home" },
    "docs-copilot": { "adapter": "copilot", "root": "/Users/me/projects/docs" }
  },
  "profiles": {
    "daily": [
      { "agent": "lab-openclaw" },
      { "agent": "docs-copilot" }
    ]
  }
}
```

```bash
agentwheel sync --agent lab-openclaw
agentwheel sync --all
agentwheel sync --profile daily
```

Target resolution order is exact: `--target-root` wins, then `--agent`, then auto-detect from the
current directory, then fallback to the current directory.

## Core ideas

**Three places, one direction:**

| | Where | What |
|---|---|---|
| **Author** | the package's git repo | upstream content — never edited in place |
| **Workspace** | your repo, under `.agentwheel/` | your config, locks, and customizations |
| **Runtime** | `.openclaw/`, `~/.claude/`, … | generated output — never hand-edited |

Flow: **author + your workspace → `sync` → runtime**.

## Packages

A package is a git repo (or folder) with a JSON manifest and a canonical layout:

```jsonc
// agentwheel.json  (plain JSON or JSONC — both work)
{
  "schemaVersion": 1,
  "name": "your-org/agent-pack",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules",        "path": "rules" },
    { "type": "skills",       "path": "skills" }
  ]
}
```

Install only part of a package with `--select <type>/<name>`. `--skill <name>` is a shortcut for
`--select skills/<name>`, and selections saved during `add` are reused by later `sync` and `update`
runs.

```bash
agentwheel add github:NestDevLab/agent-mesh --skill codex-tmux --adapter openclaw
agentwheel sync --dry-run

agentwheel sync github:your-org/agent-pack --select rules/safe-actions.md --select commands/build.md
```

Package authors can mark dependencies as required. Required artifacts are always installed and
cannot be deselected:

```jsonc
{
  "type": "rules",
  "path": "rules/core-safety.md",
  "required": true
}
```

Packages can compose shared files into each directory artifact at staging time. This keeps one
canonical copy in the package repo while installing self-contained skills:

```jsonc
{
  "type": "skills",
  "path": "skills",
  "assets": [
    {
      "from": "packages/tmux-bridge/bin",
      "into": "bin",
      "include": ["*.sh"],
      "mode": "preserve"
    }
  ]
}
```

`mode: "preserve"` keeps executable bits on copied scripts. The composed files are included in
the skill directory hash, so idempotency and drift detection work as if the assets had always
belonged to the skill.

Publish by pushing to any git host. A registry exists only for short names and discovery — it's
optional, and `agentwheel add <url|path>` always works without it.

## How to add a package

The public package registry lives at
[`NestDevLab/agentwheel-registry`](https://github.com/NestDevLab/agentwheel-registry).

1. Create a public repo with `agentwheel.json` and a standard layout such as `instructions/`, `rules/`, `skills/`, `commands/`, `mcp/`, or `hooks/`.
2. Open a pull request to `agentwheel-registry` that adds an entry to `index.json`.
3. Users install by short name:

```bash
agentwheel registry update
agentwheel add your-package-name --adapter openclaw
agentwheel update --dry-run
agentwheel update
```

Example registry entry:

```json
{
  "name": "your-package-name",
  "source": "github:your-org/your-agent-package",
  "type": "package",
  "description": "Reusable skills, rules, and instructions for agentwheel.",
  "tags": ["skills", "rules", "instructions"]
}
```

## Customizing without getting overwritten

Drift detection blocks *accidental* edits to generated files. *Intentional* changes have four channels,
all stored in your `.agentwheel/` (never in the runtime dir, never in the author's repo):

- **Layer** — an editable region in your instructions that updates never touch. (This is how an agent can "remember X durably" without fighting drift.)
- **Add** — extra rule files composed alongside upstream.
- **Override** — replace a specific upstream item, visibly, in the plan.
- **Eject** — take an item into local ownership; updates leave it alone.

## Custom & private runtimes

A runtime adapter is just a config (capabilities + paths). Have an internal runtime you can't publish?
Write a `.jsonc` adapter and point at it — it's a first-class target, and nothing leaves your machine:

```jsonc
{
  "name": "myco-internal",
  "targets": {
    "instructions": { "dest": ".myco/context/AGENTS.md" },
    "rules":        { "dest": ".myco/policy/rules" },
    "skills":       { "dest": ".myco/lib/skills" }
  }
}
```

```bash
agentwheel sync ./my-pack --adapter-config ./myco-internal.jsonc
```

Built-in adapters ship for common runtimes; declarative adapters need no code and stay private.
Programmatic adapters, for private runtime logic beyond file placement, require explicit `--allow-adapter-code`.

Copilot support is intentionally file-drop only: instructions, rules, and prompt/command files are
placed in GitHub-native locations, while raw `SKILL.md` directories stay disabled until there is a
clear conversion format.

## Roadmap

- [x] **v0.1** — install spine: local sources; openclaw/claude/codex adapters; skills/rules/instructions; `plan` · `sync` · `--dry-run` · `uninstall`; manifest + drift + idempotency.
- [x] **v0.2** — git source driver; `update` (pinned & tracking); overlays/additive/override/eject; `init`; hermes + copilot adapters; commands/mcp/hooks artifacts; OpenClaw semantic plugin planning.
- [x] **v0.3** — skillkit/vercel source drivers; optional registry & federation; programmatic adapters behind `--allow-adapter-code`; rich JSON merge for mcp/hooks/settings; profiles.
- [x] **v0.4** — runtime auto-detection; no `--target-root` needed for normal use; fleet config with named agents; global + project config merge; `--agent` and `--all`.
- [x] **v0.5** — asset-includes compose shared files into skills at install time; executable bits preserved; hashes include composed assets.
- [x] **v0.6** — selective installs with `--select`/`--skill`; required artifacts; cached npm update notifier.

## Design docs

- [`DESIGN.md`](DESIGN.md) — architecture & module layout.
- [`LIFECYCLE.md`](LIFECYCLE.md) — publish / install / update / customize model.

## License

See [`LICENSE`](LICENSE).
