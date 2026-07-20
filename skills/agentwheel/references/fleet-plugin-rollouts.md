# Fleet plugin rollouts with AgentWheel

Use this when a fleet-control repository manages plugin installation across multiple runtime harnesses.

## Pattern

1. Add the plugin package to `.agentwheel/config.json` as a normal package.
2. Select every runtime-specific artifact exposed by the OpenPack package, for example:
   - `plugins/extra-message-policy`
   - `plugins/hermes-extra-message-policy`
   - shared `rules/...`
   - runtime settings such as `settings/hermes-extra-message-policy.json`
3. Add a dedicated rollout profile instead of immediately folding it into `all`, for example:

```json
"extra-message-policy": {
  "runtimes": [
    { "agent": "ct110-openclaw" },
    {
      "agent": "ct110-hermes",
      "adapterConfig": "/absolute/path/to/fleet-control/adapters/hermes-with-plugins.jsonc"
    },
    { "agent": "ct110-tirrenia" }
  ]
}
```

4. Run a dry-run first:

```bash
npx --yes agentwheel@latest install --profile extra-message-policy --dry-run
```

5. Apply only after reviewing drift/conflict/plugin operations. For OpenClaw semantic plugin installs, include:

```bash
npx --yes agentwheel@latest install --profile extra-message-policy --execute-plugins
```

6. Verify the dry-run uses copy/materialized OpenClaw plugin commands, not symlinks:

```bash
agentwheel install --profile extra-message-policy --dry-run | tee /tmp/plugin-dry-run.txt
! grep -q -- '--link' /tmp/plugin-dry-run.txt
```

Fleet-managed OpenClaw plugins should plan `openclaw plugins install <staged-plugin-path>`. If the plan contains `openclaw plugins install --link ...`, stop and update AgentWheel/OpenClaw plugin command generation before applying.

## Profile scoping pitfall

AgentWheel profiles select runtimes, not packages. If a fleet-control repo's root `.agentwheel/config.json` contains many packages and you need a narrow plugin-only rollout, create a separate workspace/profile directory with its own `.agentwheel/config.json` containing only those plugin packages. Then run the dry-run from that profile workspace.

## Important pitfall: custom adapter config placement

For profile installs, `adapterConfig` must be on the profile runtime entry, not only on the named agent. The current workspace agent schema may not preserve `adapterConfig` under `agents.*`, while profile runtimes do support it.

Use an absolute adapter config path when the runtime is remote/SSH or when relative resolution might happen from the target root rather than the fleet repository.

## Hermes plugin artifacts

If the built-in Hermes adapter does not install plugin artifacts, keep a declarative adapter config in the fleet repo, e.g. `adapters/hermes-with-plugins.jsonc`, with a `plugins` target pointing at `.hermes/plugins`.

## Verification checklist

- `agentwheel list <source>` shows all expected runtime-specific artifacts.
- Direct Hermes dry-run with the custom adapter creates `.hermes/plugins/<plugin>`.
- Fleet profile dry-run creates the Hermes plugin, rule, and settings.
- OpenClaw profile dry-run shows `PLUGIN ... semantic plugin install planned`.
- Do not restart runtimes as part of the AgentWheel install unless the user explicitly asks.