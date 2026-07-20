# Fleet control cleanup: CT107 node vs runtime targets, and effective adapters

Use this reference when cleaning or explaining an AgentWheel fleet-control `.agentwheel/config.json` that targets multiple runtimes/profiles.

## Durable lessons

- Do not model CT107/nestdev as `ct107-openclaw` unless there is an explicitly declared, full OpenClaw runtime home to manage. In Joseph's current CT107/CT110 layout, CT107 is a local node/workspace with Claude/Codex homes; OpenClaw gateway/profile targets live on CT110 or profile-specific users.
- If a target name implies a real runtime install that does not exist, remove it from `agents` and from every `profiles.*.runtimes[]` entry rather than leaving it as a misleading alias.
- For profile installs, AgentWheel chooses the effective adapter from each runtime target in the selected profile. The package entry's `adapter` field can be source/default metadata and is not a reliable answer to “which adapters are targeted by this pack under profile all”.
- When the user asks “per pack, which adapters are targeted?”, compute it as: selected profile runtimes → each runtime's adapter or adapterConfig name → package roots fanned out to that set. Then separately note artifact-type limitations, especially plugin targets.

## Safe cleanup shape

1. Read `.agentwheel/config.json` and list:
   - `agents` entries,
   - each profile's runtime list,
   - any `adapterConfig` paths.
2. Identify misleading/nonexistent runtime targets by user/domain knowledge first. Ask or preserve if unsure; do not rename targets silently.
3. Remove the bad agent entry and all profile runtime references to it.
4. Remove only generated lock directories for the removed target, e.g. `.agentwheel/locks/<removed-agent>/`; do not bulk-delete unrelated locks.
5. Update `docs/fleet.md` with:
   - canonical meaning of the fleet,
   - current agents table,
   - profile membership,
   - effective adapter-targeting table per profile and per package.
6. Validate with JSON parsing and a grep that the removed target no longer appears in config/docs.
7. Run `agentwheel install --profile <profile> --dry-run` when credentials/cache allow. If a private GitHub fetch blocks dry-run, report it as a credential/cache blocker, not as proof the config is bad.

## Reporting style for Joseph

Keep it short and operational:

- what was removed/changed,
- exact files touched,
- current profile membership,
- validation result,
- any dry-run blocker.

Avoid over-explaining AgentWheel internals unless he asks; he wants the concrete fleet shape and whether it is clean.