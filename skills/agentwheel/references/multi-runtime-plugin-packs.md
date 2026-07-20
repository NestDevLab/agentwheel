# Multi-runtime plugin packs with AgentWheel

Use this when converting a runtime-specific plugin into one OpenPack package that targets multiple agent runtimes (for example OpenClaw + Hermes) while keeping runtime-specific adapters separate.

## Recommended shape

```text
openpack.json
plugins/
  openclaw/<plugin-name>/
  hermes/<plugin-name>/
settings/
  <runtime-settings>.json
rules/
  <shared-policy>.md
adapters/
  <runtime-with-extra-targets>.jsonc
```

Manifest pattern:

```json
{
  "schemaVersion": 2,
  "name": "Owner/agent-plugin-name",
  "version": "0.1.0",
  "provides": [
    { "type": "plugins", "path": "plugins/openclaw", "runtimes": ["openclaw"], "required": true },
    { "type": "plugins", "path": "plugins/hermes", "runtimes": ["hermes"], "required": true },
    { "type": "settings", "path": "settings/hermes.json", "runtimes": ["hermes"] },
    { "type": "rules", "path": "rules", "runtimes": ["openclaw", "hermes"] }
  ]
}
```

Keep the plugin directory names distinct across runtimes when both are exposed as `plugins/*` artifacts. Example: `plugins/openclaw/extra-message-policy` and `plugins/hermes/hermes-extra-message-policy`. This avoids ambiguous list/install output where two artifacts share `plugins/<same-name>` but target different runtimes.

## Hermes plugin target caveat

AgentWheel/OpenPack supports `type: "plugins"`, but some AgentWheel versions have a built-in Hermes adapter that does not expose a `plugins` target. In that case ship a declarative adapter config in the package, e.g. `adapters/hermes-with-plugins.jsonc`:

```jsonc
{
  "name": "hermes",
  "displayName": "Hermes + plugins",
  "targets": {
    "instructions": { "enabled": true, "dest": ".hermes/AGENTS.md" },
    "rules": { "enabled": true, "dest": ".hermes/rules" },
    "skills": { "enabled": true, "dest": ".hermes/skills" },
    "commands": { "enabled": true, "dest": ".hermes/commands" },
    "mcp": { "enabled": true, "dest": ".hermes/mcp", "merge": "json-deep" },
    "hooks": { "enabled": true, "dest": ".hermes/hooks", "merge": "json-deep" },
    "settings": { "enabled": true, "dest": ".hermes/settings.json", "merge": "json-deep" },
    "plugins": { "enabled": true, "dest": ".hermes/plugins" }
  }
}
```

Install/dry-run with:

```bash
agentwheel install /abs/path/to/pack --driver local \
  --adapter-config /abs/path/to/pack/adapters/hermes-with-plugins.jsonc \
  --target-root /abs/runtime/root --dry-run
```

Use absolute paths for local sources and adapter configs when `--target-root` differs from the package directory; relative paths are resolved from the target/workspace context and can fail.

## Validation flow

1. Build/test each runtime implementation directly.
2. `agentwheel list /abs/path/to/pack --driver local` and confirm runtime artifacts are named distinctly.
3. Dry-run each target runtime separately:
   - OpenClaw plugin dry-run: add `--execute-plugins` so semantic plugin operations are visible.
   - Hermes plugin dry-run: use the custom adapter config if needed.
4. Check for `drift` and `conflict` before applying. Do not force drift without explicit approval.
5. For plugin installs, remember that runtime restart/reload is a separate side effect.

## Pitfalls

- `python3 -m py_compile` inside a managed Hermes plugin directory creates `__pycache__`, which AgentWheel reports as drift. Prefer `compile(Path(...).read_text(), path, "exec")` for syntax checks, or delete `__pycache__` before status/dry-run.
- Comparing only package versions is insufficient when live runtime copies were hotfixed. Compare important file hashes or `diff -ru --exclude=node_modules` before overwriting existing plugin copies.
- GitHub publishing is separate from local package authoring. If `gh`/SSH auth is unavailable, leave a clean local commit and report that the repo was not pushed.
