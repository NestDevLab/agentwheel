# Install Agentwheel

Use this file when a user gives an AI agent a markdown install prompt and asks it to install or
bootstrap Agentwheel.

Agentwheel installs OpenPack resources into AI agent runtimes: skills, instructions, rules,
commands, subagents, MCP, hooks, settings, plugins, and fragments.

## What To Do

1. Inspect the environment.
2. Install the `agentwheel` CLI if it is missing or too old.
3. Verify the CLI.
4. Install the Agentwheel management skill into the user's active runtime when requested.
5. Offer the separate proactive discovery skill when the user wants automatic capability suggestions.
6. Show the user how to browse or install catalogue resources.

If the user explicitly asked you to install Agentwheel, you may run the installation commands below.
Ask before destructive operations, `--force`, remote publishing, local adapter code execution, or
plugin execution with `--execute-plugins`.

## Install The CLI

Check whether Agentwheel is already available:

```bash
agentwheel --version
agentwheel --help
```

If it is missing or older than the config requires, install the current CLI with the package
manager already available on the host:

```bash
npm i -g agentwheel@latest
```

Prefer pnpm only when the host already uses pnpm for global tools:

```bash
pnpm add -g agentwheel@latest
```

Verify after installation:

```bash
agentwheel --version
agentwheel doctor --help
```

Named fleets require a CLI that supports schema v3 or newer. Upgrade Agentwheel first, verify
`agentwheel --version` and `agentwheel fleet --help`, then create, register, inspect, or plan fleet
state. Do not rewrite the config to an older schema or remove named-fleet data to make an old CLI
accept it.

## Install The Companion Skills

Pick the adapter that matches the active runtime:

- `codex` for Codex CLI
- `claude` for Claude Code
- `openclaw` for OpenClaw
- `copilot` for GitHub Copilot CLI
- `hermes` for Hermes

For a project-local Codex setup:

```bash
agentwheel doctor --adapter codex --local
agentwheel install github:NestDevLab/agentwheel --adapter codex --local --skill agentwheel
```

For a user-level Claude setup:

```bash
agentwheel doctor --adapter claude --user
agentwheel install github:NestDevLab/agentwheel --adapter claude --user --skill agentwheel
```

The `agentwheel` skill is not proactive. If the user wants the agent to notice capability gaps,
suggest up to three semantic matches, and offer read-only trials, preview and install the separate
discovery skill:

```bash
agentwheel install github:NestDevLab/agentwheel --adapter claude --user --skill agentwheel-discovery --dry-run
agentwheel install github:NestDevLab/agentwheel --adapter claude --user --skill agentwheel-discovery
```

If the user wants to preview first, add `--dry-run` to the `install` command.

## Use The Catalogue

Browse the public catalogue:

```text
https://www.nestdev.it/agentwheel/catalogue.html
```

Install an OpenPack package:

```bash
agentwheel install github:owner/agent-pack --adapter codex --local
```

Install an MCP Registry server when Agentwheel reports it as installable:

```bash
agentwheel install mcp-registry:publisher/server-name --adapter claude --local
```

Install a ClawHub plugin into OpenClaw only when the user approves plugin execution:

```bash
agentwheel install clawhub:@openclaw/package-name --adapter openclaw --local --execute-plugins
```

If a fleet profile declares runtime `reloadCommands`, run reloads or service restarts only when
explicitly approved:

```bash
agentwheel install --fleet example-fleet --profile extra-message-policy --execute-plugins --reload-runtimes
```

Draft a catalogue submission for a public repository:

```bash
npx agentwheel@latest registry publish https://github.com/owner/repo
```

## Success Criteria

- `agentwheel --version` works.
- `agentwheel doctor` runs for the selected adapter.
- The management skill is installed if the user requested it.
- The discovery skill is installed only if the user requested proactive suggestions.
- Any catalogue resource install uses the adapter and installation type the user intended.
- Desired-state scope is explicit when it matters: `--user`, `--local`, or `--fleet <fleet-id>`.
- Catalogue submissions use `agentwheel registry publish` unless the user explicitly wants a manual registry PR.
