# Hermes plugin rollout and source-routing canary

Session learning: a Hermes plugin can appear in `plugins.enabled` and still not be installed as a runtime plugin. Treat config enablement, source package existence, and runtime plugin installation as separate facts.

Use this checklist when validating an Agentwheel-delivered Hermes plugin, especially one meant to intercept skill/self-improvement writes:

1. Identify the owning source package or fleet profile. Do not treat `~/.hermes/plugins/` or `~/.hermes/skills/` as canonical source.
2. Dry-run from fleet-control or the approved workspace:
   - `agentwheel install <source-or-profile> --dry-run`
   - include `--execute-plugins` when plugin artifacts must actually materialize.
3. Verify runtime materialization on the gateway host, not only the shell host:
   - config mentions the plugin under `plugins.enabled`;
   - runtime directory exists: `$HERMES_HOME/plugins/<plugin-name>/`;
   - expected files exist, usually `plugin.yaml` and `__init__.py`;
   - latest Agentwheel install manifest has the plugin artifact entry.
4. Restart/reload the relevant Hermes gateway only after explicit approval when needed for plugin load.
5. Run a canary that exercises the middleware path. For self-improvement source routing, a managed runtime skill write should be blocked from direct runtime mutation and should create a pending/source-first proposal with clear logs.
6. If proposals are staged but not drained, inspect proposal JSON and reconciler logs. Do not report end-to-end success until the proposal reaches source or the blocker is named.

Common false-positive: `plugins.enabled: [plugin-name]` plus old log lines that mention the plugin only proves it was configured or previously loaded. It does not prove the current runtime directory exists or that the auto-delivery path is healthy.