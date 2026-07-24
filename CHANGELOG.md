# Changelog

## Unreleased

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
