# Install Agentwheel

Use this file when a user gives an AI agent a markdown install prompt and asks it to install or
bootstrap Agentwheel.

Agentwheel installs OpenPack resources into AI agent runtimes: skills, instructions, rules,
commands, subagents, MCP, hooks, settings, plugins, and fragments.

## What To Do

1. Inspect the environment.
2. Install the `agentwheel` CLI if it is missing or too old.
3. Verify the CLI.
4. Install the Agentwheel companion skill into the user's active runtime when requested.
5. Show the user how to browse or install catalogue resources.

If the user explicitly asked you to install Agentwheel, you may run the installation commands below.
Ask before destructive operations, `--force`, remote publishing, local adapter code execution, or
plugin execution with `--execute-plugins`.

## Install The CLI

Check whether Agentwheel is already available:

```bash
agentwheel --version
agentwheel --help
```

If it is missing, install it with the package manager already available on the host:

```bash
npm i -g agentwheel
```

Prefer pnpm only when the host already uses pnpm for global tools:

```bash
pnpm add -g agentwheel
```

Verify after installation:

```bash
agentwheel --version
agentwheel doctor --help
```

## Install The Companion Skill

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

If the user wants to preview first, add `--dry-run` to the `install` command.

## Use The Catalogue

Browse the public catalogue:

```text
https://nestdevlab.github.io/agentwheel/catalogue.html
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

Draft a catalogue submission for a public repository:

```bash
npx agentwheel@latest registry publish https://github.com/owner/repo
```

## Success Criteria

- `agentwheel --version` works.
- `agentwheel doctor` runs for the selected adapter.
- The companion skill is installed if the user requested it.
- Any catalogue resource install uses the adapter and installation type the user intended.
- Catalogue submissions use `agentwheel registry publish` unless the user explicitly wants a manual registry PR.
