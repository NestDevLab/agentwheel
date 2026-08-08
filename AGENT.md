# Agentwheel For AI Agents

Agentwheel is the control plane for installing OpenPack resources into agent runtimes. Use it when a
user wants to discover, add, install, update, remove, or publish skills, instructions, rules,
commands, subagents, MCP, hooks, settings, plugins, or fragments.

## Operating Model

- `add` records desired packages in `.agentwheel/config.json`.
- `plan` previews what would change.
- `install` makes the declared state true.
- `update` refreshes tracking packages, then installs; a configured package name preserves other roots, while `update --dependency <name-or-source>` advances one tracking dependency and keeps unrelated graph nodes locked.
- `uninstall` removes managed runtime output and config entries.

Runtime output directories are generated. Do not hand-edit generated skills, runtime config, or
plugin directories to complete an Agentwheel change.

## Standard Flow

```bash
agentwheel add github:owner/agent-pack --adapter codex --installation-type local --mode tracking
agentwheel plan
agentwheel install
agentwheel status
```

To add and install in one step:

```bash
agentwheel install github:owner/agent-pack --adapter codex --local
```

Use explicit scope when the target matters:

```bash
agentwheel install github:owner/agent-pack --adapter claude --user
agentwheel install github:owner/agent-pack --adapter codex --local
agentwheel install github:owner/agent-pack --adapter openclaw --installation-type local
```

## Companion Skills

Install `agentwheel` for lifecycle guidance. Install the separate `agentwheel-discovery` module only
when the user wants proactive semantic suggestions and read-only skill trials:

```bash
agentwheel doctor --adapter codex --local
agentwheel install github:NestDevLab/agentwheel --adapter codex --local --skill agentwheel
agentwheel install github:NestDevLab/agentwheel --adapter codex --local --skill agentwheel-discovery
```

Selecting `agentwheel-discovery` automatically includes its always-loaded preflight instruction.

In Syncwheel-managed repositories, `doctor` can also check for the Syncwheel skill:

```bash
agentwheel doctor --adapter codex --local --skill syncwheel --source github:NestDevLab/syncwheel
agentwheel install github:NestDevLab/syncwheel --adapter codex --local --skill syncwheel
```

## Sources And Catalogue

Use direct sources when known:

```bash
agentwheel install github:owner/repo --adapter codex --local
agentwheel install skillkit:owner/skill-name --adapter claude --user
agentwheel install vercel:owner/skill-name --adapter codex --user
agentwheel install mcp-registry:publisher/server-name --adapter claude --local
agentwheel install clawhub:@openclaw/package-name --adapter openclaw --local
```

Use the catalogue for browsing and copy-ready commands:

```text
https://nestdevlab.github.io/agentwheel/catalogue.html
```

Draft a public catalogue submission without editing the registry by hand:

```bash
npx agentwheel@latest registry publish https://github.com/owner/repo
```

## Safety

- Prefer `agentwheel plan` or `agentwheel install --dry-run` before broad or fleet changes.
- Stop on drift or conflict unless the user explicitly approves the exact scope.
- Use `--adapter-module` only with `--allow-adapter-code` after the user approves local code execution.
- Use `--execute-plugins` only after the user approves plugin execution.
- Treat registry publishing, Git commits, pushes, and runtime restarts as separate side effects.

## Key References

- Install handoff: `install.md`
- Package spec: `docs/spec/openpack.md`
- Compatibility matrix: `docs/design/artifact-harness-compatibility.md`
- Fleet config: `docs/fleet-config.md`
- Catalogue: `docs/catalogue.html`
