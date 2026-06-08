<p align="center">
  <img src="assets/logo-wordmark.svg" alt="agentweave" width="380">
</p>

<p align="center"><strong>One source. Every agent.</strong></p>

<p align="center">
  Weave your skills, rules, and instructions across every AI agent you use —
  from any source, kept in sync, with your private tweaks intact.
</p>

---

## Why agentweave?

Your AI agents are multiplying. Claude here, Codex there, a couple of custom runtimes in the corner — and every one of them wants its skills, its rules, its own little `AGENTS.md`, in its own folder, in its own format.

So you copy-paste. You forget which agent has the latest version. You tweak a rule for one and it drifts out of sync with the rest. Multiply that by a team, and "keep the agents aligned" quietly becomes a part-time job.

**agentweave makes it one job, done once.** Point it at your skills and instructions, tell it which agents you run, and it installs everything where each one expects it — then keeps it that way. Update upstream and your agents update. Make a local tweak and it survives the next update. Add a brand-new runtime nobody's ever heard of? Drop in a small config and it's a first-class target too.

```bash
agentweave add github:your-org/agent-pack
agentweave sync          # installs into every agent you have
agentweave sync --dry-run  # ...or just show me what would change
```

No lock-in. No central gatekeeper. Your packages live in plain git repos, your customizations live in your own repo, and anything reachable by a URL just works.

---

> **Status: early (v0.1).** The install spine is real and tested — local sources, a working
> plan/sync/drift/uninstall flow, and pluggable adapters. The wider lifecycle (git/registry sources,
> `update`, overlays, `init`) is on the roadmap below. Expect sharp edges.

## What it does

- **Installs** skills, rules, and instructions into each runtime's native location.
- **Keeps them in sync** — re-runnable, idempotent, with a manifest and drift detection so nothing silently clobbers your work.
- **Pluggable adapters** — each runtime is described by a small config; add your own without forking.
- **Pluggable sources** — pull packages from local paths, git, or skill ecosystems.
- **Your customizations are first-class** — layer, extend, override, or take full ownership, and survive updates.

## Quick start

```bash
# from a local package directory
agentweave plan ./my-pack --adapter-config ./adapters/openclaw.jsonc --dry-run
agentweave sync ./my-pack --adapter-config ./adapters/openclaw.jsonc
```

`plan` / `sync --dry-run` show exactly what would change before anything is written. They're the commands to trust.

## Core ideas

**Three places, one direction:**

| | Where | What |
|---|---|---|
| **Author** | the package's git repo | upstream content — never edited in place |
| **Workspace** | your repo, under `.agentweave/` | your config, locks, and customizations |
| **Runtime** | `.openclaw/`, `~/.claude/`, … | generated output — never hand-edited |

Flow: **author + your workspace → `sync` → runtime**.

## Packages

A package is a git repo (or folder) with a JSON manifest and a canonical layout:

```jsonc
// agentweave.json  (plain JSON or JSONC — both work)
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

Publish by pushing to any git host. A registry exists only for short names and discovery — it's
optional, and `agentweave add <url|path>` always works without it.

## Customizing without getting overwritten

Drift detection blocks *accidental* edits to generated files. *Intentional* changes have four channels,
all stored in your `.agentweave/` (never in the runtime dir, never in the author's repo):

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
agentweave sync ./my-pack --adapter-config ./myco-internal.jsonc
```

Built-in adapters ship for common runtimes; declarative adapters need no code and stay private.
(Programmatic adapters, for logic beyond file placement, are planned behind an explicit opt-in.)

## Roadmap

- [x] **v0.1** — install spine: local sources; openclaw/claude/codex adapters; skills/rules/instructions; `plan` · `sync` · `--dry-run` · `uninstall`; manifest + drift + idempotency.
- [ ] **v0.2** — git source driver; `update` (pinned & tracking); overlays/additive/override/eject; `init`; hermes + copilot adapters; commands/mcp/hooks artifacts.
- [ ] **v0.3** — registry & federation (skill ecosystems, MCP); semantic plugin targets; profiles; programmatic adapters.

## Design docs

- [`DESIGN.md`](DESIGN.md) — architecture & module layout.
- [`LIFECYCLE.md`](LIFECYCLE.md) — publish / install / update / customize model.

## License

See [`LICENSE`](LICENSE).
