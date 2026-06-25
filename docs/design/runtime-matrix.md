# Runtime Matrix & Artifact-Delivery Model — Working Draft

> **Status: WORKING DRAFT, co-edited.** Built from **real harness sources**: local installs (`~/.codex` v0.141, `~/.claude`, `~/.openclaw`, `~/.hermes`), the OpenClaw core (`~/.openclaw/lib/node_modules/openclaw`), and official docs for Codex, Copilot CLI, Claude Code, Hermes Agent, OpenClaw. NOT from agentwheel's adapter declarations, which **massively under-declare** native support.

## Key finding
The harnesses are modern agent runtimes that are **largely capability-equivalent**. Most "gaps" were agentwheel *not wiring* a target the harness already supports — not real limitations. Notably:
- **OpenClaw ≈ a Hermes successor/relative** — it bundles a *Hermes importer* (`openclaw migrate hermes`) and has a similar gateway+channels+agents architecture. This is **lineage, NOT a shared live core** (no `hermes` dependency; the `hermes` source refs are migration code; OpenClaw drives openai/anthropic/codex/gemini backends). Capability similarity is plausible but **unverified for Hermes specifically** — Hermes cells stand on Hermes's own evidence only.
- **skills, plugins, mcp, subagents, instructions** are **native on all five** harnesses. The portability story is far stronger than the old matrix implied.
- Genuinely non-native cases are few: behavioral **rules** (true native only on **Claude**; elsewhere delivered via `instructions`) and **commands** on Codex/Hermes.

## Scope of a cell
Each cell grades a **deployable artifact** — a file/dir/config block agentwheel can install & manage that the harness natively consumes. Two things are NOT separate artifacts: (a) **pure-runtime behavior** with no managed surface — gateway **chat-commands** (Telegram/Discord), built-in CLI slashes (`/tools`,`/skills`), `delegate_task` spawning — genuinely nothing to deploy; (b) **config-driven capabilities** (e.g. OpenClaw `agents.list`, Hermes `delegation:`) whose knobs live in the harness config file → managed via the single **`settings`/config-merge**, not as their own `subagents`/`hooks` artifact. So `➖` in a row means "no dedicated artifact here," not "out of scope entirely."

## Legend
- ✅ **native + wired** — harness supports it AND agentwheel adapter already targets it.
- 🟡 **native, NOT wired** — harness supports it natively; agentwheel doesn't declare it → **implementable now** (add adapter target).
- 🔵 **native-alt** — not a native capability here; achieve via another native artifact (documented), no emulation.
- ➖ **runtime-only** — harness HAS the capability natively, but it's runtime/config-driven with **no installable artifact** (configured via the harness's own config / `settings`).
- ⚠️ **not fully supported** — possible but **undocumented / config-dependent**; agentwheel neither claims nor rules it out.
- ❌ **not native** · ❓ **unconfirmed**.

## Matrix (real native support · feasibility)

| Artifact | Claude | Codex | OpenClaw | Hermes | Copilot |
|---|---|---|---|---|---|
| **instructions** | ✅ `CLAUDE.md` | ✅ `AGENTS.md` | 🟡 user¹ · ⚠️ local¹⁹ | ✅ `AGENTS.md` | ✅ `copilot-instructions.md` |
| **rules** (behavioral) | ✅ `.claude/rules`² | 🔵 instructions³ | 🔵 instructions¹⁸ | 🔵 instructions⁹ᵇ | 🔵 `.github/instructions`⁴ |
| **skills** | ✅ | ✅ `.agents/skills` | ✅ | ✅ hub | ✅ `.github/skills` |
| **commands** | ✅ `.claude/commands` | ❌⁵ | ➖¹⁸ | ➖⁹ᵇ | ✅ `.github/prompts`⁷ |
| **subagents** | ✅ `.claude/agents` | ✅ `multi_agent`⁸ | ➖¹⁸ | ➖¹⁷ | ✅ `.github/agents` |
| **mcp** | ✅ `.mcp.json` | ✅ `config.toml` | 🟡 native¹⁰ | 🟡 `mcp_servers`⁹ | ✅ `mcp-config.json` |
| **hooks** | ✅ `settings.json` | ✅ native¹¹ | ➖¹⁸ | ➖⁹ᵇ | ✅ native¹³ |
| **settings** | ✅ `settings.json` | 🟡 `config.toml` | 🟡 `openclaw.json` | 🟡 `config.yaml`⁹ | 🟡 config¹³ |
| **plugins** | 🟡 native¹⁴ | 🟡 native¹⁵ | ✅ `.openclaw/plugins` | 🟡 native¹⁶ | 🟡 native¹³ |
| **fragments** | compose-only — never installed at runtime ||||| 

¹ OpenClaw core reads `AGENTS.md`/`CLAUDE.md`/`Instructions`; built-in adapter only declares `skills`+`plugins`.
² Claude is the only **native behavioral-rules** artifact (path-scoped via `paths:`). (OpenClaw has an internal rules loader but no user-deployable rules-file artifact — see ¹⁸.)
³ Codex `.codex/rules` is **command-policy** (`allow/prompt/forbidden`) — different semantics; behavioral guidance → `instructions`.
⁴ Copilot `.github/instructions/*.instructions.md` = path-specific **instructions**, not a separate rules engine.
⁵ Codex CLI has no slash/prompt-command artifact. ⁷ Copilot `.github/prompts` = prompt files (semantics ≠ Claude slash commands). ⁸ Codex `[features] multi_agent=true`, `.codex/agents` (TOML agent files). ⁹ Hermes Agent (Nous Research): native subagents, `mcp_servers:` block + `/reload-mcp`, `config.yaml` settings, `~/.hermes/plugins`. ⁹ᵇ **Unverified for Hermes.** OpenClaw ships only a *bundled Hermes importer* (`openclaw migrate hermes`); it does **not** embed Hermes's core. Hermes cells use Hermes-own evidence: subagents ➖ and rules→instructions confirmed; commands/hooks ➖ as gateway-runtime (hooks pending Hermes-specific confirmation).
¹⁰ OpenClaw core: 859 `MCP` refs. ¹¹ Codex hooks native with trust model (`--dangerously-bypass-hook-trust`).
¹³ Copilot: hooks/plugins native; plugins bundle mcp+agents+skills+hooks (installed from GitHub repos); config via `~/.copilot` + `COPILOT_HOME`.
¹⁴ Claude plugins native (`~/.claude/plugins`, `marketplaces`); claude adapter declares **no** plugins target.
¹⁵ Codex `codex plugin {add,list,marketplace,remove}` + `openai-curated`; codex adapter declares **no** plugins target.
¹⁶ Hermes plugins native (`~/.hermes/plugins/` or pip, runtime-discovered). ¹⁷ Hermes **has** subagents (native runtime: `delegate_task`, roles `leaf`/`orchestrator`), but **no deployable artifact** — configured only via `config.yaml` `delegation:` and spawned dynamically; no agent-definition file to install.
¹⁸ OpenClaw is a **gateway runtime** — rules/commands/subagents/hooks are config in `openclaw.json` or runtime gateway features (slash-commands; `BOOT.md`/plugin hooks; `agents.list`), **not deployable artifacts**. Earlier local-grep readings (`CommandsDir`/`AgentsDir`/`loadRules`) were internal plumbing; the private `custom-commands/` folder was a Telegram plugin. Source: docs.openclaw.ai.
¹⁹ OpenClaw is workspace-centric (`agents.defaults.workspace`, per-agent at most), not per-project. **`local`/project-scoped `instructions` = "not fully supported"** — NOT impossible: OpenClaw *might* read a project file depending on the workspace model the user configures, but that's **not documented native behavior**, so agentwheel neither claims nor rules it out. **User-level** instructions are fully supported (workspace `AGENTS.md`).

## Target state — after wiring

| Artifact | Claude | Codex | OpenClaw | Hermes | Copilot |
|---|---|---|---|---|---|
| **instructions** | ✅ | ✅ | ✅ user · ⚠️ local | ✅ | ✅ |
| **rules** | ✅ | 🔗 | 🔗 | 🔗 | 🔗 |
| **skills** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **commands** | ✅ | ❌ | ➖ | ➖ | ✅ |
| **subagents** | ✅ | ✅ | ✅\*ᵃ | ➖ᵇ | ✅ |
| **mcp** | ✅ | ✅ | ✅\* | ✅\* | ✅ |
| **hooks** | ✅ | ✅ | ✅\* | ➖ | ✅ |
| **settings** | ✅ | ✅\* | ✅ | ✅ | ✅\* |
| **plugins** | ✅ | ✅ | ✅ | ✅ | ✅ |

**Legend:** ✅ native file artifact · ✅\* via **config-merge** into the harness's config file · 🔗 via **`instructions`** (managed block; see below) · ➖ **no separate artifact** · ❌ no native capability · ⚠️ undocumented/config-dependent.

> **What ➖ means (important):** it is NOT "ignored." On the gateway runtimes (OpenClaw/Hermes) there are no standalone `subagents`/`commands`/`hooks` artifacts — but their **config knobs** (`agents.list`, `delegation:`, mcp/hooks config) all roll into the **single `settings` config-merge** (the ✅\* cell). The only thing **truly out of scope** is pure-runtime *behavior* with no managed surface: gateway slash-command dispatch, and `delegate_task` spawning at execution time. So ➖ = "no dedicated artifact; config (if any) lives in `settings`," and the genuinely-runtime part = nothing to deploy.
>
> ᵃ **OpenClaw subagents = YES** — agent definitions live in `agents.list` (`openclaw.json`) → created via the `settings`/config-merge (like Codex `.codex/agents/*.toml`, but config not files). ᵇ **Hermes subagents = no** — no *named* agent definitions; `delegate_task` spawns by role at runtime, only `delegation:` knobs exist (those are `settings`) → nothing to "create."

## Instructions & Rules — delivery model (final)

**`rules` and `instructions` are different artifacts — no DRY bridge between them.**
- `rules` = Claude-native, path-scoped behavioral guidance (`paths:` frontmatter). **Claude only.** Not delivered elsewhere.
- `instructions` = cross-harness always-on guidance, delivered to each harness's instruction surface.
- DRY still applies *within* instructions: one `fragments/x.md` composed into multiple harnesses' instruction files. It just no longer bridges rules↔instructions (that overlap caused same-harness duplication/ambiguity).

**Instruction-loading semantics (verified online, all 5):**

| Harness | Instruction file(s) | Merge | Import | Notes |
|---|---|---|---|---|
| Claude | `CLAUDE.md` (hierarchy) + `.claude/rules/*.md` | additive | `@import` (5 deep) | does **NOT** read `AGENTS.md` |
| Codex | `AGENTS.md` (root→cwd cascade) + `~/.codex/AGENTS.md` | additive | `@./path.md` | `AGENTS.override.md` = **REPLACE** (don't use) |
| Copilot | `AGENTS.md` + `CLAUDE.md` + `.github/instructions/*` + `copilot-instructions.md` | additive | — (applyTo) | **greedy — reads every convention** |
| OpenClaw | workspace `AGENTS.md` (+ `SOUL.md`…) | additive (fixed set) | — | workspace-centric; no per-project surface (¹⁹) |
| Hermes | project `AGENTS.md` + `~/.hermes/SOUL.md` | additive (layered) | — | — |

All **additive** — no file silently replaces another, so a managed block is safe. `AGENTS.md` is the **shared** file (Codex+Copilot+Hermes); `CLAUDE.md`/`.claude` are Claude's; **Copilot reads everything**.

**Delivery = a managed BLOCK in the instruction file** (not whole-file seizure, not a "go read other files" loader):
- agentwheel writes a delimited block — **reuse the existing `<!-- BEGIN openpack:include … sha256 -->` markers**, don't invent a second system. The block holds the real composed content (from `fragments/`).
- **One content file → no duplication.** The `AGENTS.md` block reaches Codex/Copilot/Hermes once each.
- **Claude (bridge-aware):**
  - If `CLAUDE.md` already bridges `AGENTS.md` — via `@import` **or symlink** (detected by **realpath**) — Claude reads the AGENTS.md block. Do **nothing** to `CLAUDE.md`.
  - Else → write the block to `CLAUDE.md`.
- **Never create a new bridge** (`@import`/symlink): injecting `@AGENTS.md` into a user's `CLAUDE.md` would make Claude inherit the user's *whole* AGENTS.md — a behavior change we must not cause.
- **Do NOT also create `.github/instructions`** when `AGENTS.md` is used (Copilot would read the block twice).
- **realpath dedup**: resolve every target to its realpath; write each physical file once, count it once (handles symlinked `CLAUDE.md`↔`AGENTS.md`).
- **OpenClaw**: user-level only (workspace `AGENTS.md` block). `local`/project = ⚠️ not fully supported (¹⁹).

**Copilot duplication — disclaimer + detect&warn (out of scope to auto-fix):**
If `CLAUDE.md` and `AGENTS.md` are **separate** (no bridge) **and Copilot is active**, the block lands in both → Copilot reads it **twice** (redundant context, **not a bug**). agentwheel does **not** auto-resolve this (user's to manage) but **detects and warns** at install/plan time (it inspects files + knows active harnesses). Documented edge.

**Safety — the block is owned, never the user's content:**
1. **Markers + sha** → drift detection on the block.
2. **Adoption guard** — never silently clobber an unmanaged user file (already in `install/plan.ts`; needs explicit `--adopt`/`--force`).
3. **Stable position** (top or bottom) → no ordering churn.
4. **Banner**: `<!-- agentwheel-managed: edit fragments, not this block -->` (advisory; the sha is the enforcement).
5. **Clean uninstall** — remove only the block (manifest-tracked); the rest of the user's file is untouched.

## Wiring plan (implementation order)
1. **Validation / guardrails** (additive, low-risk): `plugins` requires `format` per harness (`claude-plugin`/`codex-plugin`/`hermes-plugin`/`copilot-plugin`/`openclaw-plugin`); `rules` = behavioral-markdown-only (Codex `.codex/rules` command-policy is NOT this artifact); incompatible-format = **skip-with-warning** when other installable content exists, fail only on explicit/sole selection (recover stash `rules-format-filter-e4e6dd4`).
2. **Plugins** — wire native plugin targets for Claude/Codex/Hermes/Copilot (only OpenClaw declared today).
3. **`settings` config-merge** — one target per harness into its config file (`config.toml`/`openclaw.json`/`config.yaml`/copilot); covers mcp+hooks+agents-config for the gateway runtimes (✅\* cells). Reuse JSON/TOML merges; +1 small YAML merger for Hermes.
4. **OpenClaw native targets** — wire `instructions` (user-level), `mcp`, `settings` (built-in only has skills+plugins today).
5. **Instructions delivery engine** — managed-block writer (openpack:include markers + sha), bridge detection (realpath + `@import`), Copilot detect&warn, adoption guard, uninstall block-removal.
6. **Drop file-drop emulations** — `.openclaw/rules`, `.hermes/*` file-drops; replace with native targets / config-merge.
7. **Docs + tests** — update `artifact-harness-compatibility.md`; add path-resolution + negative tests per mapping (per the repo's own `AGENTS.md` rules).

## Decisions (settled)
- `rules` = behavioral Markdown, **Claude-native only**; others get behavioral guidance via `instructions` (🔗). Codex `.codex/rules` (command-policy) is **not** this artifact → out of `rules` (separate future type or unsupported).
- `rules` and `instructions` are **distinct content** (no fragment bridge between them); DRY stays *within* instructions.
- Instructions delivered as a **managed block** in the harness's instruction file, **bridge-aware + realpath-dedup**, with the Copilot-separate-files case disclaimed + warned.
- `unsupported`/incompatible-format = **skip-with-warning**, not hard-fail (when other content is installable).
- **Deployable-artifact vs runtime-feature**: the matrix grades only deployable artifacts; pure-runtime features (gateway slash-commands, `delegate_task` spawning) are out of scope.

## Open items (confirm before/while wiring)
- **Hermes specifics** (its core isn't on this machine, only its skills hub): confirm rules/hooks surface and whether it loads an arbitrary extra instruction file. Do **not** extrapolate from OpenClaw — they share lineage via a migration importer, **not** a live core.
- **OpenClaw** exact dest/format for the `settings` config-merge (`openclaw.json`), and whether any project-level instruction read is configurable (¹⁹).
- **Copilot realpath dedup**: does Copilot collapse symlinked `AGENTS.md`/`CLAUDE.md`? If yes, the symlink case avoids the double entirely.

## Implementation — team, parallelization & checklist

**Roles**
- **PM = Claude** — owns this doc + checklist + sequencing + acceptance gates; reviews each PR (green build/tests + matches design) before approving merge; reports to user. Does **not** write impl code.
- **Team Lead = Codex** (single `agent-tmux` session in the agentwheel repo) — owns execution; spawns the developer subagents; drives **syncwheel** for branch/worktree per workstream; opens **1 PR per parallelizable unit**; runs build+test+lint; integrates. Does **not** commit/push until PM review is green AND user has approved (per repo + global git rules).
- **Developers = Codex subagents** — one per workstream below.

**Conflict model (corrected after Codex code review).** Adapter *files* are separate, but several **shared surfaces** key off target metadata and would collide or must be present first: `src/model/adapter.ts:14` (`targetMappingSchema`), `src/install/plan.ts:44` (`InstallOperation.mergeStrategy` union), `src/install/apply.ts:393` (apply dispatch), `src/model/manifest.ts:21` (manifest schema), and shared tests (`test/artifact-compatibility.test.ts:84`). So:
- **Per-adapter PRs are parallel ONLY after the foundation lands** — they then touch only their own `src/adapters/<h>.ts` + a per-adapter test file (NOT the shared compatibility test).
- **`plan.ts` is a serial chain**: F1 (mergeStrategy union) → P1 (skip-with-warning filtering) → P3 (instructions engine) all touch it; they must merge in that order.
- **Shared tests + docs are integration territory** (C2), not edited inside adapter PRs.

**Dependency layers**

```
Layer 0 — FOUNDATION (1 serial PR, blocks everything):
  F1+  schema + mergeStrategy plumbing:
       src/model/adapter.ts  (targetMappingSchema: + merge "yaml-deep", managed-block mode, new semantic/format enums)
       src/install/plan.ts:44  (InstallOperation.mergeStrategy union: + yaml-deep)
       src/install/apply.ts:393  (dispatch: + yaml-deep)
       src/model/manifest.ts:21  (manifest schema)
       src/install/yaml-merge.ts  (NEW merger, mirror json/toml)
       package.json  (promote `yaml` to a DIRECT dep — transitive today)
        │
        ▼
Layer 1 — PARALLEL after L0 (1 PR each; own adapter file + own test file):
  P2a claude.ts    P2b codex.ts    P2c openclaw.ts    P2d hermes.ts    P2e copilot.ts

  ── plan.ts serial chain (runs alongside Layer 1, but P1→P3 strictly ordered):
  P1  validation + planning  ── validation/artifacts.ts + plan.ts:103 + resolve/render.ts:121 + lifecycle/source-plan.ts:187
        │
        ▼
  P3  instructions engine    ── NEW src/install/instructions-block.ts + plan.ts + apply.ts

Layer 2 — INTEGRATION (serial, last):
  C1  drop stale file-drop emulations
  C2  docs + SHARED tests (artifact-harness-compatibility.md + test/artifact-compatibility.test.ts)
```

**Checklist**

- [x] **F1+ — Schema + mergeStrategy plumbing** (Layer 0) — **MERGED (PR #23)**. `targetMappingSchema` (`adapter.ts`) gains `merge: "yaml-deep"`, a managed-block instruction mode, and any new `semantic`/`format` enums; extend the `InstallOperation.mergeStrategy` union (`plan.ts:44`), apply dispatch (`apply.ts:393`), and manifest schema (`manifest.ts:21`); add **`src/install/yaml-merge.ts`** (deep-merge, mirror `json-merge.ts`/`toml-merge.ts`); **promote `yaml` to a direct dependency** in `package.json` (transitive-only today). *Merge first; everything branches off it.*
- [x] **P2a — claude.ts**: add `plugins` target (native `~/.claude/plugins`).
- [x] **P2b — codex.ts**: add `plugins` target; **remove the `rules` (command-policy) target** per decision (not this artifact → unsupported / future `command-policy` type).
- [x] **P2c — openclaw.ts**: add `instructions` (user-level workspace `AGENTS.md`), `mcp` (→ `mcp.servers.<name>` in `openclaw.json`), `settings` (generic **json-deep** merge into `~/.openclaw/openclaw.json` — NOT a separate file; subagents config lives at `agents.list[]`).
- [x] **P2d — hermes.ts**: add `instructions` (user-level), `mcp` (→ top-level `mcp_servers:` in `~/.hermes/config.yaml`), `settings` (**yaml-deep** merge, top-level `delegation:`/`mcp_servers:`), `plugins`. **Also add `yaml-deep` structural validation in `validation/artifacts.ts`** (Layer 0 wired the merger + dispatch but not validation — coordinate with P1).
- [x] **P2e — copilot.ts**: add `plugins`, `settings` targets.
- [x] **P1 — Validation + planning guardrails** (serial: after F1, before P3): `plugins` require per-harness `format` (`{claude,codex,hermes,copilot,openclaw}-plugin`); `rules` = behavioral-markdown only; **skip-with-warning** when other installable content exists, hard-fail only on explicit/sole selection. Touches `validation/artifacts.ts` **+ `plan.ts:103` + `resolve/render.ts:121` + `lifecycle/source-plan.ts:187`** (validation alone only throws; skipping changes which artifacts become operations). **Seed from stash `rules-format-filter-e4e6dd4`** but it's **stale** — it still preserves Codex command-policy rules and only filters format incompatibility; finish per the decision (drop command-policy, extend to render/source-plan).
- [x] **P3 — Instructions delivery engine** (serial: after P1): `src/install/instructions-block.ts` (new) + `plan.ts`/`apply.ts`. Managed block reusing `openpack:include … sha256` markers; bridge detection (realpath + `@import`); Copilot detect&warn on separate-files duplication; adoption guard; uninstall = block-removal only.
- [x] **C1 — Drop stale emulations**: remove any `.openclaw/rules` / `.hermes/*` file-drop targets; replace with native/config-merge.
- [x] **C2 — Docs + shared tests**: update `artifact-harness-compatibility.md`; update shared `test/artifact-compatibility.test.ts` + add path-resolution/negative tests per mapping.

**Resolved open items (Codex review, code/doc-verified):**
- **OpenClaw**: dest `~/.openclaw/openclaw.json` (JSON5). MCP → `mcp.servers.<name>` (`zod-schema.d.ts:4567`); subagents → `agents.list[]` (live config + `zod-schema.agents.d.ts:501`); settings → generic json-deep into the same file.
- **Hermes**: `~/.hermes/config.yaml`, top-level `mcp_servers:` and `delegation:`, YAML deep-merge.
- **P1 location**: requires `plan.ts` + graph render + source-plan, not validation-only → **P1 and P3 serialized**.
- **Stash `rules-format-filter-e4e6dd4`**: 8 files / +212; adds `artifactFormatCompatibility`, filters incompatible rule formats in planning + render, warnings, tests. Conceptually seeds P1 but stale (keeps Codex command-policy).

**Codex verdict: GO on Layer 0** with the corrected (expanded) Layer-0 scope; do **not** start the five adapter PRs until the shared schema/mergeStrategy plumbing is merged.

### Integration status — COMPLETE, main green @ `2c2b9c7` (298 tests, CI success)
All workstreams merged; zero leftover syncwheel worktrees/stacks/branches verified.
- **#30 (P3):** managed instruction-block engine merged (`38a5a97`). **#31 (C1+C2):** no stale file-drop emulations found in adapters/staging; `artifact-harness-compatibility.md` + compatibility tests updated (`2c2b9c7`).
- Known behaviors documented in C2: (a) installing `instructions` into a pre-existing unmanaged CLAUDE.md/AGENTS.md raises an adoption conflict → needs `--adopt`/`--force` (non-destructive append by design); (b) Copilot double-read warning is currently one-directional (fires only from the Claude/CLAUDE.md path).

#### Layer 1 detail — main green @ `4748aea` (276 tests, CI success)
- **Merged:** F1+ (#23), P2a Claude plugins (#24), P2e Copilot plugins+settings (#25), P2c OpenClaw config (#27), P2d Hermes config (#28).
- **Rules-change unit (#26):** integrated P2b + P1 + C2 shared-test updates as ONE green unit (#29 closed as superseded). Final state: Codex has **no** rules target; `.rules` command-policy unsupported; incompatible rules **skip-with-warning** when other codex content exists, hard-fail only on sole/explicit selection.
- **Dest checks resolved:** Codex plugins **local** dest `"plugins"` confirmed correct (repo-local `$REPO_ROOT/plugins/<plugin>` via `.agents/plugins/marketplace.json`); Hermes user-instructions `~/.hermes/SOUL.md` wired as `managed-block`.

## Sources
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md) · [Codex subagents](https://developers.openai.com/codex/subagents) · [AGENTS.override.md = replace](https://ai.sulat.com/codex-guide-agents-md-cascading-rules-and-the-optional-agents-override-md-1f4c81767e92)
- [Claude memory/CLAUDE.md](https://code.claude.com/docs/en/memory) · [Claude subagents](https://code.claude.com/docs/en/sub-agents) · [Claude does not read AGENTS.md (issue)](https://github.com/anthropics/claude-code/issues/6235)
- [Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) · [Copilot enterprise plugins](https://smartscope.blog/en/generative-ai/github-copilot/copilot-cli-enterprise-managed-plugins/)
- [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/) · [Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation) · [Hermes prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- [OpenClaw agent workspace](https://docs.openclaw.ai/concepts/agent-workspace) · [OpenClaw config](https://docs.openclaw.ai/cli/config)
