# agentwheel — Design Blueprint (MVP)

> Multi-runtime agent artifact orchestrator. Weaves a **source layer** (skills/instructions
> ecosystem) and an **install/adapter layer** (per-runtime placement) into one thin,
> pluggable, single-language (TypeScript) tool.

Status: **design agreed** (2026-06-08). Engine decision: **own in TS** — do NOT depend on
agent_sync's code; reuse only its proven *design* (JSON target schema + drift/manifest model).
Consume SkillKit's `@skillkit/core` as a **library** for the source layer (never its installer/CLI text).

## Why this exists
Surveyed landscape (mid-2026): Microsoft APM (hardcoded targets, no 3rd-party adapters),
Vercel `skills` (skills-only, openclaw+hermes native but enum-hardcoded), SkillKit (strong
source/ecosystem, Apache-2, but plugin API not wired to install path), agent_sync (only tool
with *working* pluggable file-drop adapters + full artifact scope, but bash/9★/no-LICENSE/single-dev).
None is a pluggable, full-scope, multi-runtime installer that natively covers our home runtimes
(OpenClaw, Hermes) including **plugins**. agentwheel fills that gap.

## Three-layer architecture
```
LAYER 1  SOURCE      external, consumed: @skillkit/core (lib) + Vercel skills + git/local
LAYER 2  ORCHESTRATOR  ours (TS): source-contract, staging, manifest-hash, plan
LAYER 3  INSTALL     ours (TS): atomic copy + drift + adapters + semantic plugin targets
```
Layers 2+3 = one TS package. SkillKit used as **source only** (fetch/scan/translate) → avoids
the "two competing installers" conflict; only agentwheel writes into runtime dirs.

## Module layout (single TS package for MVP)
- `source/` — `SourceDriver` contract: `resolve / list / fetch / scan / translate / export`.
  Drivers: `local`, `git`, `skillkit` (via `@skillkit/core`, NOT the CLI). Later: `vercel-skills`.
- `staging/` — deterministic staging dir, normalize artifacts, hash/lock/cache → `StagedBundle`.
- `model/` — artifact types (instructions, rules, skills, commands, subagents, mcp, hooks, plugins)
  + JSON/JSONC target/adapter schema (design inspired by agent_sync) + **zod** validation.
- `install/` — plan (diff → dry-run → apply), atomic copy, drift detection, idempotency,
  install manifest (separate from source lock), controlled uninstall/cleanup.
- `adapters/` — pluggable file-drop adapters: `openclaw`, `claude`, `codex` (then `hermes`, `copilot`).
  Each declares capabilities + paths + transforms. **Pluggable without forking** (the core requirement).
- `targets/plugins/` — **semantic** (non file-copy) targets. `targets/plugins/openclaw.ts` shells to
  `openclaw plugins install`. (Deliberately NOT a top-level `plugins/` dir — avoids confusion with
  OpenClaw/Hermes plugins.)
- `cli/` — `init, add, list, fetch, scan, plan, install, update, uninstall, doctor`.
  `install --dry-run` is the central trust command.

**Two "spines" to define first:** the `SourceDriver` interface and the install-manifest schema.

## Scope by version
- **v0.1** (end-to-end proof): runtimes `openclaw + claude + codex`; artifacts `skills + rules +
  instructions`; sources `local + git + skillkit`; commands `list / scan / plan / install[--dry-run] / uninstall`.
- **v0.2:** runtimes `hermes + copilot`; artifacts `commands + mcp + hooks`.
- **v0.3:** semantic `plugins:` targets; advanced uninstall; profiles; explicit Vercel-skills driver.

## Tooling
- pnpm · build **tsup** · test **vitest** · schema **zod** · config parse **jsonc-parser** (reads
  plain JSON natively + JSONC) · CLI **commander** · hashing Node `crypto` · `@skillkit/core` as a
  **pinned** dependency (version/commit, not vendored initially). **No YAML anywhere** — JSON/JSONC only.
- Lifecycle/storage/distribution model: see `LIFECYCLE.md`.
- Two lock files: **source-lock** (what was resolved/fetched + upstream hash + driver/version) and
  **install-manifest** (what was written into runtimes + expected hash).
- Install-manifest entries include a `workspaceOwner` identifier derived from the workspace config root.
  Reconcile only removes or updates entries owned by the current workspace. Entries owned by another
  workspace are reported as `KEEP` and preserved in the manifest. Older v2 entries without
  `workspaceOwner` are read as `legacy:unowned`; unmatched entries stay foreign/kept, while exact
  same-path, same-source clean matches are adopted by the current workspace on apply.

## OpenClaw boundary (hard rules)
- Plugin installs use ONLY public API/CLI: dry-run prints the command; apply calls
  `openclaw plugins install --link <path>` (or supported form); config only via documented commands.
- NEVER touch OpenClaw core or undocumented internal files.
- Restarts / runtime activations require **explicit operator approval**.

## Biggest MVP risk
Underestimating the install layer. Drift / cleanup / uninstall / atomicity / semantic plugins look
like "just copy files" but become **state management** fast. Mitigation: small manifest first,
strong test fixtures, `plan`/`dry-run` as the central, trusted behavior.

## Design lineage
- agent_sync's file-drop adapter model and drift/manifest approach are the design reference/benchmark;
  agentwheel reimplements the ideas in TypeScript rather than depending on it.
- SkillKit's `@skillkit/core` is consumed as a source-layer library, not as an installer.
