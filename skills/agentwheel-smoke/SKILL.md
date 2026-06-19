---
name: agentwheel-smoke
description: Run a read-only smoke diagnostic for the current AI harness and its Agentwheel-managed installation state. Use when asked to smoke test an agent, verify fleet deployment, inspect whether a harness is installed in the expected Agentwheel path, or summarize local Agentwheel status without mutating files or external systems.
---

# Agentwheel Smoke

Use this skill to answer: "What harness am I running in, where was this skill installed, and what does Agentwheel think about this target?"

The default workflow is read-only. Do not run `agentwheel install`, `agentwheel update`, `agentwheel uninstall`, `agentwheel remember`, `agentwheel eject`, or any file-writing fix while using this skill unless the user separately approves that mutation scope.

## Quick Start

From the user's current workspace, run the bundled smoke script:

```bash
node path/to/agentwheel-smoke/scripts/smoke.mjs
```

Use JSON output only when another tool or script needs to consume the result:

```bash
node path/to/agentwheel-smoke/scripts/smoke.mjs --json
```

When the user names an Agentwheel target, pass only read-only status target flags:

```bash
node path/to/agentwheel-smoke/scripts/smoke.mjs --agent lab-codex
node path/to/agentwheel-smoke/scripts/smoke.mjs --profile daily
node path/to/agentwheel-smoke/scripts/smoke.mjs --all
```

## Report The Result

Summarize the script output in four parts:

- Overall: `PASS`, `WARN`, or `FAIL`.
- Harness: detected adapter, installation type, runtime root, and skill path.
- Agentwheel: CLI availability, version, config locations, packages, agents, profiles, and status result.
- Recommended next command: prefer `agentwheel status`, `agentwheel plan`, or `agentwheel install --dry-run`.

Treat these as important signals:

- `PASS`: skill path maps to a documented Agentwheel harness target and `agentwheel status` reports no pending work.
- `WARN`: the skill is running from package source, status is missing, config is absent, manifest is missing, or pending work is reported.
- `FAIL`: Agentwheel CLI is unavailable, the skill path maps to a known wrong target, `agentwheel status` exits unsuccessfully, or drift/conflict appears.

## Compatibility Checks

Use these documented skill targets when explaining path compatibility:

- Codex local: `.agents/skills/<name>/SKILL.md`; Codex user: `~/.agents/skills/<name>/SKILL.md`.
- Claude local: `.claude/skills/<name>/SKILL.md`; Claude user: `~/.claude/skills/<name>/SKILL.md`.
- Copilot local: `.github/skills/<name>/SKILL.md`; Copilot user: `~/.copilot/skills/<name>/SKILL.md`.
- OpenClaw local: `skills/<name>/SKILL.md`; OpenClaw user: `~/.openclaw/skills/<name>/SKILL.md`.
- Hermes user: `~/.hermes/skills/<name>/SKILL.md`; local Hermes skills are unsupported by default.

Flag `.codex/skills/<name>/SKILL.md` as incompatible for Agentwheel-managed Codex skills.

## Safety

This skill is diagnostic. It may inspect files and run read-only Agentwheel commands, but it must not mutate runtime outputs, package source, Google Workspace data, Git state, registry state, or deployment state.
