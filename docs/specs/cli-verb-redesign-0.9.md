# CLI Verb Redesign — Spec for v0.9.0

**Status:** approved by Joseph (2026-06-11). This document is the single source of truth for the redesign; it supersedes the conversational decisions made in earlier sessions. The decisions below were validated against the actual code at HEAD (file/line references included).

## Goal

Replace the `sync`-centric vocabulary with a conventional package-manager vocabulary (`add` / `install` / `update` / `uninstall`) while keeping the declarative reconcile model intact. Breaking release: **0.9.0**. There are no external users yet, so no long compatibility tail — but one deprecation shim is required (see §4) because the auto-installed bootstrap skill self-heals through it.

## 1. Final command table

| Command | Semantics |
|---|---|
| `add <source>` | Validate + resolve the source, write the entry to `.agentwheel/config.json`. Never touches runtimes. (Unchanged behavior; new: prints a next-step nudge, see §6.) |
| `install` | Reconcile **all** configured packages into the runtime targets: install what's missing, update what's stale **per the lock**, remove what's no longer declared. This is today's bare `sync`. Does **not** move tracking refs forward (see §2). |
| `install <name-or-source>` | **Ensure** semantics: if the argument matches a configured package (match by name OR source, same matching logic `uninstall <package>` already uses), perform a **scoped reconcile** of just that package. If it does not match, resolve it as a source, `add` it to config, then scoped-reconcile it. One-shot add+install, like `pnpm add`. |
| `update [name]` | Re-resolve **tracking** sources to latest (pinned packages are skipped — respect `mode`), then apply. With `[name]`, scoped to one configured package. Absorbs the old "sync = update everything" meaning. |
| `uninstall <name-or-source>` | Remove from runtimes AND from config (current behavior). |
| `uninstall <name> --keep-files` | New flag: eject the package's artifacts (transfer ownership to the user, same mechanism as `eject`) and remove the entry from config. The files stay but become unmanaged, so a later `install` will NOT remove them. This replaces the rejected `del` idea — a "remove from config but leave managed files" command would be undone by the next reconcile. |
| `plan [name]` | Preview of what `install` would do. Must become genuinely read-only (see §7.3). |
| `status` | **New command.** Show desired vs actual state: configured packages, their install state per target, drift, and the configured-but-not-installed half-state that the add→install split creates. Today nothing exposes this (`list <source>` inspects remote sources only). |
| `sync` | **Removed from the public vocabulary.** Hidden forwarding shim for exactly one minor release (§4). |
| `init`, `list`, `scan`, `deps`, `registry`, `trust`, `package`, `eject`, `remember` | Unchanged, except for the nudges/help fixes in §6. Note: `registry update` keeps its name — it is namespaced and imperative (refresh local cache), no collision with top-level `update`. |

Mental model to encode everywhere (help, README, skill): **`install` = "make what is declared true"; `update` = "move the declaration forward, then make it true".**

## 2. The install/update split requires lock-as-input resolution

Today the graph lock is an *output* of apply and is only read as a resolution input under `--frozen-lock` (`src/resolve/graph.ts:233`). For the table above to be honest, bare `install` must resolve tracking sources **from the lock by default** (frozen-style), and only `update` re-resolves them to latest. Concretely:

- `install`: locked resolution by default. A configured package with no lock entry yet (just added) resolves fresh — that is the "install what's missing" case, not an update.
- `update [name]`: bypasses the lock for tracking sources, re-resolves, applies, writes the new lock.
- `--frozen-lock` keeps its CI meaning: hard-fail if resolution would differ from the lock (instead of silently resolving fresh for missing entries).

**If this resolver change turns out to be substantially more invasive than expected, STOP and report back before compromising the semantics** — do not ship an `install` that silently chases latest, and do not ship a lock-bumping `update` that the next install re-resolves away. Renaming without the semantic split is not an acceptable fallback unless Joseph explicitly approves it.

Related cleanup: `update` is currently byte-identical to bare `sync` — `buildGraphPlansForTarget` ignores its behavior argument (param named `_behavior`, `src/cli/index.ts:607-608`), and the pinned-skip logic (`shouldUpdatePackage`) lives only in `runConfiguredPackages`, which has **zero callers**. Delete the dead path; implement pinned-skip in the live graph path.

## 3. Teaching errors — never "Did you mean uninstall?"

Verified today: `agentwheel install X` prints commander's `error: unknown command 'install' (Did you mean uninstall?)` — it steers users (and especially LLM agents, the primary users) toward the destructive opposite. After the redesign:

- `install <arg>` where `<arg>` matches nothing configured and fails to resolve as a source → a purpose-built error that echoes the argument in copy-pasteable form:
  ```
  'foo' is not a configured package and could not be resolved as a source.
    To add and install:   agentwheel install <source>   (e.g. github:org/pack)
    To see what's configured:   agentwheel status
  ```
- Audit other near-miss commands so commander's suggestion machinery never proposes a destructive command as a typo fix for an additive one.

## 4. `sync` deprecation shim (one release only)

The auto-installed bootstrap skill references `agentwheel sync` 26 times and only self-heals by *successfully running a reconcile* — old skill text will invoke `sync`, so a hard removal bricks the self-update channel of already-bootstrapped workspaces.

- Implement `sync [source]` as a **hidden sibling command** (NOT commander `.alias()`, which can't print a notice and would show in help): forwards bare `sync` → `install`, `sync <source>` → `install <source>`, passing through shared flags.
- On every invocation print to **stderr**: `warning: 'agentwheel sync' is deprecated and will be removed in 0.10. Use 'agentwheel install'.`
- Excluded from `--help` output. Remove entirely in 0.10.
- `sync <source>`'s old half-persistence bug (ad-hoc root written into the graph lock but never into config, so the next bare run plans its removal — `src/cli/index.ts:638` area) dies by construction: the shim forwards to `install <source>`, which persists to config.

## 5. Bug fixes shipping in the same release

1. **`--no-deps` is a no-op.** Registered as `.option("--no-deps", ...)` (commander stores it as `options.deps`, default `true`, `false` when passed) at `src/cli/index.ts:173/214/296/324`, but every read site uses `options.noDeps` (lines ~182/233/257/674), which is always `undefined`. Fix the reads; add a regression test that `--no-deps` actually skips transitive resolution; check for the same pattern on any other `--no-*` flag.
2. **Dead code**: remove `runConfiguredPackages` (`src/cli/index.ts:847` area) and fold its `shouldUpdatePackage` pinned logic into the live path (§2).
3. **Missing help text**: `init`, `add`, `list`, `scan`, `plan`, `sync`(→`install`), `update`, `remember`, `eject`, `uninstall`, `deps tree`, `deps why`, `trust forget` have no `.description()`. Add one-line descriptions to every command and subcommand, plus at least one usage example in the top-level `--help` epilog for the core flow (`add` → `install`).
4. **Misleading source help**: `plan`/`install` arg help says "source directory" but accepts local path / git / registry sources — fix the wording.

## 6. UX nudges and stale strings

- After `add`: print `Added <name>. Preview: agentwheel plan — Apply: agentwheel install`.
- After `remember`: replace the stale hint at `src/cli/index.ts:454` (currently suggests `agentwheel sync <source> --adapter ...`) with the install nudge.
- After `eject`: currently prints no follow-up at all (`src/cli/index.ts:458-466`) — add the install nudge. Generalize: **every command that mutates desired state without applying prints the "Run `agentwheel install`" next step.**
- After `init`: say what was actually created, including that the agentwheel bootstrap package was auto-added for openclaw (today it's an invisible side effect), and print the next-step flow.
- `install` plan output: removals must be visually prominent (listed first or clearly grouped) — reconciliation deletes files, including over fleet/SSH targets, and that must never be buried.

## 7. Documentation, site, and skill alignment (atomic with the rename)

The release is **not done** until no stale `agentwheel sync` invocation survives anywhere. Grep for `agentwheel sync` and for the old version string across the repo before declaring done.

1. **`skills/agentwheel/SKILL.md`** — the heaviest item (26 `agentwheel sync` invocations). Rewrite to the new vocabulary and mental model. Also fix the already-stale claims: it describes `init package` as creating `agentwheel.json` with `schemaVersion: 1`, while the code creates `openpack.json` with `schemaVersion: 2`; and the line claiming "update skips pinned packages unless the lock indicates they should be updated" describes the dead code path (after §2 it becomes true — verify wording matches the implemented behavior).
2. **`README.md`** — ~11 `agentwheel sync` invocation examples plus prose. Update the quickstart to `init` → `add` → `plan` → `install`. Keep "sync/reconcile" as prose describing what `install` does internally; it must not appear as a command.
3. **`docs/index.html`** (landing) — update all command examples and the copy (e.g. "Drift-aware, transactional sync" can stay as a *feature description* only if it's clearly prose, not a command; prefer rephrasing around `install`/reconcile).
4. **Bootstrap skill source** — whatever template/source generates the auto-installed skill must teach the new vocabulary.
5. **Changelog** — record the breaking change per the project's release convention (there is currently no CHANGELOG file in the repo; use the same channel previous releases used, e.g. GitHub Releases notes, and state the migration: `sync` → `install`, `sync <src>` → `install <src>`).

## 8. Tests

- `test/update-check.test.ts` is the only test referencing the `sync` CLI string — update it.
- New coverage: ensure-semantics of `install <arg>` (configured-name → scoped reconcile; new source → add+install; garbage → teaching error, exit non-zero), the deprecation shim (forwards + stderr warning + hidden from help), `--no-deps` regression, lock-as-input `install` vs re-resolving `update`, `uninstall --keep-files` leaves ejected files and a later `install` does not remove them.

## 9. Out of scope for 0.9.0

- One-flag sugar like `add --apply` or `install --add` beyond the ensure semantics above.
- Changing the default target selection (bare `install` keeps today's cwd auto-detect; `--all`/`--profile` stay explicit).
- Any registry/trust/OpenPack schema changes.

## 10. Process constraints

- Work on a feature branch following the repo's conventions.
- **Do not commit, push, publish, or open a PR until Joseph explicitly approves.** Implement in the working tree, then report: summary of changes, test results, and the grep proof from §7 that no stale `agentwheel sync` invocation remains.
- If §2's resolver change explodes in scope, stop and report options instead of shipping degraded semantics.
