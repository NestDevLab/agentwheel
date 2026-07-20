# Hermes profile-scoped skill rollout

Use when adding one new shared toolkit skill to Hermes default/Karan plus a Hermes profile such as `odino` without reconciling the whole generated skill tree.

## Pattern

1. Put the skill in the class-level toolkit source, e.g. `agent-core-toolkit-private/skills/<skill>/SKILL.md`.
2. In that toolkit `openpack.json`, restrict the skill item to Hermes if it must not install to OpenClaw/Codex/Claude:
   ```json
   {
     "type": "skills",
     "path": "skills",
     "items": {
       "<skill>": { "runtimes": ["hermes"] }
     }
   }
   ```
3. Add `skills/<skill>` to the relevant fleet selector.
4. Dry-run with a scoped source install so AgentWheel does not try to adopt/reconcile every existing runtime skill:
   ```bash
   AGENTWHEEL_NO_UPDATE_CHECK=1 npx --yes agentwheel install \
     /path/to/toolkit --driver local \
     --agent ct110-hermes \
     --select skills/<skill> \
     --only-source --dry-run
   ```
5. For a Hermes profile target such as Odino, pass the custom profile adapter config explicitly; otherwise the built-in Hermes adapter may reject `profile-odino` for skills as unsupported:
   ```bash
   AGENTWHEEL_NO_UPDATE_CHECK=1 npx --yes agentwheel install \
     /path/to/toolkit --driver local \
     --agent ct110-hermes-odino \
     --adapter-config adapters/hermes-odino.jsonc \
     --select skills/<skill> \
     --only-source --dry-run
   ```
6. Apply the same commands without `--dry-run` after the plan shows only the intended `CREATE`/`UPDATE` and `conflict 0`.
7. Verify on the remote host by checking both paths and hashes, then optionally `hermes skills list` and `hermes --profile odino skills list`.

## Pitfalls

- A broad `agentwheel install --agent ct110-hermes` can surface many unrelated conflicts for existing unmanaged skills. Use scoped source install for one-skill rollouts.
- `--agent ct110-hermes-odino` may not automatically apply the profile adapter config in all CLI shapes; pass `--adapter-config adapters/hermes-odino.jsonc` explicitly for profile skill installs.
- Keep source ownership and deploy ownership separate: toolkit repo owns the skill; fleet-control owns selectors/locks/deploy docs.
