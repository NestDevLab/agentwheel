# Changelog

## Unreleased

- Adapter parity: subagents for OpenClaw and Hermes, skills for GitHub Copilot (.github/skills).
- GitHub Copilot adapter supports custom agents in `.github/agents` and workspace MCP config in `.vscode/mcp.json`.

## 0.9.0

- Breaking: public reconcile command is now `agentwheel install`.
- `agentwheel install <name-or-source>` has ensure semantics: configured packages are reconciled by scope; new sources are added to config and installed.
- `agentwheel update [name]` re-resolves tracking packages and applies the result; pinned packages stay on the locked graph.
- `agentwheel sync` remains as a hidden one-release shim with a deprecation warning and will be removed in 0.10.
- Added `agentwheel status`.
- Added `agentwheel uninstall <name> --keep-files`.
- Fixed `--no-deps` so it actually suppresses transitive dependency resolution.
- OpenPack v2 manifests may omit `provides` when they declare `requires` — enables meta-packages ("packs") that only aggregate other packages.
