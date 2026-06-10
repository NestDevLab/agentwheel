# Dependencies & Composition for agentwheel

Status: **agreed plan v2, not yet implemented.**
Authors: Claude (Opus 4.8) + Codex (gpt-5.5), co-designed 2026-06-10.
Process: independent proposals → round-2 convergence → **adversarial xhigh review pass**
(gpt-5.5 at `model_reasoning_effort=xhigh`) whose verdicts (7 CONFIRM / 15 AMEND / 2 REJECT,
all spot-verified against source) are merged here.
Inputs (archived alongside): `dependency-composition.claude-analysis.md`,
`dependency-composition.codex-proposal.md` (incl. round-2 answers),
`dependency-composition.xhigh-review.md`.

## Mission

Two intertwined capabilities, one system:

1. **Dependencies** — a package or artifact can `require` resources (skills, rules, mcp, commands,
   fragments…) from any source agentwheel supports (git, vercel, skillkit, local, registry),
   resolved recursively at install time, npm-style: shared when compatible, satisfiable — not
   fatal — when not.
2. **Composability (DRY / SSOT)** — resources are built from shared fragments referenced — never
   copy-pasted — so skills stay small and instructions exist exactly once at the source.

To our knowledge nobody has shipped dependency + composition resolution for AI agent resources;
this is also a differentiator for agentwheel.

## OpenPack: the standard is vendor-neutral

Everything package-facing in this design is defined as a small, versioned, tool-agnostic spec —
**OpenPack** — with agentwheel as the reference implementation. Rationale: we are effectively
inventing the first dependency/composition standard for AI agent resources; nothing about it is
agentwheel-specific, and adoption by other installers multiplies the value of every published
pack.

In scope for the spec (published as `docs/spec/openpack.md`, versioned independently of the CLI):

- **Manifest** — `openpack.json` / `openpack.jsonc`: `schemaVersion`, `name`, `version`,
  `provides[]` (+ `items`), `requires{}`, `compose`, `runtimes`, `select`, `mode`, `ref`,
  `integrity`, `optional`. Property names are already vendor-neutral (audited — no rename needed).
- **Source layout & artifact vocabulary** — `skills/<name>/SKILL.md`, `rules/*.md`, `fragments/`,
  and the type names (`instructions|rules|skills|commands|subagents|mcp|hooks|settings|plugins|fragments`).
- **Selector grammar** — `type/name`, `alias:type/name`.
- **Composition markers** — `<!-- openpack:include ... -->` / `<!-- openpack:include? ... -->` and
  the generated provenance markers (`BEGIN/END openpack:include ... sha256:...`), plus the
  expansion rules (raw-source-only, idempotent, cycles fatal).
- **Runtime identifiers** — `runtimes` values come from a well-known-names list maintained in the
  spec (`claude`, `codex`, `copilot`, `openclaw`, `gemini`, …), open to extension — not from
  agentwheel adapter internals.
- **Conformance levels**, so simple tools can adopt partially: L1 read manifest + layout; L2
  selective install; L3 composition; L4 dependency-graph resolution.

Out of scope (agentwheel tool state, free to stay branded): `.agentwheel/` workspace config, graph
locks, install manifests, overrides/eject storage, the CLI surface.

**Legacy + migration (file name and schema):**

- Manifest discovery order becomes `openpack.json(c)` → `agentwheel.json(c)` (legacy alias, read
  with a deprecation warning — the installed base of v1 packs keeps working unchanged).
- `agentwheel package migrate` rewrites a pack in place: renames the manifest and upgrades
  schemaVersion 1 → 2.
- The legacy alias stays for a long deprecation window (one extra filename in the discovery list —
  cheap), then leaves the spec; agentwheel itself may keep reading it longer.

npm note: the bare `openpack` npm name is taken; `openpack-spec` / scoped `@openpack/*` are free
if spec tooling is ever published.

## The decisive architectural finding

Today the install pipeline is **single-source per `(targetRoot, adapter)`**:

- `stageSource` (src/staging/staging.ts) produces one bundle from one source;
- `createInstallPlan` (src/install/plan.ts) marks any manifest entry missing from that bundle as
  `remove`;
- `applyInstallPlan` (src/install/apply.ts) **overwrites** `${adapter}.install-manifest.json`;
- `runConfiguredPackages` (src/cli/index.ts) loops packages but each iteration clobbers the
  previous manifest.

**The dependency system is therefore, at its core, a generalization of the pipeline:**

> from "one bundle → one plan → one manifest"
> to "**the resolved dependency closure (N sources) → one combined, target-grouped plan → one
> manifest whose entries carry multi-owner provenance**".

Everything else (manifest fields, CLI flags) hangs off that change. This also fixes the latent
multi-package clobbering today.

### Transactional apply (xhigh blocker — non-negotiable in Phase B)

The current apply is not safe for combined plans: `atomicCopy` removes the destination before
renaming the temp copy (src/utils/fs.ts), operations run one-by-one, the manifest is written only
at the end, and there is **no lock** around read-manifest → plan → apply. Two concurrent syncs can
interleave (runtime files from both graphs, manifest describing only one), and a mid-apply failure
leaves changed files under the old manifest — surfacing as drift instead of a clean repair.

Phase B therefore ships apply as a **target-scoped transaction**:

- an apply lock per `(targetRoot, adapter)` — atomic dir creation locally, remote `mkdir` over SSH
  (`.agentwheel/<adapter>.apply-lock`);
- the plan records a **base manifest revision/hash**; if it changed at apply time, abort + replan;
- a **pending-apply journal** written before file operations, hash verification of copied files,
  then atomic write of graph lock + install manifest;
- a recovery path that can finish or roll back from the journal.

### Migration (one-shot, no legacy state)

Bump the install-manifest version for the multi-owner shape. Migration is a **one-shot
conversion** at the first sync with the new CLI — no `legacyOwner` status, no pending-adoption
state machine, no `prune-legacy` command, no long-lived compatibility code:

- v1 entries whose path/hash/`packageName` match an artifact in the freshly resolved graph are
  converted in place to v2 entries with their real owners;
- unmatched entries are **dropped from the manifest and left untouched on disk** (now unmanaged):
  reported once, prominently, in the migration output — never silently deleted;
- the migration routine itself stays small and is removable after a deprecation window.

This trades a little disk tidiness (orphaned files remain until the user removes them by hand)
for zero legacy machinery and zero risk of surprise deletions on first sync.

## Core decisions

1. **A graph resolver between staging and planning — with a raw/render split.** New lifecycle
   layer (`src/resolve/graph.ts`): reads manifests, recursively resolves `requires`, and
   fetches/lists each locked source **once** (raw stage). But everything target-specific —
   selection propagation, namespacing, fragment overrides, Markdown expansion, instruction
   overlays, adapter merge planning, final hashing — happens in a per-target render step
   (`renderGraphForTarget`), keyed by `(workspaceRoot, targetRoot, transport, adapter,
   adapterConfig/profile runtime)`. Rationale: `stageSource` already applies per-target
   customizations (overrides, ejections, overlays via `applyCustomizations`); sharing
   post-customization output across profile runtimes would leak one runtime's rendered content
   into another. Drivers keep resolve/fetch/list/export; adapters keep paths and merge semantics.
2. **Two identities per artifact.** *Logical* identity is **`graphNodeId:type/name`**, where
   `graphNodeId` includes manifest name, version, normalized source identity, resolved
   commit/content hash, and source digest — `package@version:type/name` is display shorthand only
   when unambiguous (two nodes can share name@version from different sources). *Install* identity
   (final runtime path/name) is chosen by a deterministic namespace policy. Flat runtime dirs
   (`~/.claude/skills/<name>`) cannot emulate nested `node_modules` — we don't pretend they can.
3. **Namespace policy (the flat-namespace answer).**
   - Root-package artifacts always keep their plain names.
   - Direct-dependency artifacts keep plain names when no collision exists.
   - **Direct vs direct collision is blocking, never auto-renamed.** An already-installed,
     drift-clean incumbent (per manifest entry) keeps the plain name; newcomers block with a
     resolution hint (alias / deselect / override). On a **fresh** install the collision is a
     **pre-plan resolution error** — no create op is emitted for either colliding path (the
     planner refuses blocking plans wholesale, so a "blocked newcomer + applied incumbent" mix is
     not expressible). A proposed incumbent is shown for diagnostics using **explicit root
     priority**, never config array order: `upsertPackage` sorts packages alphabetically, so array
     order is not insertion order. `WorkspacePackage` gains an immutable `rootId` and a
     `priority`/`addedAtOrdinal`; accepted incumbents are persisted in the graph lock as
     `plainNameIncumbents: (adapter,target,type,name) → graphNodeId`.
   - **Transitive** conflicting artifacts are auto-namespaced deterministically:
     `<packageSlug>--<artifactName>`, escalating to `@<version>` / `+<shortSourceHash>` suffixes
     only as needed. Users may assign pretty `aliases` in workspace config.
4. **Resolution by source identity first, semver later.** Manifest `version` is a free string
   today and packs rarely version meaningfully. Phase B resolves/dedupes by **normalized source
   identity + manifest name** — where normalization distinguishes registry source, explicit
   git/local/skillkit/vercel source, requested ref, resolved commit/content hash, and trust
   provenance. `version` is recorded and displayed but not solved. Semver ranges arrive with the
   conflict-satisfaction phase.
5. **Composition = sync-time transclusion into self-contained artifacts.** Agents just read
   Markdown; no runtime include protocol. **Scope: only `fragments` / `compose` includes are ever
   inlined. Artifacts pulled via `requires` (skills, rules, commands, mcp…) install as separate
   artifacts in their own runtime locations — a required skill is never injected into the body of
   the requiring skill.** Fragments live once at the source; rendered output
   embeds them between provenance markers
   (`<!-- BEGIN openpack:include <pkg>@<ver>:fragments/x.md sha256:... -->`) and is hashed,
   drift-protected, and re-expanded on update. SSOT lives at the source; the installed copy is a
   build artifact. A `reference`/`hybrid` mode per adapter is a later optimization.
   **Expansion rules (idempotency):** expansion always starts from **raw source package content**,
   never from installed output or prior generated output; committed generated include blocks are
   rejected unless escaped; markers stay on by default with a source map in the manifest; markers
   stripped by external tooling = normal drift. Expansion is deterministic and idempotent for the
   same raw source + lock.
   **Override ordering:** fragment overrides/ejections apply **before** expansion and only when
   addressed to an exact graph node; artifact-level overrides apply **after** expansion.
6. **Fragments are first-class but not installed.** New artifact type `fragments` (`fragments/`
   dir): listable, selectable, lockable, override/ejectable by graph node — but never copied into
   runtime dirs unless an adapter explicitly declares a fragments target. Note: adding a type
   touches the artifact enum, selection, customization (its replace list is hardcoded), locks, and
   old-CLI compatibility — hence the schema gate below.
7. **Schema gate: no v1 masquerade (xhigh REJECT of "v1 + optional fields").** Current parsers
   strip unknown keys silently (zod default) and **reject** `{ "type": "fragments" }` outright —
   so a v1-looking manifest with `requires`/`compose` would be half-installed by older CLIs with
   no error. Install-affecting dependency/composition manifests must use **`schemaVersion: 2`**
   (or a required feature/min-version field that makes old CLIs fail loudly). Phase 0 validation
   in the new CLI can be permissive; published packages must not lie about their contract.
8. **Ownership is recomputed, refcounts are a view.** Uninstall = remove the root from the
   requested set, re-resolve the remaining roots (from lock/cache), diff ownership: entries whose
   owner set becomes empty are removed; still-owned entries become `keep (still required by …)`.
   Never walk-and-decrement mutable counters. `refCount` in the manifest is derived
   denormalization.
9. **Merge targets are special (mcp/hooks/settings/plugins).** JSON/TOML merge destinations
   (`.claude/settings.json`, `.codex/config.toml`) are one path with many semantic contributors —
   a single multi-owner entry per path cannot say which MCP server came from which owner. Manifest
   ownership for merge targets is tracked at **semantic subentry granularity**
   (`mcpServers.<name> → owners/sourceHash/graphNodeId`), with subentry collision detection.
   Until that exists, transitive deps may **not** install `mcp`, `hooks`, `settings`, or semantic
   plugins — root-selected only, behind a review prompt.
10. **Selection propagates, sprawl is opt-in.** A dependency installs only its declared `select`
    plus its `required: true` artifacts; artifact-level requires pull only what selected parents
    need; fragments install never (see 6). Selector sets, owner sets, and edge lists are
    **canonicalized (sorted) before fixed-point comparison and lock serialization**, so cycles and
    locks don't depend on insertion order.
11. **Trust like a supply chain — minimum enforced in Phase B.** Instructions are code-shaped
    authority. Phase B ships: first-install trust prompt for new transitive sources, `integrity`
    verification when declared, and a **minimal `--frozen-lock`** (no registry refresh, no git
    fetch; locked URLs/commits/hashes + verified cache snapshots only; precise missing-node
    errors). Rich policy files (`allow`/`denyArtifactTypes`/`requireReviewForTransitive`) and
    broad offline ergonomics follow later. Transitive plugins never execute by default.
12. **Dependency-source grammar is hardened (anti dependency-confusion).** Today a bare name
    resolves to a **local path if one exists at the cwd**, else the registry — and registries
    merge duplicate names first-wins. Inside package manifests: bare names mean **registry only**
    (`registry:<name>` accepted for clarity); local deps must be explicit (`./`, `../`, `local:`)
    and resolve **relative to the declaring package root**, never the cwd. The lock pins the
    resolved registry source, index source, manifest name, and source hash; if a registry name
    later resolves elsewhere, require explicit update/trust.
13. **Include aliases are lexical and locked.** Alias tables are per declaring graph node; include
    edges lock as `{fromNodeId, alias, toNodeId, selector, sourceHash}`. No fallback from alias to
    package name; alias syntax is reserved so local artifact names cannot shadow aliases. If an
    alias retargets after an update, the lock diff shows it.
14. **Runtime targeting (per-agent compatibility).** Authors can scope any provide entry, item, or
    dependency edge to specific runtimes with an optional `runtimes` field (identifiers from the
    OpenPack well-known list — `claude`, `codex`, `copilot`, `openclaw`, `gemini`, … — not
    agentwheel adapter internals; default: all). Most plugins and many skills are not portable across agents. During per-target
    rendering, artifacts whose `runtimes` excludes the current adapter are skipped — reported in
    dry-run as `skip (not targeted: runtimes=[codex])`, never an error — and their artifact-level
    requires and composition edges are skipped with them. Selecting an artifact excluded for the
    current runtime is a notice, not a failure, so one `select` list works across a mixed fleet.
    Adapter capability (`targets.<type>.enabled`) stays the runtime-side filter; `runtimes` is the
    author-side compatibility declaration — both must pass for an artifact to install.

## Manifest surface (OpenPack, target shape)

```jsonc
// openpack.json  (legacy alias: agentwheel.json — still discovered, deprecated)
{
  "schemaVersion": 2,                       // REQUIRED for requires/items/compose/fragments
  "name": "nestdevlab/core-agent-pack",
  "version": "1.3.0",
  "requires": {                             // object: keys are stable aliases
    "core": {
      "source": "github:NestDevLab/core-rules",   // explicit driver | registry:<name> | ./local (package-root-relative)
      "ref": "main",                        // pin/track at source level (Phase B solving key)
      "version": "^1.2.0",                  // recorded now; solved in the semver phase
      "select": ["rules/safe-actions.md", "fragments/risk-rubric.md"],
      "mode": "pinned",                     // pinned | tracking
      "optional": false,
      "integrity": "sha256-..."             // optional reproducibility/security pin
    }
  },
  "provides": [
    { "type": "fragments", "path": "fragments" },
    {
      "type": "skills", "path": "skills",
      "items": {                            // per-artifact metadata (artifact-level deps + composition)
        "triage-pr": {
          "runtimes": ["claude", "codex"],  // author-declared compatibility (default: all runtimes)
          "requires": ["rules/safe-actions.md", "core:rules/safe-actions.md"],
          "compose": [
            { "include": "fragments/review-style.md" },
            { "include": "core:fragments/risk-rubric.md" }
          ]
        }
      }
    }
  ]
}
```

Inline equivalent inside Markdown (resolved at render time, package-root-escape forbidden,
cross-package only via declared aliases):

```md
<!-- openpack:include fragments/review-style.md -->
<!-- openpack:include? fragments/local-note.md -->   <!-- optional include -->
<!-- openpack:include core:fragments/risk-rubric.md -->
```

Selector grammar: local `type/name`; dependency `alias:type/name`;
fully-qualified `graphNodeId:type/name` in locks/diagnostics.

## State files

- **Graph lock** — local workspace, keyed by target fingerprint:
  `.agentwheel/locks/<profile-or-agent>/<adapter>/<targetDigest>.graph-lock.json`, where the
  fingerprint covers adapter config hash, targetRoot, transport, runtime name (one adapter name
  can serve several SSH agents and a local runtime — one file per adapter is ambiguous).
  Content: **canonical JSON** — sorted roots, nodes (`graphNodeId`, driver, source, ref,
  resolvedCommit, sourceHash, requiredBy, selected), edges (alias, range, select), include edges,
  namespacing decisions, `plainNameIncumbents`. Volatile metadata (`generatedAt`, diagnostics)
  lives outside the frozen comparison.
- **Install manifest** (version bump; remains on the target, also over SSH) — entries gain
  `installName`, `logicalSelector`, `graphNodeId`, `dependencyRole: root|direct|transitive|fragment`,
  sorted `owners[]`, derived `refCount`, `composedFrom[]` (fragment provenance with hashes), and
  `graphLockDigest` linking back to the lock it was applied from. Merge-target entries carry
  per-subentry ownership (see decision 9).

## Update & drift (two-result diagnostics)

Update re-resolves tracking roots **and** tracking dependencies, renders desired composed outputs
first, then drift-checks. Today the planner reports drift before comparing desired content, which
would hide a pending fragment update behind "changed outside agentwheel". Drift operations
therefore carry `blockedDesiredHash`, `blockedReason`, and `composedFromDiff`, so dry-run can say:

```text
DRIFT  skills/triage  (local edits block update: included fragment core:fragments/risk.md A→B)
```

Drifted composed artifacts are never silently updated.

## Cycles

- Package cycles: re-entering an active ancestor is OK if it adds no new unsatisfied selection;
  otherwise fixed-point over **canonicalized graph state** (not order-sensitive arrays) with a
  small cap, then fail with the chain printed.
- Composition cycles: always fatal, printed as an include chain.

## Performance (in Phase B, not later)

Naive resolution would `git fetch` every transitive repo on every sync (the git driver fetches on
each staging pass today). Phase B includes: fetch de-duplication by normalized source/ref,
per-cache locks (concurrent resolutions of different refs currently mutate one checkout per URL),
bounded-concurrency parallel fetch, `--prefer-lock` default for pinned nodes, and dry-run
cache-miss reporting. Per-commit/sourceHash cache snapshots replace mutable per-URL checkouts.

## CLI / UX

```bash
# authoring
agentwheel deps add github:NestDevLab/core-rules --as core
agentwheel deps tree
agentwheel deps why rules/nestdevlab-core-rules--safe-actions.md
agentwheel package validate            # spec conformance: schema + selectors + includes, no install
agentwheel package migrate             # rename agentwheel.json -> openpack.json + upgrade schema v1 -> v2

# installing (no new ceremony)
agentwheel sync --dry-run              # prints dependency tree + hoist/namespacing + plan
agentwheel sync
agentwheel sync --no-deps | --frozen-lock | --offline | --prefer-lock | --trust 'github:NestDevLab/*'
agentwheel trust forget 'github:NestDevLab/*'
```

`--dry-run` shows, before file operations: the resolved tree (RESOLVE/HOIST/NEST lines), the
selection per node, every namespacing decision, runtime-targeting skips, ownership reasons on
keeps/removes, the one-shot migration report (first run only), and blocked updates behind drift.
Output is target-group aware.

Trust policy lives in merged workspace config under `trust`: `allow` source globs,
`denyArtifactTypes`, and `requireReviewForTransitive`. Persisted first-use accepted sources are
stored in a user-level trust store, not in project config, so a repository cannot pre-trust its
own transitive dependencies. `--trust` and `--yes` are additive CLI approvals; prompted/`--yes`
decisions are remembered as exact sources until revoked with `agentwheel trust forget <pattern>`.
`--offline` uses the graph lock plus local caches only and errors with the locked node/source
that cannot be materialized. When a previous graph lock exists, sync/update output includes a
concise graph diff for added, removed, moved, include-edge, and namespacing changes. Persisted
graph lock files omit volatile timestamps; timestamp-like diagnostics belong outside the lock
bytes.

Overrides/eject: the **canonical** form addresses an exact graph node id / source digest;
`pkg/...` and `pkg@version/...` are accepted shorthand only when they resolve to exactly one
installed node — ambiguity is fatal and prints the exact disambiguated commands.

## Phased rollout

- **Phase 0 — Spec + schema + diagnostics.** Publish the OpenPack spec doc (`docs/spec/openpack.md`);
  `schemaVersion: 2` parsing for `requires`/`items`/`compose`/`fragments`; manifest discovery
  `openpack.json(c)` with `agentwheel.json(c)` as deprecated alias; `package validate` /
  extended `scan`; `package migrate` (rename + schema upgrade); zero install-behavior change.
  Authors can start writing manifests that old CLIs *reject* rather than half-install.
- **Phase A — Intra-package composition.** Fragments + include markers within one package;
  render-time expansion (raw-source-only, idempotent) with provenance markers; `composedFrom` in
  manifest and dry-run; fragment override plumbing; include cycles fatal; drift diagnostics for
  composed output. **No graph resolver needed** — generalizes
  `composeAssets`/`applyInstructionOverlay` — but requires the schema gate and the per-target
  render path. Immediate DRY/SSOT value; validates markers, hashing, drift on composed output.
- **Phase B — Package-level dependencies (the crux, deliberately the largest phase).**
  Recursive `requires`; source-identity resolution + dedup (no semver); **target-grouped combined
  plans**; **transactional apply** (lock, base revision, journal, recovery); **one-shot v1→v2
  manifest migration**; multi-owner manifest; canonical graph lock keyed by target
  fingerprint; ownership-recomputing uninstall; fetch dedup/concurrency/`--prefer-lock`;
  **minimal trust prompt + integrity + `--frozen-lock`**; merge-target deps blocked (or
  root-selected with prompt); incompatible duplicates = good diagnostic (no auto-namespacing yet).
- **Phase C — Cross-package composition + artifact-level requires.** `alias:` includes through
  the graph with locked include edges; `items.requires`; selection propagation.
- **Phase D — Conflict satisfaction.** Semver ranges where parseable (exact otherwise);
  transitive auto-namespacing policy; `aliases` in workspace config; `deps tree|why`; node-id
  override/eject with shorthand.
- **Phase E — Trust & ergonomics polish.** Workspace trust policy (`allow`,
  `denyArtifactTypes`, `requireReviewForTransitive`), user-level persisted accepted sources with
  `trust forget`, broad `--offline` UX over graph locks and caches, graph diff polish on
  sync/update, registry `openpack` compatibility metadata warnings, and byte-stable graph lock
  files. (The minimal
  lock/frozen/integrity guarantees are **in Phase B** — deferring them was rejected at review.)
- **Phase F — Later.** `reference`/`hybrid` compose modes for capable runtimes, content-dedupe,
  per-subentry merge ownership v2, capability-based requires (`{"capability": "..."}`).

## Agentic team & delivery workflow

The same multi-agent setup that produced this plan delivers the implementation. Roles:

| Role | Who | Responsibilities |
|---|---|---|
| Product owner | **Joseph** | Scope and naming decisions, approves pushes/PRs/merges/releases. Decisions requested as small option sets, never mid-task blocking. |
| Orchestrator / design authority | **Claude** (interactive session) | Owns this plan; decomposes phases into briefs; verifies every agent claim against `src/`; merges design amendments; reviews PRs. **Never commits** — prepares staged files/briefs only. |
| Architect-reviewer | **Codex @ xhigh** (dedicated tmux session) | Adversarial design passes (CONFIRM/AMEND/REJECT) before each phase starts and at the Phase B gate. |
| Implementer(s) | **Codex @ xhigh** (one tmux session per workstream) | Writes the code in an observable/resumable mesh session; owns branch, commits, and PR for its workstream. |
| Recon & review subagents | **Claude subagents** (Explore / code-review / verify) | Codebase recon for briefs; post-implementation review (`/code-review`, high effort; `ultra` available for the Phase B gate at Joseph's trigger); test-run verification. |

Working protocol (lessons already learned, kept as rules):

- Briefs are **files**, prompts are one-liners pointing at them. After every send to a tmux agent,
  **verify submission** (status flips to `working`; nudge `C-m` if the composer still holds the
  paste). Codex sessions run on the mesh tmux socket and are resumable.
- One workstream = one git worktree + branch `feat/openpack-<phase>-<topic>`. Codex commits with
  no attribution footers; PRs reviewed by Claude, merged only on Joseph's approval.
- Cross-vendor review is deliberate: Codex implements → Claude (+subagents) reviews, and design
  reviews run in the opposite direction.

Staffing per phase:

- **Phase 0 + A** — 1 Codex implementer (spec doc, schema v2, discovery/migrate, intra-package
  composition) + Claude review. Gate: vitest green; composition idempotency + drift tests;
  **dogfood**: agentwheel's own manifest migrates to `openpack.json` as the first OpenPack package.
- **Phase B** — split into 3 workstreams with low file overlap, run as separate Codex sessions:
  **B1** graph resolver + lock (`src/resolve/*`, `src/model/graph-lock.ts`), **B2** transactional
  apply + one-shot migration (`src/install/*`), in parallel; **B3** CLI/diagnostics + minimal
  trust/frozen-lock, after B1+B2 land. Gate: xhigh adversarial review pass + `/code-review` (or
  `ultra`) + full suite + dogfood with a real dependency closure.
- **Phases C–E** — 1 implementer each + standard review gate.

## Alternatives considered and rejected (kept for the record)

Bundle-everything-into-parents (kills reusable runtime artifacts → adopted *only* for fragments);
vendor dirs inside skills (agents ignore nested content); runtime loader/`agentwheel://` (agents
don't execute loaders before reading); mandatory central registry (violates no-lock-in);
OCI/Nix content-addressed store with symlinks (brittle across agents/OS/SSH — but per-commit cache
snapshots are adopted internally); first-wins (install-order-observable) and always-fatal (defeats
the mission) for conflicts; sidecar-only composition maps without inline markers (cleaner files,
worse runtime inspectability — markers stay default); partial apply of non-conflicting subsets
during fresh direct/direct collisions (confusing first-install state — blocked instead).

## Open questions

- Multi-package `instructions` composition order for single-file targets (sectioned, provenance-
  marked model needed).
- Plugin (semantic install) deps vs refcount uninstall — needs per-plugin uninstall semantics
  before auto-removal.
- Package rename migration (lock tracks source + previous name, explicit migration).
- Exact shape of the target fingerprint digest (stability across adapter-config formatting).
- Whether a shared, spec-level lock format is worth standardizing for cross-tool interop (out of
  OpenPack v1 — locks stay tool state for now).

## Likely module boundaries

`src/model/package.ts` (openpack.json discovery + legacy alias + v2 schema) ·
`src/resolve/graph.ts` (closure, raw staging, hoist/incumbent decisions) ·
`src/resolve/render.ts` (per-target rendering) · `src/resolve/names.ts` (install-name policy) ·
`src/compose/markdown.ts` (include expansion + provenance) · `src/model/graph-lock.ts` ·
`src/install/transaction.ts` (apply lock, journal, recovery) · `src/lifecycle/source-plan.ts`
(single `stageSource` → `createGraphPlan` + `renderGraphForTarget`) · `src/install/manifest.ts`
(entry metadata + version bump + one-shot migration) · `src/install/uninstall.ts` (ownership-aware) ·
`src/cli/format.ts` (tree, `why`, adoption/blocked-update diagnostics).

Drivers and adapters remain intact; staging splits into raw vs per-target render. The feature is
the missing orchestration layer plus a transactional installer — not a rewrite.

## Review log

- 2026-06-10 — xhigh adversarial pass (gpt-5.5, `model_reasoning_effort=xhigh`): 7 CONFIRM /
  15 AMEND / 2 REJECT. Key outcomes merged: transactional apply (blocker), rootId/priority +
  lock-persisted incumbents, schemaVersion 2 gate, raw-vs-render staging split, legacy adoption
  migration, graph-node logical identity, dependency-confusion hardening, locked include edges,
  per-subentry merge ownership, two-result drift/update diagnostics, lock canonicalization +
  target-fingerprint keying, Phase B enlarged (perf + minimal trust/frozen-lock pulled in).
  Heaviest claims spot-verified against `src/` before merging.
- 2026-06-10 — owner-directed amendments (Joseph): per-runtime targeting added (`runtimes` field,
  author-side compatibility, decision 14); **one-shot v1→v2 migration replaces the legacy-adoption
  state machine** (no `legacyOwner`, no `prune-legacy` — unmatched entries dropped from management,
  left on disk, reported once; deliberate divergence from xhigh finding 5's mechanism while keeping
  its safety goal of never silently deleting); composition scope clarified — only
  fragments/includes inline, required skills always install as separate artifacts.
- 2026-06-10 — owner decision (Joseph): the package-facing standard goes **vendor-neutral as
  "OpenPack"** — manifest `openpack.json(c)`, markers `openpack:include`, spec doc with
  conformance levels; `agentwheel.json(c)` becomes a deprecated discovery alias with
  `package migrate` for in-place upgrades. Properties audited: already neutral, no renames.
