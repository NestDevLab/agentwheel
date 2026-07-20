# Hermes background review vs AgentWheel-managed skills

Use when Hermes' automatic self-improvement review patches skills or the user asks to redirect those writes through AgentWheel.

## Facts

- Hermes' automatic self-improvement is core code, not a `self-improve` skill: `/usr/local/lib/hermes-agent/agent/background_review.py`.
- It runs a forked agent after eligible turns and can call only memory + skill tools.
- Skill writes arrive as normal `skill_manage` calls with write origin `background_review` (`tools.skill_provenance.is_background_review()`).
- The user-visible event is `💾 Self-improvement review: ...`, e.g. `Patched SKILL.md in skill 'agentwheel'`.
- Existing Hermes guards block background writes to pinned, bundled, hub-installed, or external-dir skills, but may not know AgentWheel runtime ownership.

## Immediate mitigation

Enable staged review before runtime mutation:

```bash
hermes config set skills.write_approval true
```

Then review with:

```text
/skills pending
/skills diff <id>
/skills approve <id>
/skills reject <id>
```

This prevents silent runtime patches, but the standard approval path still applies the pending write to the runtime skill unless another router handles it.

## Preferred router shape

Use a Hermes plugin or core patch at `tool_execution`/`skill_manage` level:

1. Intercept `tool_name == "skill_manage"`.
2. If `is_background_review()` is false, pass through.
3. For background `patch`/`edit`/`write_file`/`remove_file`/`delete`, resolve runtime skill path to AgentWheel provenance.
4. If AgentWheel-managed, do not call the original runtime write.
5. Stage or apply a source-package patch proposal in the OpenPack repo, then roll out with AgentWheel dry-run/install.
6. Return a clear JSON tool result so the review agent reports that the source-first proposal was created, not that runtime was patched.

Minimal plugin skeleton:

```python
def register(ctx):
    ctx.register_middleware("tool_execution", route_skill_manage)

def route_skill_manage(tool_name, args, next_call, **kw):
    if tool_name != "skill_manage":
        return next_call(args)
    from tools.skill_provenance import is_background_review
    if not is_background_review():
        return next_call(args)
    if args.get("action") not in {"patch", "edit", "write_file", "remove_file", "delete"}:
        return next_call(args)
    # Resolve AgentWheel provenance; if managed, create source patch/pending and return JSON.
    # Otherwise pass through or stage via skills.write_approval policy.
```

## Implemented plugin pattern

A working Hermes-only plugin implementation can live as an OpenPack package under fleet-control, e.g.:

```text
profiles/agentwheel-skill-router/
  openpack.json
  plugins/hermes/agentwheel-skill-router/plugin.yaml
  plugins/hermes/agentwheel-skill-router/__init__.py
```

Recommended behavior:

- register `tool_execution` middleware;
- intercept only `tool_name == "skill_manage"` with `tools.skill_provenance.is_background_review() == True`;
- restrict interception to write actions: `patch`, `edit`, `write_file`, `remove_file`, `delete`;
- resolve target skill ownership from AgentWheel `~/.agentwheel/hermes*.install-manifest.json` entries where `artifactType == "skills"`, `artifactName == <skill>`, `channel == "managed"`, and `path` matches `.hermes/skills/<skill>` for the active Hermes home;
- if managed, do **not** call `next_call(args)`; stage a proposal JSON under `$HERMES_HOME/pending/agentwheel-skill-router/` containing the original args and AgentWheel provenance;
- if unmanaged or foreground, pass through unchanged.

Validation pattern for this plugin class:

1. Syntax-check the plugin without creating `__pycache__` in managed runtime output: `compile(Path("__init__.py").read_text(), path, "exec")`.
2. Dry-run a scoped Hermes install with the custom Hermes+plugins adapter and `--execute-plugins`.
3. Apply scoped install only after the plan shows no drift/conflict outside the plugin.
4. In a fresh Hermes Python process, call `discover_plugins(force=True)`, set `set_current_write_origin("background_review")`, run `run_tool_execution_middleware("skill_manage", ...)`, and verify:
   - plugin is loaded;
   - `tool_execution` middleware count increases;
   - downstream `next_call` is **not** called for a managed skill;
   - target runtime skill hash is unchanged;
   - a proposal JSON is created;
   - foreground calls still invoke `next_call`.

Pitfall: a scoped `agentwheel install <source> --only-source` can rewrite the target graph-lock to contain only that source. For durable fleet registration, add the plugin package to the fleet `.agentwheel/config.json`, but avoid committing a narrowed graph-lock produced by one-source install unless that is intended.

## Durable rule

Background review should never be allowed to mutate AgentWheel-generated runtime skill files directly. It must either stage for human approval or route the proposed diff to the AgentWheel/OpenPack source and require a scoped dry-run before install.
