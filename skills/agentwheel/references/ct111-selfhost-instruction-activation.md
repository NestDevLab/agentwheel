# CT111 self-hosted instruction activation

Use when adding a small always-loaded behavior rule to YehonalBot/Drassil on CT111 without importing unrelated core-private skills.

Facts/pitfall:
- CT111 (`ct111-openclaw`) owns its own AgentWheel plane under `/root/src/nestdevlab/fleet-control/profiles/ct111-selfhost`; do not install to CT111 from CT107.
- OpenClaw instruction artifacts often target the same runtime file: `/root/.openclaw/workspace/AGENTS.md`.
- Adding a second selected `instructions/<rule>.md` artifact from `agent-core-toolkit-private` can create duplicate instruction targets with different content. AgentWheel may skip one duplicate or report drift on the managed block.

Preferred pattern:
1. Keep the broad source package selected narrowly; do not add all of `agent-core-toolkit-private` just to deliver one rule.
2. If the target already has a domain/persona `instructions/AGENTS.md` artifact, compose the new small behavior fragment into that existing artifact instead of adding a separate instruction artifact to the same destination.
3. Put the behavior text in the domain toolkit, e.g. `agent-drassil-toolkit-private/fragments/self-improve-activation.md`.
4. Add one compose include near the top of the domain `AGENTS.md` composition, usually immediately after `core:fragments/core-base.md` and before role overlays:
   ```json
   { "include": "fragments/self-improve-activation.md" }
   ```
5. Validate JSON/OpenPack selection, then run CT111 dry-run in place:
   ```bash
   ssh ct111-openclaw 'cd /root/src/nestdevlab/fleet-control/profiles/ct111-selfhost && npx --yes agentwheel@latest install --profile ct111-selfhost --dry-run --yes'
   ```
6. Treat `UPDATE instructions/AGENTS.md -> .openclaw/workspace/AGENTS.md` as the expected dry-run signal. Do not apply if unrelated drift/plugin operations are present unless the user approves that exact scope.

This pattern preserves narrow delivery: the future runtime receives the behavior inside its existing AGENTS managed block without importing unrelated core-private skills or creating competing instruction blocks.