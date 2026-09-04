# Changelog

## 0.20.6

- Refresh a soft locked tracking dependency when a root selects artifacts outside the locked selection.

## 0.20.5

- Keep user-level GitHub auth profiles from treating local Git paths as remote URLs.

## 0.20.4

- Preserve an explicitly configured named Fleet selector when a composite profile invokes a member
  Agentwheel CLI for status, plan, install, or update.

## 0.20.3

- Allow the digest-gated stale-ownership lifecycle to abandon incomplete legacy merge metadata
  only through an explicit operator opt-in; the complete runtime file hash is leased under the
  shared lock and runtime bytes remain untouched.

## 0.20.2

- Add a digest-gated `ownership retire-stale` lifecycle that removes only exact stale source
  manifest entries already covered by a verified Fleet manifest, without rewriting runtime bytes.

## 0.20.1

- Qualify nested workspace ownership through its single containing registered Fleet and reject
  ambiguous overlapping Fleet registrations.
- Repair exact incomplete merge ownership metadata automatically without rewriting runtime files.
- Let verified disjoint MCP contributions coexist across workspace manifests while continuing to
  block overlapping or stale foreign ownership until an explicit Fleet normalization.
- Serialize all state keys sharing one adapter/runtime apply destination and revalidate exact merge
  contributions and skip hashes under that shared lock before persisting ownership metadata.
- Lease the complete runtime manifest inventory and block every state key while any compatible
  apply journal is pending, preventing cross-state plans and crash recovery from racing.

## 0.20.0

- Added schema-v4 governed mutation policies with required reasons, durable sanitized receipts,
  exact declared-path revisioning, audited no-commit overrides, and idempotent finalize/recovery.
- Added strict revision-provider protocol v1 adapters for built-in Git and external JSON commands,
  including canonical shared fixtures and explicit owned-but-unpublished records that distinguish
  projected draft tips from integration control commits.
- External providers now execute from an unlinked private snapshot of the verified entrypoint bytes,
  with an explicit dependency-closure trust boundary and a timeout that kills the complete provider
  process group.
- Linked runtime apply journals to revisioned and journal-only governed operations, added receipt
  revision/digest compare-and-swap checks, and added verified local crash recovery without rerunning
  completed runtime writes.
- Made commit-after-verify fail closed for unsupported multi-repository and composite mutations,
  concurrent state changes, failed postchecks, hook rejection, and provider protocol mismatch.

## 0.19.10

- Canonicalize composition identities by resolved node, fragment selector, and expanded content so
  local and aliased references to the same fragment deduplicate without collapsing distinct sources.

## 0.19.9

- Deduplicate an injected composition rule against an identical earlier item-level compose entry,
  while preserving intentional repetitions declared within the item itself.

## 0.19.8

- Deduplicate identical resolved composition-rule includes across selected OpenPack roots while
  preserving explicit item-level repetition and distinct marked versus plain rendering modes.

## 0.19.7

- Safely retire exact legacy managed instruction blocks whose manifests predate persisted
  `managed-block` mode, while preserving all surrounding user and persona content.

## 0.19.6

- Resolve Git sources without mutating shared cache checkouts, materialize immutable snapshots from
  Git trees, and reject cache mutation when the invoking UID does not own the cache root.

## 0.19.5

- Allow `--force-conflict` to adopt exact pre-existing settings, hooks, YAML, and OpenClaw JSON merge contributions while preserving strict MCP equality checks.

## 0.19.4

- Add focused `update --artifact type/name` delivery so one non-skill artifact can move without removing or refreshing sibling package state.

## 0.19.3

- Honor the explicit `--force-foreign-state` escape hatch for named Fleet plans while retaining the default normalization-first guard.

## 0.19.2

- Allow exact MCP retirement to inspect its explicitly selected legacy state while preserving exact owner, revision, hash, and runtime-content preconditions.

## 0.19.1

- Allow exact MCP retirement to remove multiple fully verified servers from one artifact while
  continuing to reject non-MCP root configuration.

## 0.19.0

- Added OpenPack schema v3 composition rules for deterministic wildcard fragment injection into
  skills, plus explicit `supersedes` resolution for source-aware derivative collisions.

## 0.18.5

- Fixed ownership-normalization journaling to replay the exact graph-verified manifest paths
  from the reviewed plan, including transitive artifacts whose manifest owner is a graph node
  rather than a root package name.

## 0.18.4

- Added fail-closed recovery for verified Agentwheel ownership stranded by a deleted workspace,
  scoped to one local fleet agent and preserving unrelated legacy manifest entries.

## 0.18.3

- Fixed same-fleet normalization to ignore a stale named-target graph lock only when no legacy
  manifest entry is covered by it; a manifest-covered absent root remains a fail-closed error.

## 0.18.2

- Fixed legacy same-fleet normalization so it considers only locally provable manifest/graph-lock
  pairs, preserves unrelated composite or stale lock state byte-for-byte, and still rejects
  relevant foreign ownership before any handoff.

## 0.18.1

- Fixed focused skill updates so dependency-only sibling graph nodes and include edges remain
  locked, while stale include edges owned only by the updated skill are replaced.

## 0.18.0

- Added optional named fleets and explicit `--user`, `--local`, and `--fleet <fleet-id>`
  desired-state selection without merging scopes or assigning any fleet global priority.
- Added a foreign-state guard that blocks implicit ownership changes across user, local, and
  fleet manifests, including overlaps whose rendered bytes already match.
- Added plan-digested fleet normalization with ordered locks, durable journal recovery, stale-plan
  revalidation, and source-first ownership transfer before declarations are removed.
- Fixed named-agent uninstall so manifest and runtime resolution use the target's effective adapter
  configuration instead of the invoking workspace's defaults.

## 0.17.0

- Added `agentwheel cache prune` to preview old Git source snapshots, with `--apply` to
  remove them while retaining locked commits and `--keep` to retain the newest snapshots
  per source.
- Added `agentwheel mcp retire`, a dedicated workflow for removing one exact legacy MCP
  contribution. It revalidates JSON and Codex MCP content and manifest ownership before
  removal, and keeps dry-run and apply as separate boundaries. Named Fleet targets now
  carry explicit install-state keys.
- Added `agentwheel skill update <name>` to resolve a configured skill's owning package
  and reconcile only its closure. Fixed `--only-source` for configured packages while
  preserving unrelated graph-lock state.
- Added the `agentwheel-artifact-evolution` skill: a source-aware workflow for evolving
  reusable agent artifacts, with catalogue metadata and validation coverage.
- Fixed locked graph resolution so changing a root package source also refreshes its
  tracking dependency closure instead of combining incompatible lock generations.
- Fixed explicit-source install and plan preflight for artifacts composed from
  cross-package fragments by deferring rendering to the resolved dependency graph.
- Fixed SkillKit cache ref isolation: configured refs now materialize into immutable,
  ref-specific cache paths, named refs are passed to SkillKit, commit refs are checked
  out explicitly, and an atomic filesystem lock with temporary candidate directories
  stops concurrent processes from replacing an existing cache.
- Fixed exact adoption of pre-existing MCP merge contributions under `--force-conflict`,
  recording complete removal ownership while preserving prior ownership across refreshes,
  and failing closed for non-exact JSON and Codex TOML server blocks and for empty legacy
  removal records.
- Fixed OpenPack skill collections so a colocated `README.md` stays package documentation
  instead of becoming a skill. Skills-only manifests now scan cleanly without requiring an
  unrelated instructions artifact.

## 0.16.6

- Made optional proactive discovery deterministic for repeated manual workflows: it now runs before
  generic brainstorming or workflow advice, and generic advisory skills no longer suppress a
  semantic search for an operational capability.

## 0.16.5

- Split proactive capability recommendations into the optional `agentwheel-discovery` skill, while
  keeping explicit search and artifact management in the `agentwheel` skill.
- Released verified semantic catalogue search and read-only skill trials through the CLI and the
  dedicated discovery workflow.

## 0.16.4

- Broadened the companion skill's automatic discovery trigger to cover missing capabilities, repeated manual workflows, and unavailable integrations, including delegated-agent work, while preserving bounded non-mutating suggestions.

## 0.16.3

- Added user-local GitHub authentication profiles for private Git sources without putting personal accounts or tokens in OpenPack manifests.

## 0.16.2

- Fixed OpenClaw installs so Agentwheel reconciles lifecycle router repositories by name, replacing stale entries and removing duplicates while preserving unrelated repositories.

## 0.16.1

- Fixed machine-readable install output so `agentwheel install --json` and `--format json` apply the planned changes unless `--dry-run` is set. The report now includes whether changes were applied, while stdout remains valid JSON.

## 0.16.0

- Added one unified `agentwheel search` command across configured registries and the complete enriched/Vercel catalogue, with deterministic ranking, cache/offline support, filters, and versioned JSON output for semantic agent reranking; removed the pre-stable `registry search` command.

## 0.15.0

- Added npm-style root package version policies with cached latest-allowed and latest-overall discovery while preserving pinned versus tracking update semantics.
- Added versioned `status --json` reports for installed, locked, latest allowed, latest overall, drift, conflict, and pending work.
- Added composite workspace profiles whose local or SSH `members` remain autonomous Agentwheel workspaces while participating in existing status, plan, install, and update flows.
- Added member status TTL/refresh/offline behavior, protocol compatibility checks, cycle guards, two-phase preflight, revision revalidation, and deterministic fail-fast apply ordering.

## 0.14.13

- Added plan observability, JSON/report renderers, a local dashboard, semantic plugin execution, and explicitly gated runtime reload commands.
- Added reusable catalogue synchronization and validation contracts, and clarified external catalogue source handling.
- Preserved unrelated graph-lock metadata during scoped updates and added exact dependency update targeting.
- Fixed merge-target uninstall so it removes only the managed JSON, YAML, or TOML contribution and preserves pre-existing runtime configuration files. Legacy manifests without merge ownership metadata now preserve the destination rather than deleting it.
- Fixed recursive cross-package composition so dependency fragments remain raw until a parent artifact consumes them, and made named package updates preserve operations owned by other configured roots.
- Added `agentwheel update --dependency <name-or-source>` to advance one locked tracking dependency and its required tracking closure without moving unrelated graph nodes.
- Added automated, validated release tagging for version bumps merged to `main`. This release includes the unpublished 0.14.10 through 0.14.12 changes.

## 0.14.5

- Expanded the README and landing page to explain that the Agentwheel companion skill is optional but strongly recommended for the best Agentwheel experience.

## 0.14.4

- Added `agentwheel doctor` to detect the Agentwheel companion skill for a selected runtime and suggest explicit dry-run/install commands without writing runtime files by default.

## 0.14.3

- Fixed ssh install targeting: home-rooted installation types (for example `user`) over ssh now resolve their install/state root to the remote agent `root` instead of the orchestrator's local home, so the apply-lock and managed files land under the remote user's home. Previously an ssh agent whose remote user differed from the local user failed with a `.agentwheel` apply-lock `Permission denied`.

## 0.14.2

- Fixed `agentwheel-smoke` pending-work detection so `Pending install work: none` is parsed as clean output.

## 0.14.1

- Fixed `agentwheel-smoke` so fleet-target status with `Pending install work: none` does not produce false warnings, and manifest discovery follows the detected runtime root instead of the workspace `.agentwheel` directory.

## 0.14.0

- Added profile-aware `status` and `update` targeting, so `agentwheel status --profile <name>` and `agentwheel update --profile <name>` use the same profile runtime resolution, adapter config, and graph lock fingerprinting as `install --profile`; `status --all` and `update --all` now use the `all` profile when one exists.
- Fixed `status` pending-work reporting so foreign managed artifacts that are intentionally kept (`KEEP`) are not reported as pending install work.
- Added explicit install/update reconciliation force flags: `--force-drift` replaces drifted managed artifacts, `--force-conflict` adopts unmanaged destinations that already match the desired artifact, and `--replace-conflict` replaces unmanaged destinations that differ.
- Added `--user`, `--local`, `-i`, and `-t` shortcuts for install scope and target selection.
- Explicit source installs with explicit adapters now default to user-level targets when no target root is provided.
- `--target-root ~` infers `user`; other explicit target roots infer `local` unless overridden.

## 0.13.0

- Added comma-separated multi-adapter targeting, for example `--adapter codex,claude`, for install/plan-style runtime commands.
- When installing a new source into multiple adapters, Agentwheel now saves one package entry per adapter to avoid collapsing runtime state.
- Updated the landing quickstart to use the real multi-adapter command and explain the must-have OpenPack.

## 0.12.0

- Added explicit `installationType` support across CLI commands, workspace config, runtime targets, install plans, manifests, locks, and graph state.
- Rebuilt built-in harness artifact mappings around documented native locations, including Codex `.agents/skills`, Claude `.mcp.json`, Copilot `.github/*`, OpenClaw native `skills/`, and Hermes user skills.
- Added artifact/harness compatibility documentation with supported, alternative, unsupported, and requires-config statuses plus rule-semantics notes.
- Partitioned install state by adapter, installation type, and target fingerprint so user/local and fleet targets do not collide.
- Added compatibility smoke fixtures, negative mapping tests, and a manual Codex local skill discovery smoke script.
- Added a site version sync script so GitHub Pages static HTML no longer drifts from `package.json`.

## 0.11.0

- Added explicit workspace source overrides so a selected package can replace a colliding artifact from another source without relying on package order.
- `agentwheel add`, `plan <source>`, and `install <source>` accept repeatable `--override <source-or-package::type/name>` declarations for source override setup.
- Graph locks, `plan`, `deps tree`, and `deps why` now report artifact override decisions.
- Documented fleet fork override workflows for cases such as using a local forked skill over an upstream meta-pack dependency.

## 0.10.0

- Added `install --all-detected` to reconcile every detected runtime under a target root.
- Install manifests now record workspace ownership and reconcile only artifacts owned by the invoking workspace, preserving foreign managed state.
- Legacy unowned manifest entries are adopted when path and content match, including source identity drift such as renamed or differently-cased cached sources.
- Adapter parity: subagents for OpenClaw and Hermes, skills for GitHub Copilot (.github/skills).
- GitHub Copilot adapter supports custom agents in `.github/agents` and workspace MCP config in `.vscode/mcp.json`.

## 0.9.0

- Breaking: public reconcile command is now `agentwheel install`.
- `agentwheel install <name-or-source>` has ensure semantics: configured packages are reconciled by scope; new sources are added to config and installed.
- `agentwheel update [name]` re-resolves tracking packages and applies the result; pinned packages stay on the locked graph.
- The legacy command remains as a hidden one-release shim with a deprecation warning and will be removed in 0.10.
- Added `agentwheel status`.
- Added `agentwheel uninstall <name> --keep-files`.
- Fixed `--no-deps` so it actually suppresses transitive dependency resolution.
- OpenPack v2 manifests may omit `provides` when they declare `requires` — enables meta-packages ("packs") that only aggregate other packages.
