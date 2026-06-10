## Verdict

BLOCK. Phase 0 and much of Phase A are present, and the main non-profile `sync` path has a graph resolver, v2 manifest entries, target locks, and basic trust/frozen checks. The Phase B implementation is not shippable: combined planning can silently drop colliding artifacts, `sync --profile` bypasses the graph system entirely, v1 migration can adopt and overwrite legacy files that the contract says must be dropped from management, and the graph lock is not committed transactionally with the install manifest. These are correctness and data-loss risks, not polish gaps.

## Conformance table

| Plan requirement | Status | Evidence |
| --- | --- | --- |
| Phase 0: OpenPack spec doc and schema v2 | Implemented | `docs/spec/openpack.md`; v2 schema parses `requires`, `items`, `compose`, `fragments`, `runtimes` in `src/model/package.ts:76-84`. |
| Phase 0: discovery order `openpack.json(c)` then legacy alias | Implemented | `packageManifestNames` orders OpenPack before legacy in `src/model/package.ts:92-106`. |
| Phase 0: v1 masquerade gate | Implemented | v1 manifests with `requires`/`compose`/`fragments` are rejected in `src/model/package.ts:128-163`. |
| Phase 0: `package validate` / migrate | Implemented | CLI commands are wired at `src/cli/index.ts:323-349`; migrate rewrites legacy names in `src/model/package-migrate.ts:14-35`. |
| Phase A: raw-source Markdown expansion with generated-block rejection | Implemented | Expansion starts from staged raw files and rejects generated markers in `src/compose/markdown.ts:50-89`. |
| Phase A: fragment includes, optional form, escape form, cycles fatal | Implemented | Include parsing/cycle/escape handling is in `src/compose/markdown.ts:8-10`, `80-152`, `154-175`. |
| Phase A: fragment overrides before expansion | Partial | Fragment overrides run before expansion in `src/staging/staging.ts:73-82`, but override addressing is package-name based, not exact graph-node based (`src/staging/customize.ts:97-123`). |
| Phase A: `composedFrom` and update diagnostics | Partial | `composedFrom` is recorded (`src/compose/markdown.ts:22-35`), but drifted composed updates do not carry the required blocked desired/composed diff (`src/install/plan.ts:184-191`). |
| Decision 1: graph resolver plus raw/render split | Partial | Resolver/render modules exist (`src/resolve/graph.ts`, `src/resolve/render.ts`), but `sync --profile` still uses the old one-package staging path (`src/lifecycle/profile.ts:51-77`). |
| Decision 2: logical identity and install identity | Partial | `graphNodeId` includes source identity/hash (`src/resolve/graph.ts:223`, `467-475`), but install identity is always the plain artifact name (`src/resolve/render.ts:34-40`) with no complete collision policy. |
| Decision 3: flat namespace collision policy | Missing/unsafe | Only direct dependency collisions at `depth === 1` are detected (`src/resolve/graph.ts:444-464`); root/root, root/direct, and transitive collisions can be overwritten in the desired-operation map (`src/install/plan.ts:109-114`). |
| Decision 4: source identity first, semver later | Mostly implemented | Dependency sources normalize by driver/source/ref in `src/resolve/identity.ts:22-82`; duplicate manifest names from different normalized sources are rejected in `src/resolve/graph.ts:208-216`. |
| Decision 5: composition only inlines fragments | Implemented for local fragments | Non-fragment includes and cross-package includes are rejected in Phase A/B (`src/compose/markdown.ts:154-171`). |
| Decision 6: fragments first-class but not installed | Mostly implemented | `fragments` is an artifact type (`src/model/artifact.ts:3-14`); dependency fragments are filtered out of rendered artifacts (`src/resolve/render.ts:33`). |
| Decision 7: schema gate | Implemented | See `src/model/package.ts:128-163`. |
| Decision 8: ownership recomputed, refcounts derived | Partial | Ownership uninstall recomputes remaining desired artifacts (`src/install/uninstall.ts:72-164`), but package removal is not persisted to config and graph locks are not updated. |
| Decision 9: merge targets blocked until subentry ownership | Partial/unsafe | Only `dependencyRole === "transitive"` merge targets are blocked (`src/install/plan.ts:103-106`); direct dependencies can install `mcp`/`hooks`/`settings`. |
| Decision 10: selection propagation and canonical ordering | Partial | Package dependency `select` plus required artifacts are propagated (`src/resolve/graph.ts:404-420`), but artifact-level `items.requires` is parsed/validated and not resolved, and dependency-edge runtimes are ignored. |
| Decision 11: trust, integrity, minimal frozen lock | Partial | Trust/integrity/frozen checks exist (`src/lifecycle/source-plan.ts:120-250`, `src/resolve/graph.ts:380-386`), but source cache locking is process-local and graph lock commit is outside apply. |
| Decision 12: hardened dependency-source grammar | Implemented for package manifests | Bare package dependency names are registry-only and local paths are explicit/declaring-root-relative (`src/resolve/identity.ts:35-47`, `102-130`). |
| Decision 13: include aliases locked | Missing/deferred | Cross-package includes are rejected (`src/compose/markdown.ts:158-160`) and graph locks always emit empty `includeEdges` (`src/resolve/graph.ts:181-184`). |
| Decision 14: runtime targeting | Partial/unsafe | Artifact runtime filtering exists (`src/staging/staging.ts:127-134`), but `requires.<alias>.runtimes` is parsed (`src/model/package.ts:56`) and never used in graph resolution (`src/resolve/graph.ts:291-307`). |
| Transactional apply: target lock + base revision | Partial | Lock and base revision checks exist (`src/install/apply.ts:119-122`, `387-393`), but graph lock writes are outside the transaction and recovery has unjournaled mutation windows. |
| Transactional apply: pending journal and recovery | Partial/unsafe | Journal exists (`src/install/apply.ts:124-146`), but completion is recorded after mutation (`src/install/apply.ts:149-162`) and SSH rollback has no backups (`src/install/transaction.ts:109-142`). |
| Migration one-shot | Partial/unsafe | v1 entries are migrated/dropped (`src/install/plan.ts:292-325`), but adoption uses path-only and owner-only matches rather than path/hash/package identity. |
| State files keyed by target fingerprint | Partial | Graph lock path includes target key/adapter/fingerprint (`src/lifecycle/source-plan.ts:187-189`), but `plainNameIncumbents` is never populated (`src/resolve/graph.ts:181-184`) and uninstall does not refresh/remove graph locks. |
| Update & drift two-result diagnostics | Missing | Drift operations are generic and do not include blocked desired hash/reason/composed diff (`src/install/plan.ts:184-191`). |
| Performance: fetch dedup, per-cache locks, snapshots | Partial | Per-plan fetch dedup and bounded concurrency exist (`src/resolve/graph.ts:115`, `143-146`, `481-492`), but cache locks are only an in-memory `Map` (`src/resolve/graph.ts:106`, `388-402`) and git uses a mutable checkout (`src/source/git.ts:44-56`). |
| Phase B combined target-grouped plans | Partial/unsafe | Non-profile CLI groups packages per target (`src/cli/index.ts:499-576`), but collisions and profile mode break the combined-plan contract. |

## Findings

1. **blocker - Combined planning silently overwrites colliding install paths outside the one checked direct/direct case.**  
   Evidence: rendered artifacts always keep `installName: artifact.name` and plain runtime paths (`src/resolve/render.ts:34-40`); the combined planner writes operations into a `Map` by `relativeDestPath`, so later entries replace earlier ones (`src/install/plan.ts:109-114`); collision detection only inspects dependency nodes with `depth === 1` (`src/resolve/graph.ts:444-464`).  
   Scenario: two configured roots both provide `rules/policy.md`, or a root provides `rules/policy.md` and a direct dependency selects the same artifact. Both map to `.claude/rules/policy.md`; one operation is overwritten before drift/conflict planning, so the apply creates exactly one file and one manifest entry with no blocking diagnostic. The same applies to transitive artifact collisions because no transitive namespacing or blocking pass runs before `desired.set`.  
   Fix: build a complete destination-path collision index before creating the desired-operation map. Block every root/root, root/direct, direct/direct, and transitive collision that Phase B cannot namespace; emit no create/update op for the colliding set. Persist accepted incumbents only after an explicit, drift-clean incumbent decision.

2. **blocker - `sync --profile` bypasses OpenPack graph resolution, dependency installation, graph locks, and combined planning.**  
   Evidence: the CLI profile branch calls `syncProfile` and returns before the graph path (`src/cli/index.ts:214-234`); `syncProfile` loops `package -> runtime`, calls `stageSource`, `createInstallPlan`, and `applyInstallPlan` one package at a time (`src/lifecycle/profile.ts:51-77`).  
   Scenario: a fleet profile with two configured packages and a shared `requires` dependency is synced. Profile mode ignores `requires`, writes no graph lock, does no transitive trust/frozen checks, and applies each package separately to the same `${adapter}.install-manifest.json`, recreating the pre-Phase-B clobbering behavior the plan was meant to remove.  
   Fix: route profile sync through the same target-grouped graph planner as normal `sync`, grouping all roots per `(runtime,target,transport,adapter config)` and applying one combined plan per target.

3. **blocker - v1 to v2 migration can adopt and overwrite legacy entries that should be dropped from management.**  
   Evidence: migration first adopts any legacy entry whose path appears in the new desired map (`src/install/plan.ts:304-315`), then has a broad package-owner fallback that can match only `owners.includes(entry.packageName)` (`src/install/plan.ts:306-309`); it never requires the legacy entry's hash/sourceHash/packageName to match the desired artifact before adoption (`src/install/plan.ts:328-340`).  
   Scenario: a v1 manifest has `.claude/rules/policy.md` from package `old/pkg`, but `old/pkg` is no longer configured. A newly configured package wants the same destination path. The contract says the old entry is unmatched, dropped from the manifest, and left untouched on disk, which would make the new desired file a normal unmanaged-destination conflict. Instead, path-only adoption treats the old file as managed by the new graph and plans an update, overwriting a file that should have become unmanaged.  
   Fix: adopt only when path, current hash/source hash, artifact identity, and package/source identity match the freshly resolved graph. Otherwise drop the entry from the effective manifest and let any new desired artifact at that path surface as a conflict.

4. **major - dependency-edge `runtimes` is parsed but ignored, so runtime-scoped dependencies can install into excluded agents.**  
   Evidence: dependency declarations include `runtimes` (`src/model/package.ts:48-57`), but graph expansion maps dependencies without checking or carrying that field (`src/resolve/graph.ts:291-307`). The only runtime filter is artifact-level filtering after fetch/render (`src/staging/staging.ts:127-134`).  
   Scenario: a root declares `requires.core.runtimes: ["claude"]` for a dependency whose artifacts have no own runtime restriction. A Codex sync still resolves, prompts trust for, renders, and installs that dependency into `.codex/...`. This violates the plan rule that excluded dependency edges and their artifacts/requires/composition edges are skipped for the current runtime.  
   Fix: pass the current runtime/adapter into graph resolution or a pre-render edge filter, and skip dependency edges whose `runtimes` excludes the target before fetching, trust prompting, or selecting artifacts.

5. **major - direct dependency merge targets are allowed even though per-subentry ownership does not exist.**  
   Evidence: the merge-target guard rejects only `artifact.meta.dependencyRole === "transitive"` (`src/install/plan.ts:103-106`); direct dependencies are explicitly marked as `direct` at depth 1 (`src/resolve/render.ts:53-57`). Codex/Claude merge targets write shared files such as `.codex/config.toml` and `.claude/settings.json` (`src/adapters/codex.ts:12-14`, `src/adapters/claude.ts:12-14`).  
   Scenario: a root package requires a direct dependency selecting `mcp/server.json`. The planner permits it because the role is `direct`, then merges it into a single settings/TOML destination with only path-level owners. Uninstall cannot know which MCP server section belongs to which owner if another root or user content shares the same file.  
   Fix: block all non-root dependency-provided `mcp`, `hooks`, `settings`, and semantic plugin artifacts until per-subentry ownership exists, unless the artifact is explicitly root-selected behind the required review prompt.

6. **major - graph lock writes are outside the apply transaction and are not maintained by uninstall.**  
   Evidence: apply writes the install manifest and removes the journal inside `applyCombinedInstallPlan` (`src/install/apply.ts:165-171`), but the CLI writes the graph lock only afterward (`src/cli/index.ts:258-260`, `489-492`); `writeGraphSourceLock` is a separate local write (`src/lifecycle/source-plan.ts:149-152`). During package uninstall, a remaining graph is computed (`src/cli/index.ts:613-633`) but no graph lock is written, and the config root set is not changed (`src/cli/index.ts:579-645`).  
   Scenario: sync applies files and writes a v2 manifest whose entries contain `graphLockDigest`, then the process crashes before `writeGraphSourceLock`. The target now claims a graph-lock digest that is missing or stale, so a later `--frozen-lock` can fail or compare against the previous graph. After `agentwheel uninstall root-a`, preserved entries can still point at the old graph lock containing `root-a`.  
   Fix: make the graph lock part of the same journaled transaction as the manifest, or use a two-phase state commit with recovery. Package uninstall must persist the new requested root set or write/remove the target graph lock that corresponds to the remaining ownership graph.

7. **major - pending-apply recovery cannot reliably roll back or finish after real mid-apply kills, especially over SSH.**  
   Evidence: the journal is written before operations (`src/install/apply.ts:124-146`), but each operation is marked completed only after `applyOperation` returns (`src/install/apply.ts:149-162`). Recovery rolls back only `journal.completed` when remaining source files are missing (`src/install/apply.ts:69-74`, `395-402`). Backups are recorded only for local transports (`src/install/transaction.ts:101-129`), and remote rollback throws when an existing file had no backup (`src/install/transaction.ts:131-142`).  
   Scenario: an update copies the new file, then the process is killed before `journal.completed` is written. If the temp source directory is gone by recovery time, `missingRemainingSources` triggers rollback of an empty completed set and removes the journal, leaving the updated file under the old manifest. Over SSH, even completed updates with prior files cannot roll back because no remote backup path was recorded.  
   Fix: persist a started operation with backup metadata before mutating, make recovery compare destination hashes to determine whether an uncompleted operation actually landed, and record restorable backups for SSH targets or constrain SSH recovery to finish-only with explicit failure.

8. **major - drifted composed artifacts hide pending tracking/fragment updates instead of reporting the required two-result diagnostic.**  
   Evidence: when a managed destination is drifted, the planner emits only `reason: "managed destination changed outside agentwheel"` and does not attach desired hash or composed diff (`src/install/plan.ts:184-191`). The composed-fragment diff is added only for clean update operations (`src/install/plan.ts:198-204`, `438-449`).  
   Scenario: a skill includes `fragments/risk.md`; the user edits the installed skill; then a tracking dependency changes that fragment. The plan reports only local drift, so the user cannot see that an upstream include update is also blocked or which fragment changed.  
   Fix: render desired composed output before drift classification and carry `blockedDesiredHash`, `blockedReason`, and `composedFromDiff` on drift operations.

9. **major - `agentwheel uninstall <package>` does not persist removal from the requested root set, so the next sync can reinstall it.**  
   Evidence: `uninstallConfiguredPackage` reads the merged config, computes `removed` and `remaining` arrays in memory, and never calls `writeWorkspaceConfig` or otherwise updates the source of truth (`src/cli/index.ts:579-645`).  
   Scenario: workspace config contains roots A and B. `agentwheel uninstall A` removes A-owned runtime files and keeps shared dependencies required by B. A later plain `agentwheel sync` reads the unchanged config, includes A again in the graph roots, and reinstalls A. That contradicts the Phase B uninstall model of removing a root from the requested set and recomputing ownership.  
   Fix: persist the package removal to the workspace config, or expose this as a non-persistent prune/target cleanup command and keep `uninstall <package>` for actual requested-set mutation.

10. **major - git source cache locking is process-local and still uses a mutable checkout, so concurrent CLI processes can race graph resolution.**  
    Evidence: the cache lock is a module-level `Map<string, Promise<void>>` (`src/resolve/graph.ts:106`, `388-402`), which does not coordinate separate CLI processes. `GitSourceDriver.fetch` mutates the same cache checkout with `checkout`/`reset --hard` for every ref (`src/source/git.ts:44-56`).  
    Scenario: two syncs for different targets resolve different refs of the same repo at the same time. Each process believes it has the cache lock, both mutate `.agentwheel/cache/<repo>`, and one process can list/hash a checkout moved by the other. The target apply locks do not protect this source-cache race.  
    Fix: use filesystem locks around cache repos and export per-commit/sourceHash snapshots before listing/hashing; do not render directly from a mutable shared checkout.

## Test gaps

1. Add blocking tests for root/root, root/direct, and transitive artifact collisions that assert no colliding create/update operation is emitted.
2. Add a `sync --profile` OpenPack dependency test proving profile mode resolves one combined graph per runtime and writes graph locks.
3. Add migration tests where a v1 entry has the same path but different package/hash and must become an unmanaged conflict, not an adopted update.
4. Add runtime-edge tests for `requires.<alias>.runtimes`, including "excluded dependency is not fetched or trusted".
5. Add direct dependency merge-target tests for `mcp`, `hooks`, `settings`, and plugins.
6. Add crash/recovery tests for the window after a copy succeeds but before `journal.completed` is persisted, and for SSH rollback behavior.
7. Add a graph-lock atomicity test that simulates failure between manifest write and graph-lock write.
8. Add drifted composed-artifact tests that assert blocked fragment/update diagnostics survive local drift.
9. Add package uninstall tests that run a subsequent sync and verify the removed root is not reinstalled.
10. Add an interprocess git-cache race test or at least a filesystem-lock assertion around git cache mutation.

Verification note: I ran `pnpm test`. The suite reported 100 passing tests and 2 failing registry tests because this sandbox cannot write `/home/administrator/.agentwheel/registry-cache.json`; the failures were `EROFS` from `src/utils/fs.ts:78` during registry cache writes.

## Re-review

Fix range reviewed: `git diff 7bab797..HEAD`, commits `0c68ff2` and `49f7091`.

Updated verdict: **SHIP-WITH-FIXES**. The three original blockers are substantively fixed and the highest-risk data-loss paths are now blocked or recovered. One original finding remains **PARTIAL**: graph-lock/config maintenance around package uninstall is still outside the uninstall mutation/journal, so crash consistency is not at the same standard as apply. I found no separate new blocker introduced by the fix commits.

1. **FIXED - Combined planning silently overwrites colliding install paths.**  
   Evidence: combined planning now keeps desired operations in an array (`src/install/plan.ts:112-121`) and splits them through `splitCollisionOperations` before constructing the final desired map (`src/install/plan.ts:132-137`, `354-385`). Fresh unresolved collisions become `conflict` operations with no create/update emitted (`src/install/plan.ts:380-424`); a clean manifest incumbent is allowed only after path hash and identity checks (`src/install/plan.ts:369-407`). This matches the prescribed direction. Test gap 1 is covered by `test/install-v2-b2.test.ts:426-446`.

2. **FIXED - `sync --profile` bypasses graph resolution.**  
   Evidence: the CLI now forwards graph options into `syncProfile` (`src/cli/index.ts:214-239`), and profile sync builds one `createGraphSourcePlan` per runtime instead of per-package `stageSource` plans (`src/lifecycle/profile.ts:55-113`). It applies via `applyCombinedInstallPlan` with the graph lock (`src/lifecycle/profile.ts:102-108`). Test gap 2 is covered by `test/openpack-b3-e2e.test.ts:225-274`.

3. **FIXED - v1 migration adopts legacy entries too broadly.**  
   Evidence: v1 migration now considers only same-path single candidates (`src/install/plan.ts:313-318`) and requires artifact type/name, source hash, package identity, target existence, and current installed hash before adoption (`src/install/plan.ts:335-351`). Mismatches are dropped from management and become unmanaged conflicts if desired content wants that path (`src/install/plan.ts:318-323`). Test gap 3 is covered by `test/install-v2-b2.test.ts:228-250`.

4. **FIXED - dependency-edge `runtimes` is ignored.**  
   Evidence: graph resolution accepts the target runtime (`src/resolve/graph.ts:25-36`), `createGraphSourcePlan` passes `options.adapter.name` (`src/lifecycle/source-plan.ts:111-120`), and dependency requirements are filtered before fetch/edge creation (`src/resolve/graph.ts:292-327`). This matches the fix direction because excluded dependencies are skipped before trust/fetch. Test gap 4 is covered by `test/openpack-b3-e2e.test.ts:196-223`.

5. **FIXED - direct dependency merge targets are allowed.**  
   Evidence: the guard now rejects every non-root guarded merge target, not just transitive ones (`src/install/plan.ts:106-109`, `487-488`). This blocks direct dependency `mcp`/`hooks`/`settings`/plugins until subentry ownership exists. Test gap 5 is covered by `test/install-v2-b2.test.ts:474-510`.

6. **PARTIAL - graph lock writes are outside the apply transaction and are not maintained by uninstall.**  
   Evidence fixed for apply: `ApplyOptions` now carries a graph lock (`src/install/apply.ts:30-38`), the journal stores it (`src/install/apply.ts:138-162`; `src/install/transaction.ts:28-42`), and apply writes it while the apply lock/journal still exists (`src/install/apply.ts:187-194`). CLI sync/profile pass the graph lock into apply (`src/cli/index.ts:260-268`, `496-504`; `src/lifecycle/profile.ts:102-108`).  
   Remaining gap: package uninstall still writes the new graph lock or removes it after `uninstall()` has already mutated runtime files/manifest (`src/cli/index.ts:651-667`), and only then persists the updated package set (`src/cli/index.ts:672-676`). There is no uninstall-side lock/journal tying file removals, install manifest, graph lock, and config together. A crash after uninstall but before graph-lock/config write can still leave stale requested-set state. Test gap 7 is not covered; test gap 9 is not covered end-to-end.

7. **FIXED - pending-apply recovery cannot handle mid-apply kills.**  
   Evidence: apply now journals a started mutation before running it (`src/install/apply.ts:165-183`), recovery treats a started operation whose desired hash landed as complete (`src/install/apply.ts:75-85`, `426-432`), and missing-source rollback now either rolls back local started operations or explicitly refuses unsafe remote rollback (`src/install/apply.ts:88-91`, `435-440`). This matches the prescribed finish-or-fail-explicitly direction. Test gap 6 is partially covered by `test/install-v2-b2.test.ts:368-385`; SSH rollback/fail-explicit behavior remains untested.

8. **FIXED - drifted composed artifacts hide pending fragment updates.**  
   Evidence: drift operations now carry `blockedDesiredHash`, `blockedReason`, and `composedFromDiff` (`src/install/plan.ts:189-200`, `548-559`), and formatting surfaces `blockedReason` (`src/cli/format.ts:32-36`). Test gap 8 is covered by `test/install-v2-b2.test.ts:390-423`.

9. **FIXED - `agentwheel uninstall <package>` does not persist removal from requested roots.**  
   Evidence: after package uninstall, the CLI writes the workspace config with `packages: remaining` (`src/cli/index.ts:672-676`). Remaining entries get the new graph lock digest in the uninstall plan (`src/install/uninstall.ts:72-112`, `159-167`). The requested-set fix direction is implemented, but there is no follow-up sync regression test; test gap 9 remains uncovered.

10. **FIXED - git cache locking is process-local and uses mutable checkouts.**  
    Evidence: `GitSourceDriver.fetch` now wraps cache mutation in a filesystem `mkdir` lock (`src/source/git.ts:31-43`, `140-160`) and exports a per-commit snapshot with `.git` removed before manifest/list/hash operations (`src/source/git.ts:59-70`, `123-137`). This addresses the interprocess cache race direction. Test gap 10 remains uncovered by tests.

New findings from the fix commits: none independent of the residual PARTIAL status on finding 6.

Updated test gap coverage:

| Original test gap | Current coverage |
| --- | --- |
| 1. root/root, root/direct, transitive collisions | Covered: `test/install-v2-b2.test.ts:426-446`. |
| 2. profile OpenPack dependency graph sync | Covered: `test/openpack-b3-e2e.test.ts:225-274`. |
| 3. strict v1 same-path migration conflict | Covered: `test/install-v2-b2.test.ts:228-250`. |
| 4. dependency-edge runtimes skipped before trust/fetch | Covered: `test/openpack-b3-e2e.test.ts:196-223`. |
| 5. direct dependency merge targets | Covered: `test/install-v2-b2.test.ts:492-510`. |
| 6. post-copy journal recovery / SSH rollback | Partially covered: local post-copy recovery at `test/install-v2-b2.test.ts:368-385`; SSH behavior not covered. |
| 7. graph-lock atomicity failure | Not covered. |
| 8. drifted composed-artifact diagnostics | Covered: `test/install-v2-b2.test.ts:390-423`. |
| 9. package uninstall followed by sync does not reinstall | Not covered. |
| 10. interprocess git-cache race / filesystem lock | Not covered. |

Verification: `pnpm typecheck` passed. Targeted re-review tests passed: `pnpm exec vitest run test/install-v2-b2.test.ts test/openpack-b3-e2e.test.ts test/wave3.test.ts test/runtime-target.test.ts` (32 tests). Full `pnpm test` still fails only the two registry-cache tests with `EROFS` writing `/home/administrator/.agentwheel/registry-cache.json`; all other 107 tests passed in this sandbox.

## C-E focused pass

Review range: `a32e726..feat/openpack-phase-e`.

Verdict: **BLOCK**.

1. **blocker - `--offline` is not a zero-network mode on several reachable paths.**  
   Evidence: the CLI runs the npm update check before command parsing, so `agentwheel sync --offline` can fetch `https://registry.npmjs.org/agentwheel` on a TTY unless the separate `--no-update-check` flag or env var is also set (`src/cli/index.ts:1022-1029`; `src/cli/update-check.ts:45-68`). The `plan`/`sync` `--no-deps --only-source` branch routes through `buildPlan` (`src/cli/index.ts:176-186`, `253-260`), but `buildPlan` has no `offline`/`frozenLock` parameter and calls `createSourcePlan` directly (`src/cli/index.ts:508-520`); `createSourcePlan` then calls registry resolution and `stageSource` without offline constraints (`src/lifecycle/source-plan.ts:76-88`; `src/staging/staging.ts:37-38`). Profile sync has the same registry hole for explicit profile sources because `packageFromSource` calls `resolvePackageSource(source, options.workspaceRoot)` without `options.offline` (`src/lifecycle/profile.ts:153-155`). Even inside the graph resolver, a locked remote SkillKit dependency still calls the provider clone path: `fetchPackage` passes `frozenLock` into the driver (`src/resolve/graph.ts:657-664`), but `SkillKitSourceDriver.resolve` ignores it for remote specs (`src/source/skillkit.ts:50-71`) and `fetch` unconditionally calls `provider.clone(...)` (`src/source/skillkit.ts:74-88`). This violates the advertised offline invariant across registry TTL, update-check, git/source fetch, and provider paths.

2. **blocker - workspace aliases can path-traverse install destinations and write outside the adapter target tree.**  
   Evidence: workspace package aliases are accepted as arbitrary non-empty strings (`src/model/workspace.ts:8-21`). `assignInstallNames` applies those values verbatim as `installName` (`src/resolve/render.ts:186-195`, `248-270`). Planning then joins the alias directly into the adapter destination for directory targets (`src/install/plan.ts:491-519`) and apply copies to that computed `operation.destPath` without a target-root containment check (`src/install/apply.ts:358-368`). A config alias such as `"some/pkg:rules/safe.md": "../../../outside.md"` produces a `relativeDestPath` with `..` segments and can escape `targetRoot` during sync.

3. **major - `trust.denyArtifactTypes` does not apply to root-selected artifacts.**  
   Evidence: `assertTrustArtifactPolicy` skips every root node before checking selected artifact types (`src/lifecycle/trust.ts:51-57`). Roots select all artifacts by default when no explicit `select` is provided (`src/resolve/graph.ts:734-749`). A root package that provides `hooks`, `settings`, `mcp`, or `plugins` therefore bypasses `trust.denyArtifactTypes`, even though the policy name is not dependency-scoped and the focused gate explicitly requires root-selected enforcement.

4. **major - persisted trust can be poisoned through project config and suppress the first-use transitive prompt.**  
   Evidence: `normalizeTrustPolicy` accepts `acceptedSources` directly from `.agentwheel/config.json` (`src/lifecycle/trust.ts:18-24`), and `evaluateTransitiveTrust` treats those entries as already trusted before checking new transitive graph nodes (`src/lifecycle/trust.ts:34-43`). The same project config file is where prompted decisions are written (`src/lifecycle/trust.ts:70-82`; `src/model/workspace.ts:84-95`). A repository can pre-populate `trust.acceptedSources` for its own transitive dependency normalized source and the resolver will skip the prompt on first sync.

5. **major - global trust policy is merged by the model but ignored by graph planning.**  
   Evidence: workspace config merging explicitly combines global and project trust fields, including `allow`, `acceptedSources`, `denyArtifactTypes`, and `requireReviewForTransitive` (`src/model/workspace.ts:124-142`, `162-168`). `createGraphSourcePlan` does not read that merged config; it reads only the project-local config before enforcing trust (`src/lifecycle/source-plan.ts:107-135`). A user-level global deny or review policy is therefore not enforced during the graph trust gate.

6. **major - package-scoped workspace aliases are applied globally across all roots.**  
   Evidence: CLI graph roots carry aliases from each configured package (`src/cli/index.ts:647-655`), and the resolver records them on that root (`src/resolve/graph.ts:289-298`). Rendering then flattens every root's aliases into one map (`src/resolve/render.ts:263-270`) and `aliasForArtifact` matches any graph artifact by node id, `name@version`, or package name without checking which root declared the alias or owns the artifact (`src/resolve/render.ts:248-259`). One workspace package can therefore rename artifacts belonging to another root when the package selector matches. Exact install-name theft is later blocked as a collision, but cross-root alias leakage still breaks alias scoping and can silently move another root's artifact to a different install name.

7. **minor - graph lock files are not byte-identical for identical graphs.**  
   Evidence: graph resolution stamps `generatedAt` with the current time by default (`src/resolve/graph.ts:175-182`). `writeGraphLock` serializes the full lock, and `stringifyGraphLock` preserves `generatedAt` in the output (`src/model/graph-lock.ts:116-124`, `131-136`). Even if `canonicalGraphLockJson` excludes that timestamp for digesting, two identical resolutions still produce different lock-file bytes, so the Phase D determinism goal is not met for the persisted lock.

## C-E re-review

Review range: `git diff 7370873..feat/openpack-phase-e`, commits `9e16dbe`, `a3e0540`, `7a1339b`, and `6d191c5`.

Final C-E verdict: **SHIP**. All seven focused C-E findings are fixed in code, with focused tests and typecheck passing. I found no new regression in the reviewed trust/offline or namespacing/alias surfaces.

1. **FIXED - `--offline` is not a zero-network mode on several reachable paths.**  
   Evidence: the update check now disables itself whenever argv contains `--offline` (`src/cli/update-check.ts:54-61`), before the pre-parse update fetch could run from `main` (`src/cli/index.ts:1026-1033`). The legacy `--no-deps --only-source` path now threads `frozenLock`/`offline` through `buildPlan` into `createSourcePlan` (`src/cli/index.ts:179-185`, `253-263`, `509-524`); `createSourcePlan` uses offline registry resolution and passes `frozenLock` into staging (`src/lifecycle/source-plan.ts:81-95`). Profile explicit-source resolution also passes offline into `resolvePackageSource` (`src/lifecycle/profile.ts:153-157`). The remote SkillKit path now returns only cached content under `frozenLock` and refuses missing cache without calling the provider clone path (`src/source/skillkit.ts:64-88`). This matches the prescribed zero-network direction for the paths cited.

2. **FIXED - workspace aliases can path-traverse install destinations and write outside the adapter target tree.**  
   Evidence: `assertSafeInstallName` rejects empty, dot, dot-dot, slash, and backslash install names (`src/install/path-safety.ts:4-11`), and planning applies it to every artifact install name, including aliases (`src/install/plan.ts:494-500`). Planning validates desired and emitted operations are contained in `targetRoot` (`src/install/plan.ts:125-133`, `259-260`), and apply/recovery/uninstall re-check containment before mutating (`src/install/apply.ts:90-91`, `169-170`, `215-216`). This is not cosmetic: both the alias value and the final operation sink are guarded.

3. **FIXED - `trust.denyArtifactTypes` does not apply to root-selected artifacts.**  
   Evidence: `assertTrustArtifactPolicy` no longer skips `raw.depth === 0`; it iterates every selected selector for every raw node (`src/lifecycle/trust.ts:63-78`). Since root packages still select all artifacts by default without an explicit selection (`src/resolve/graph.ts:734-749`), denied root `hooks`/`mcp`/`settings`/`plugins` now block. Regression coverage is in `test/openpack-phase-e.test.ts:105-126`.

4. **FIXED - persisted trust can be poisoned through project config and suppress the first-use transitive prompt.**  
   Evidence: graph planning builds policy from merged config but overwrites `acceptedSources` with `readTrustedSources(...)` from a separate trust store (`src/lifecycle/source-plan.ts:113-118`). Accepted sources are now read/written in `~/.agentwheel/trust.json` or `AGENTWHEEL_TRUST_STORE`, not the project config (`src/lifecycle/trust.ts:81-90`, `118-129`). Project-local `trust.acceptedSources` may still parse for backward compatibility, but it is not used by `createGraphSourcePlan`. Regression coverage is in `test/openpack-phase-e.test.ts:195-224`.

5. **FIXED - global trust policy is merged by the model but ignored by graph planning.**  
   Evidence: `createGraphSourcePlan` now calls `readMergedWorkspaceConfig(workspaceRoot, { globalRoot })` before normalizing trust (`src/lifecycle/source-plan.ts:113-118`), so the existing merge logic for global/project trust applies to graph planning (`src/model/workspace.ts:124-142`, `162-168`). Regression coverage is in `test/openpack-phase-e.test.ts:226-248`.

6. **FIXED - package-scoped workspace aliases are applied globally across all roots.**  
   Evidence: aliases now retain `rootId`, `rootNodeId`, and the root's reachable node set (`src/resolve/render.ts:186-192`, `266-275`). Alias application checks reachability before matching an artifact (`src/resolve/render.ts:257-264`), and `validateAliasScopes` rejects aliases that match only artifacts outside the declaring root's graph (`src/resolve/render.ts:277-289`). Regression coverage is in `test/openpack-phase-e.test.ts:362-386`.

7. **FIXED - graph lock files are not byte-identical for identical graphs.**  
   Evidence: `createGraphLock` no longer stores graph `generatedAt` in locks, and the schema now treats `generatedAt` as optional for old lock compatibility (`src/resolve/graph.ts:185-216`; `src/model/graph-lock.ts:96-100`). `canonicalizeGraphLock` serializes only stable canonical data, omitting `generatedAt` entirely (`src/model/graph-lock.ts:123-161`). Regression coverage asserts two identical graph locks stringify byte-identically and do not contain `generatedAt` (`test/openpack-phase-e.test.ts:443-469`).

Verification: `pnpm typecheck` passed. Focused tests passed: `pnpm exec vitest run test/openpack-phase-e.test.ts test/update-check.test.ts` (20 tests). `git diff --check 7370873..feat/openpack-phase-e` reported no whitespace errors.
