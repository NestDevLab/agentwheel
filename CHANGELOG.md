# Changelog

## Unreleased

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
