# Hermes self-improve vs AgentWheel-managed skills

Use this reference when diagnosing why Hermes skill edits and AgentWheel installs conflict.

## Pattern

Hermes `skill_manage`/`self-improve` edits the installed runtime skill under `~/.hermes/skills/...`. AgentWheel treats runtime skill directories as generated output and tracks ownership/hash in `.agentwheel/*.install-manifest.json` plus graph locks. If a generated runtime skill is patched directly, the source package remains unchanged and later AgentWheel runs can report `drift` or `destination exists but is not managed`.

## Diagnostic checks

- Compare runtime skill path with package source, e.g. `~/.hermes/skills/<name>/SKILL.md` vs the OpenPack source `skills/<name>/SKILL.md`.
- Inspect AgentWheel dry-run output before applying: `agentwheel plan|install ... --dry-run`.
- Look for plan lines such as:
  - `DRIFT ... managed destination changed outside agentwheel`
  - `CONFLICT ... destination exists but is not managed`
  - `SKIP ... force adopting unmanaged destination with matching hash`
- Check whether a scoped install is using the same target, installation type, adapter config, and state key/fingerprint as the manifest that originally managed the file.

## Safe remediation shape

1. Treat `~/.hermes/skills`, `.agents/skills`, `.claude/skills`, `.openclaw/skills`, etc. as generated if AgentWheel owns them.
2. Move the durable edit into the OpenPack/source repo that provides the skill.
3. If the runtime content already matches desired source content but the manifest no longer owns it, use a scoped dry-run with `--force-conflict` to confirm it only adopts matching content; apply only after approval.
4. If runtime content differs from source, do not use `--replace-conflict` casually. First port the desired diff to source, then roll out.
5. Prefer narrow commands with `--only-source --select skills/<name>` for one-skill rollouts into populated Hermes profiles.
