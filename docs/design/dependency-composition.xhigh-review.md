## Verdict table

| Decision | Verdict | Why |
| --- | --- | --- |
| Current pipeline is single-source per `(targetRoot, adapter)` | CONFIRM | Source matches the claim: one `stageSource`, one `createInstallPlan`, and `applyInstallPlan` rewrites the manifest. |
| Move to "resolved dependency closure -> one combined plan -> one manifest" | AMEND | Correct architecture, but it must be target-grouped and protected by an apply lock, manifest base revision, and recovery journal. |
| Synthetic-root migration for v1 manifests | AMEND | A single synthetic owner prevents mass deletion, but it is not enough to adopt/prune legacy entries safely. |
| Add graph resolver between staging and planning | AMEND | Keep the layer, but split raw package staging from target-specific rendering/customization/composition. |
| Source drivers and adapters stay as they are | AMEND | Drivers mostly stay intact, but staging/customization boundaries and merge-target adapters need graph-aware metadata. |
| Two identities per artifact | AMEND | `package@version:type/name` is insufficient; logical identity must include normalized source or graph node id. |
| Root/direct collision policy with incumbent plain name | AMEND | "Workspace-config order" is not stable in current code and must be replaced by explicit root ids/priority plus lock-persisted incumbents. |
| Transitive auto-namespacing | CONFIRM | The flat-runtime answer is sound if deterministic sorting and source-qualified suffixes are mandated. |
| Resolve by source identity now, semver later | AMEND | Good for Phase B, but "source identity" needs exact normalization, registry-short-name rules, and frozen-lock semantics. |
| Keep package `schemaVersion: 1` while adding optional dependency/composition fields | REJECT | Current v1 CLIs silently ignore `requires`/`items` and reject `fragments`; this is not a safe preview contract. |
| Sync-time Markdown transclusion | AMEND | Confirm inline output, but define idempotent expansion, override order, drift/update ordering, and marker/source-map rules. |
| Fragments first-class but not installed | AMEND | Correct model, but adding `fragments` touches the artifact enum, selection, customization, lock, and old-CLI compatibility. |
| Ownership is recomputed, refcounts are derived | CONFIRM | Recomputing from remaining roots is the right model and avoids mutable counter drift. |
| Selection propagation limits transitive sprawl | CONFIRM | The rule matches existing `required` behavior; graph diagnostics must explain every selected/required pull. |
| Trust like a supply chain | AMEND | The trust section misses dependency confusion and should move minimal frozen/integrity enforcement earlier. |
| Separate graph lock | AMEND | Separate lock is fine, but it needs canonical ordering, target/profile keying, and stable-vs-volatile fields. |
| Multi-owner install manifest fields | AMEND | Fields are right, but merged JSON/TOML/plugin operations need per-owner subentry semantics or should be blocked as deps. |
| Package and composition cycles | CONFIRM | The fixed-point package rule and fatal composition cycles are sound if selector ordering is canonical. |
| `deps tree`, `deps why`, dry-run graph output | CONFIRM | Required UX for the feature; make it target-group aware and show blocked updates behind drift. |
| Versioned overrides/eject | AMEND | Version-only paths remain ambiguous; use exact graph node ids/source digests with package/version as shorthand. |
| Phase A without graph resolver | AMEND | Shippable only with schema gating and a target-render path; do not expose unsafe v1 fragment manifests to old CLIs. |
| Phase B package dependencies | AMEND | The phase is understated; it must include target-group planning, migration/adoption, apply locking, and minimal frozen-lock. |
| Phase E for `--frozen-lock`/offline/integrity | REJECT | A minimal `--frozen-lock` and integrity/no-network mode must ship with the graph lock in Phase B; richer policy can wait. |
| `reference`/`hybrid` later | CONFIRM | Inline-first remains the compatible default; reference modes should stay adapter-specific later work. |

Counts: CONFIRM 7, AMEND 15, REJECT 2.

## Findings

1. **blocker - combined apply is not safe without a target-scoped transaction/lock.**

   Plan text: "the resolved dependency closure (N staged bundles) -> one combined plan -> one manifest whose entries carry multi-owner provenance" and "Drivers, adapters, drift checks, and install operations remain intact."

   Source grounding: `applyInstallPlan` copies/removes operation-by-operation, then writes the manifest and source lock at the end (`agentwheel/src/install/apply.ts:43-154`). `atomicCopy` removes the destination before renaming the temp path (`agentwheel/src/utils/fs.ts:62-72`). SSH does the same remote remove/move sequence (`agentwheel/src/transport/ssh.ts:65-77`). There is no lock around `readInstallManifest -> createInstallPlan -> applyInstallPlan`, and concurrent configured-package syncs currently read/write the same `${adapter}.install-manifest.json`.

   Scenario: sync A and sync B both read manifest M0. A applies files for graph G1 and writes manifest M1. B, planned from M0, applies graph G2 and writes M2. Runtime files can contain a mixture while the manifest only describes B. A mid-apply failure leaves changed files with old manifest M0, so the next run reports drift rather than a clean repair.

   Concrete fix: Phase B must introduce a target/adaptor apply lock (`.agentwheel/<adapter>.apply-lock`, implemented with atomic directory creation locally and remote `mkdir` over SSH), store a base manifest hash/revision in the plan, write a pending apply journal before file operations, verify copied hashes, then atomically write graph lock and install manifest. If the base revision changed, abort and replan. Add a recovery command/path that can finish or roll back pending operations from the journal.

2. **major - the direct/direct incumbent rule relies on an order that current code does not preserve.**

   Plan text: "on fresh installs, workspace-config order decides the incumbent, the other blocks with the same hint."

   Source grounding: `upsertPackage` removes any package with the same name, pushes the new entry, then sorts packages by `name` (`agentwheel/src/model/workspace.ts:86-90`). `runConfiguredPackages` iterates `config.packages` in that stored order (`agentwheel/src/cli/index.ts:384-420`). Global/project config merge also replaces global packages wholesale when the project has packages (`agentwheel/src/model/workspace.ts:117-130`), so the effective root set can change by adding a single project package.

   Scenario: fresh workspace adds package `zeta` first, then `alpha`; both provide `skills/review`. Because config is sorted, `alpha` becomes the "first" root. A later rename from `alpha` to `beta` changes order and can change the chosen incumbent without any artifact change.

   Concrete fix: add immutable `rootId` and explicit `priority` or `addedAtOrdinal` to `WorkspacePackage`; never infer collision priority from array order. The graph lock should record `plainNameIncumbents` by `(adapter,target,type,name) -> graphNodeId/logicalSelector`. On an existing install, the lock/manifest incumbent wins if unchanged. On a true fresh install without lock, use explicit priority and fail the whole colliding install until the user chooses alias/deselect/override. Do not install one fresh direct root while another direct root is blocking.

3. **major - schema v1 preview is unsafe with current parsers and old CLIs.**

   Plan text: "`schemaVersion`: 1, // stays 1 while fields are optional; v2 when stable" and "Phase 0 - Parse `requires`/`items`/`compose`/`fragments` permissively."

   Source grounding: current package manifests are parsed by `packageManifestSchema` with only `schemaVersion`, `name`, `version`, and `provides` (`agentwheel/src/model/package.ts:15-20`). Unknown object keys such as root-level `requires` and provide-level `items` are stripped by default, so old/new partial CLIs can silently ignore the dependency contract. Worse, `provides[].type` uses `artifactTypeSchema`, which does not include `fragments` (`agentwheel/src/model/artifact.ts:3-13`), so any manifest containing `{ "type": "fragments" }` is rejected by current v1 code.

   Scenario: an author publishes a v1 manifest with `requires` and `compose` but no `fragments` provide. An older CLI installs the unexpanded artifact, ignores dependencies, and may still write a normal source lock/manifest. If the author adds `fragments`, the same schemaVersion now hard-fails.

   Concrete fix: reject "v1 optional fields" as the compatibility story. Use either `schemaVersion: 2` for any install-affecting `requires`, `items`, `compose`, or `fragments`, or add a required `agentwheelFeatures`/`minimumAgentwheelVersion` field that old CLIs fail on via schema refinement. Phase 0 validation can be permissive in the new CLI, but published manifests that depend on composition/deps must not look like safe v1 packages to older installers.

4. **major - "stage each resolved package once" conflicts with target-specific customizations and profile runtimes.**

   Plan text: "stages each resolved package once, emits a `ResolvedGraphBundle`" and "Source drivers and adapters stay as they are."

   Source grounding: `stageSource` does more than raw staging: it copies artifacts, composes assets, filters selection, then applies workspace/adapter customizations when `workspaceRoot` and `adapter` are present (`agentwheel/src/staging/staging.ts:26-54`). `applyCustomizations` applies package-specific overrides/ejections, additions, and an adapter-specific instruction overlay (`agentwheel/src/staging/customize.ts:14-20`, `23-59`). `syncProfile` runs each package for each runtime, with potentially different adapters/targets (`agentwheel/src/lifecycle/profile.ts:50-81`).

   Scenario: one workspace profile syncs the same source to Codex and Claude. The Codex target has a `.agentwheel/overlays/codex/instructions.local.md`; Claude has none. If the graph resolver stages the package once and shares the post-customization artifact across runtimes, one runtime gets the other's rendered instructions or hashes.

   Concrete fix: split the pipeline into `fetch/read/list/rawStage` and target-scoped `renderGraphForTarget`. The graph resolver may fetch and list each source once, but selection, Markdown include expansion, fragment overrides, instruction overlays, adapter merge behavior, naming, and hashing must happen per `(workspaceRoot,targetRoot,transport,adapter,adapterConfig/profile runtime)`.

5. **major - synthetic-root migration needs adoption/prune semantics, not just one owner.**

   Plan text: "import existing v1 entries as one synthetic root/owner so current installs are not mass-removed on first sync."

   Source grounding: current v1 entries have `path`, artifact type/name, hash/sourceHash, channel, optional `packageName`, but no selected root, graph node, source identity, or owners (`agentwheel/src/model/manifest.ts:4-17`). `applyInstallPlan` rebuilds entries only from the current plan's operations (`agentwheel/src/install/apply.ts:40-152`).

   Scenario: an existing v1 manifest contains entries from the last clobbering sync only. The new graph sync includes two configured roots and a shared dependency. If every old entry is assigned one synthetic owner, the resolver cannot tell whether a path should be adopted by root A, root B, both, or preserved as a legacy orphan. If the synthetic owner remains forever, uninstall never removes old entries. If it is dropped immediately, first sync can delete unmanaged-but-previously-agentwheel files.

   Concrete fix: migrate v1 entries as `legacyOwner` with `migrationStatus: pending`. During the first combined plan, adopt legacy entries whose path/hash/packageName match a new logical artifact; preserve unmatched entries as `keep legacy orphan` with a dry-run warning and an explicit `agentwheel prune-legacy` path. Store `migratedFromManifestVersion`, base manifest hash, and adoption decisions in the v2 manifest. Do not treat a synthetic owner as a normal root for future refcounts.

6. **major - tracking dependency updates and drift need a two-result diagnostic.**

   Plan text: "tracking deps" are in the source model, and "staged output ... is hashed, drift-protected, and re-expanded on update."

   Source grounding: current update decisions are based on one adapter source lock, not a graph (`agentwheel/src/lifecycle/update.ts:9-22`; read in `agentwheel/src/cli/index.ts:394-401`). Current planning detects drift before comparing desired content (`agentwheel/src/install/plan.ts:128-148`), so if an installed composed skill is drifted, an included fragment update will be hidden behind a plain drift operation.

   Scenario: root `triage` includes tracking dependency fragment `core:fragments/risk.md`. The user edits installed `skills/triage/SKILL.md`. `core` moves. The desired re-expanded skill changes, but the current planner reports only "managed destination changed outside agentwheel"; the user cannot see that a fragment update is also waiting, or whether accepting upstream would overwrite local edits.

   Concrete fix: graph update must re-resolve tracking roots and tracking dependencies, render desired composed outputs first, then drift-check. A drift operation should carry `blockedDesiredHash`, `blockedReason`, and `composedFromDiff` so dry-run can say "drift blocks update: included fragment changed from A to B." Never silently update drifted composed artifacts.

7. **major - graph lock determinism and `--frozen-lock` need stronger rules than the plan states.**

   Plan text: "Graph lock ... roots, nodes ..., edges" and "`--frozen-lock` refuses new sources/versions/hashes; `--offline` is cache+lock only."

   Source grounding: `GitSourceDriver.fetch` fetches/prunes on every existing cache use (`agentwheel/src/source/git.ts:30-38`) and mutates a single cache checkout per normalized URL (`agentwheel/src/source/git.ts:101-108`). `RegistryClient` refetches registries when TTL expires and merges duplicate names first-wins by source order (`agentwheel/src/registry/client.ts:38-49`, `136-143`). Existing locks include `generatedAt` (`agentwheel/src/model/manifest.ts:31-52`), which is volatile if compared naively.

   Scenario: `agentwheel install --frozen-lock` with a bare registry dependency whose registry cache is expired can hit the network and resolve a different short-name entry before even checking the graph lock. Two concurrent graph resolutions of different refs from the same repo mutate the same cache checkout.

   Concrete fix: define a canonical graph lock with sorted roots/nodes/edges/owners/selections and separate volatile metadata (`generatedAt`, human diagnostics) from the frozen comparison. Under `--frozen-lock`, do not call registry refresh or `git fetch`; use only locked source URLs, commits, source hashes, and verified cached snapshots. Replace mutable per-URL checkout use with per-commit/sourceHash snapshots or lock the cache repo during checkout/export. `--offline` should fail with a precise missing-cache node list.

8. **major - SSH and profiles need state keys that the plan does not define.**

   Plan text: "Graph lock - `.agentwheel/<adapter>.graph-lock.json`" and earlier proposal note "SSH targets: resolution and staging happen locally; install manifest/hash reads happen remotely as today."

   Source grounding: install manifests/source locks are currently read and written through the target transport, so for SSH they live under the remote target root (`agentwheel/src/install/manifest.ts:8-25`; `agentwheel/src/runtime/target.ts:109-129`). Profile sync loops packages and runtimes, applying each package to each target (`agentwheel/src/lifecycle/profile.ts:50-81`). State paths are only `${adapter}.install-manifest.json` and `${adapter}.source-lock.json` (`agentwheel/src/install/paths.ts:3-13`).

   Scenario: one workspace has two Codex SSH agents with different remote roots and one local Codex runtime. A single local `.agentwheel/codex.graph-lock.json` is ambiguous; a remote-only graph lock cannot be read for offline planning without SSH; same adapter names with different adapter configs can overwrite each other's lock if targetRoot is the same.

   Concrete fix: define two state layers. The source graph lock lives in the local workspace under a target fingerprint, e.g. `.agentwheel/locks/<profile-or-agent>/<adapter>/<targetDigest>.graph-lock.json`, and includes adapter config hash, targetRoot, transport, and runtime name. The remote install manifest remains on the remote target and records the graph lock digest it was applied from. Profile sync must group by target and apply one combined plan per target, not package-by-package.

9. **major - dependency source confusion is currently easy.**

   Plan text: "`source`: any driver: github:|git:|vercel:|skillkit:|local|registry" and "Trust like a supply chain."

   Source grounding: `resolvePackageSource` treats a non-explicit string as a local path if `isExplicitSource` sees that path exists, otherwise it resolves via registry (`agentwheel/src/registry/client.ts:125-134`; `agentwheel/src/source/identify.ts:13-21`). The path check is not relative to the declaring package root; it uses process cwd resolution (`agentwheel/src/source/identify.ts:23-27`). Registry duplicate names are merged first-wins by configured source order (`agentwheel/src/registry/client.ts:136-143`).

   Scenario: a manifest declares dependency `"source": "core-rules"`. In CI, a local `./core-rules` directory exists, so it is treated as a local explicit source. On a user's machine, it resolves through a registry. Or a user adds a private registry source before the default, and `core-rules` now points to a different repo on first install.

   Concrete fix: in package manifests, make bare names mean registry only, and make local deps explicit (`./`, `../`, `local:`) and resolved relative to the declaring package root. Consider `registry:<name>` for clarity in published packages. Lock the resolved registry source, registry index source, manifest name, and source hash. If a registry name resolves to a different source than the lock, require explicit update/trust.

10. **major - include alias resolution and override order are underspecified enough to pull the wrong content.**

   Plan text: "cross-package only via declared aliases", "Overrides on fragments apply before transclusion (powerful, must be visible in dry-run)", and "Selector grammar: local `type/name`; dependency `alias:type/name`."

   Source grounding: current customizations are package-name/path based (`.agentwheel/overrides/<package>/<type>/<name>`) and applied after selection in `stageSource` (`agentwheel/src/staging/staging.ts:45-54`; `agentwheel/src/staging/customize.ts:84-119`). There is no graph node id in override paths, and the hardcoded replacement type list does not include `fragments` (`agentwheel/src/staging/customize.ts:95`).

   Scenario: dependency alias `core` points to package A in version 1 of a root manifest, then to package B after an update. Existing `<!-- agentwheel:include core:fragments/risk.md -->` now expands from B. A package-level override for `nestdevlab/core` also becomes ambiguous if two source-qualified nodes share the same manifest name/version.

   Concrete fix: build a lexical alias table per declaring graph node and lock each include edge to `{fromNodeId, alias, toNodeId, selector, sourceHash}`. Do not fall back from alias to package names. Reserve alias syntax so local artifact names cannot shadow aliases. Apply fragment overrides/ejections before expansion only when they match exact graph node id; allow package/version override shorthand only if it resolves to exactly one node. Apply artifact-level overrides after expansion unless explicitly marked as fragment overrides.

11. **major - merged settings/MCP targets cannot safely participate in multi-owner dependency uninstall as ordinary files.**

   Plan text: "mcp/hooks deps get extra warnings" and "Install manifest entries gain ... owners[]".

   Source grounding: JSON merge deep-merges source into existing destination and dedupes arrays (`agentwheel/src/install/json-merge.ts:6-46`). Codex TOML merge removes managed MCP sections only by server names present in the incoming source (`agentwheel/src/install/toml-merge.ts:8-15`, `31-56`). Manifest entries currently store one path/hash/sourceHash per merged destination (`agentwheel/src/install/apply.ts:103-122`, `127-139`).

   Scenario: root A and root B both contribute `.codex/config.toml` MCP servers. Uninstalling A must remove only A-owned server sections while preserving B-owned sections and user sections. A single manifest entry for `.codex/config.toml` with `owners: [A,B]` is not enough to know which TOML sections came from A, especially after source B changes a server with the same name.

   Concrete fix: for merge targets, manifest ownership must be per semantic subentry, not just per path: e.g. `mcpServers.<name> -> owners/sourceHash/graphNodeId`. Planning must detect subentry collisions the same way as flat artifact collisions. Until that exists, block transitive dependency installation for `mcp`, `hooks`, `settings`, and semantic plugins, except when explicitly selected by a root with a review prompt.

12. **major - fresh direct/direct collision cannot both choose an incumbent and apply a blocking plan.**

   Plan text: "on fresh installs, workspace-config order decides the incumbent, the other blocks with the same hint."

   Source grounding: `createInstallPlan` sets `hasBlockingChanges` when any operation is `drift` or `conflict` (`agentwheel/src/install/plan.ts:188-194`), and `applyInstallPlan` refuses to apply any blocking plan (`agentwheel/src/install/apply.ts:33-38`). There is no mechanism to apply a non-conflicting subset while a collision remains.

   Scenario: fresh install has root A and root B, both `skills/review`. If the resolver emits A as create and B as blocking collision, the whole plan refuses to apply, so the "incumbent" is only a diagnostic fiction. A later run after user deletes B or aliases it could choose a different A/B order if config changed.

   Concrete fix: on fresh direct/direct collision, produce a pre-plan resolution error with proposed incumbent but no create operation for either colliding path. Require alias/deselect/override before first apply. The "already-installed unchanged incumbent" rule should apply only when a manifest entry exists and passes drift check.

13. **minor - marker survival and idempotency need explicit composition rules.**

   Plan text: "staged output embeds them between provenance markers ... and is hashed, drift-protected, and re-expanded on update."

   Source grounding: existing instruction overlays write BEGIN/END comments into a newly generated `.agentwheel-composed` file (`agentwheel/src/staging/customize.ts:32-47`) and hash that file (`agentwheel/src/staging/customize.ts:49-56`). There is no code today that strips/rebuilds existing generated include blocks.

   Scenario: a package author commits a generated `SKILL.md` containing old `BEGIN agentwheel include` blocks, or a formatter strips HTML comments from installed Markdown. Re-expanding by scanning the current text can duplicate include content, while source-only expansion may lose author edits inside markers.

   Concrete fix: expansion must always start from raw source package content, not installed output or prior generated output. Reject committed generated include blocks unless escaped or explicitly allowed. Keep markers by default and store a sidecar source map in the manifest; if markers are stripped in the runtime file, it is normal drift. Include expansion must be deterministic and idempotent under repeated syncs from the same raw source and lock.

14. **major - performance at scale needs a cache/fetch policy in Phase B, not later.**

   Plan text: "Phase B - Recursive `requires` ... graph lock" and "Phase E - Trust hardening + offline."

   Source grounding: Git fetch currently runs for every git source every staging pass (`agentwheel/src/source/git.ts:30-38`). `syncProfile` and `runConfiguredPackages` stage separately per package/runtime today (`agentwheel/src/lifecycle/profile.ts:50-81`; `agentwheel/src/cli/index.ts:384-420`). Registry fetches can run on TTL expiry (`agentwheel/src/registry/client.ts:38-49`).

   Scenario: ten roots share the same tracking dependency graph with twenty transitive git repos and two profile runtimes. A naive Phase B can perform dozens of serial `git fetch` operations per sync, hit rate limits, and still fail offline even if the lock and cached commits are present.

   Concrete fix: Phase B should include fetch de-duplication by normalized source/ref, per-cache locks, parallel fetch with bounded concurrency, `--prefer-lock` default for pinned nodes, and dry-run cache-miss reporting. Full policy UX can wait, but graph resolution cannot be "N transitive git fetches every sync" by design.

15. **minor - package cycles need canonical selector/order semantics.**

   Plan text: "Package cycles: re-entering an active ancestor is OK if it adds no new unsatisfied selection; otherwise fixed-point with small iteration cap."

   Source grounding: current selection normalization dedupes into a `Set` and preserves parsed order from options (`agentwheel/src/model/selection.ts:10-36`). Artifact listing is sorted for local/manifest directories (`agentwheel/src/source/local.ts:146-179`), but graph selection propagation will combine selectors from multiple roots and dependencies.

   Scenario: A requires B selecting `rules/x`; B requires A selecting `rules/y`; config order changes the insertion order of selectors. Without canonical sort before fixed-point comparison, the same graph can produce different lock order or hit the iteration cap differently.

   Concrete fix: canonicalize selector sets, owner sets, edge lists, and diagnostics before fixed-point comparison and before lock serialization. The iteration cap should be over graph state changes, not raw loop count with order-sensitive arrays.

## New ideas considered

1. **Kept: target apply journal plus manifest base revision.** Neither prior document turns the combined plan into a transactional target operation. This is necessary because current apply writes files before state and has no concurrency guard. It should be part of Phase B, not an implementation detail.

2. **Kept: immutable root ids and explicit collision priority.** The plan's "workspace config order" sounds deterministic but current config writes sort by name. Add `rootId` and `priority` so collision outcomes survive reordering, package rename, and global/project config merge.

3. **Kept: source grammar hardening for dependency manifests.** Bare short names should not be allowed to drift between local path and registry resolution depending on cwd. Published manifests should use explicit driver/local prefixes or registry names with locked source provenance.

4. **Rejected: sidecar-only composition maps with no inline markers.** Sidecar-only maps would make installed Markdown cleaner and survive comment-stripping tools, but they make runtime inspection and drift explanation worse. Keep inline markers by default plus manifest source maps; allow marker suppression only as an explicit advanced option after idempotency is proven.

5. **Rejected for now: applying non-conflicting subsets when direct/direct collisions exist.** This would give users partial progress, but it creates confusing first-install state and makes the future incumbent dependent on a failed apply. For fresh direct collisions, block before applying any colliding direct roots.

## Amended decisions

1. **Combined pipeline.** Replace the single-source installer with a target-grouped graph pipeline: for each `(workspaceRoot,targetRoot,transport,adapter,adapterConfig/profile runtime)`, resolve all configured roots plus dependency closure, render one desired artifact set, create one plan against one manifest base revision, and apply under a target/adaptor lock with a recovery journal.

2. **Synthetic-root migration.** Migrate v1 manifest entries as `legacyOwner` entries with pending adoption status. Adopt entries into real graph owners only when path/hash/package metadata match the new graph; preserve unmatched entries as legacy orphans until explicit prune. Do not let the synthetic owner act as a normal refcount owner after migration.

3. **Graph resolver/staging boundary.** The resolver may fetch/read/list raw package content once per locked source, but target-specific rendering happens after graph resolution: selection propagation, namespacing, fragment override application, Markdown expansion, instruction overlays, adapter merge planning, and final hashing are per target.

4. **Driver/adapter boundary.** Source drivers remain responsible for resolving/fetching/exporting/listing sources. Adapters remain responsible for target paths and merge semantics. The lifecycle layer must add graph-aware metadata for merge targets, plugins, and programmatic operations; those cannot be treated as ordinary file artifacts when multi-owned.

5. **Logical identity.** Artifact logical identity is `graphNodeId:type/name`, where `graphNodeId` includes manifest name, version, normalized source identity, resolved commit or content hash, and source digest. `package@version:type/name` is a display shorthand only when unambiguous.

6. **Direct/direct collision.** Direct/root collisions for invoked artifacts are never auto-renamed. If an unchanged managed incumbent exists, keep that incumbent and block newcomers. On fresh installs, use explicit root priority to choose a proposed incumbent for diagnostics, but block the colliding path until the user adds alias/deselect/override. Persist accepted incumbents in the graph lock.

7. **Source identity Phase B.** Phase B solves by normalized source identity plus manifest name, not semver. Normalization must distinguish registry source, explicit git/local/skillkit/vercel source, requested ref, resolved commit/content hash, and trust provenance. Bare local-path fallback is forbidden inside package dependency manifests.

8. **Package manifest compatibility.** Install-affecting dependency/composition manifests must not masquerade as old v1 packages. Use `schemaVersion: 2` or a required feature/minimum-version field that causes older CLIs to fail rather than silently ignore dependency/composition fields.

9. **Composition pipeline.** Markdown composition expands from raw staged source into generated target artifacts. Fragment overrides/ejections apply before expansion when addressed to an exact graph node. Artifact overrides/ejections apply after expansion. Drift is checked against installed generated output, and drifted files block updates while reporting any blocked composed-from changes.

10. **Fragments.** `fragments` are a non-runtime artifact class: listable, selectable by dependency/composition, lockable, overrideable/ejectable by graph node, and excluded from install planning unless an adapter explicitly declares a fragments target. Adding `fragments` requires schema/version gating.

11. **Trust/frozen minimum.** Phase B must include first-install trust prompts for new transitive sources, integrity verification when declared, and a minimal `--frozen-lock` that performs no registry refresh or git fetch and fails on any lock/cache mismatch. Rich policy files and broad offline UX can continue in a later phase.

12. **Graph lock.** The graph lock is canonical JSON with sorted roots, nodes, edges, selections, owners, namespacing decisions, include edges, and source hashes. Volatile metadata such as generation time is outside the frozen comparison. Locks are keyed by target/profile fingerprint and linked from the target install manifest by digest.

13. **Install manifest.** Multi-owner entries include `installName`, `logicalSelector`, `graphNodeId`, `dependencyRole`, sorted `owners`, derived `refCount`, `composedFrom`, and `graphLockDigest`. For merged settings/MCP/TOML targets, ownership is tracked at semantic subentry granularity; otherwise transitive merge artifacts are blocked.

14. **Overrides/eject.** Versioned override/eject syntax is shorthand only. The canonical path/command uses exact graph node id or source digest. Package or package@version override paths are accepted only when they resolve to one installed graph node; ambiguity is fatal with exact suggested commands.

15. **Phase A.** Phase A can ship without package graph resolution only if it includes schema gating, target-specific rendering, idempotent Markdown expansion, composedFrom metadata, fragment override plumbing, and drift diagnostics. It should not encourage publishing v1 manifests that old CLIs will misinstall.

16. **Phase B.** Phase B scope is: package-level recursive requires; source-identity dedupe; target-group combined plans; v1 migration/adoption; multi-owner manifest; canonical graph lock; target apply lock/journal; minimal frozen-lock/integrity; ownership-aware remove; basic trust prompt; good diagnostics for incompatible duplicates. This is the true crux and should be treated as a larger phase.

17. **Phase E.** Move only rich trust policy, broad offline ergonomics, graph diff polish, and registry compatibility metadata to Phase E. Do not defer the minimal lock/frozen/cache guarantees needed for reproducible Phase B installs.
