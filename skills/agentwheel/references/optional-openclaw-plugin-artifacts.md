# Optional OpenClaw plugin artifacts in OpenPack packages

Use this when a package contains runtime-neutral skills/core plus OpenClaw-only plugin code. Do not force non-OpenClaw platforms to install the plugin; expose it as a selectable `plugins/<name>` artifact.

## Package layout

```text
openpack.json
agentwheel.json            # optional legacy alias
AGENTS.md
skills/<skill-name>/
plugins/openclaw-agent-mesh/
  package.json
  openclaw.plugin.json
  src/index.js
  README.md
```

## Manifest pattern

```json
{
  "schemaVersion": 2,
  "name": "NestDevLab/agent-mesh",
  "version": "0.9.0",
  "provides": [
    { "type": "instructions", "path": "AGENTS.md" },
    { "type": "skills", "path": "skills" },
    { "type": "plugins", "path": "plugins" }
  ]
}
```

If older AgentWheel installs still read `agentwheel.json`, keep it in sync with `openpack.json` until the fleet is fully migrated.

## Smoke commands

Validate the package:

```bash
agentwheel package validate /path/to/package
agentwheel scan /path/to/package --driver local
```

List artifacts:

```bash
agentwheel list /path/to/package --driver local
```

Dry-run only the OpenClaw plugin artifact:

```bash
agentwheel install /path/to/package \
  --driver local \
  --adapter openclaw \
  --target-root /tmp/agentwheel-openclaw-smoke \
  --select plugins/openclaw-agent-mesh \
  --dry-run \
  --only-source
```

Expected plan includes a `PLUGIN` action and semantic command. For fleet-managed OpenClaw plugins the command should be copy/materialized install, **not** symlink install:

```text
openclaw plugins install .../plugins/openclaw-agent-mesh
```

If a dry-run still shows `openclaw plugins install --link ...`, the OpenClaw plugin target is using the legacy symlink flow. Patch AgentWheel's OpenClaw plugin command generation before applying fleet installs; do not compensate by adding runtime symlinks.

## Pitfalls

- Run `agentwheel install` with an absolute source path for local package smoke tests. A bare `.` can be interpreted as a registry dependency inside some package-resolution paths.
- For plugin-root repositories, do not point `provides[{type:"plugins"}].path` at `"."`; AgentWheel will treat each top-level file/directory as a separate plugin artifact. Materialize the plugin under `plugins/<plugin-name>/` and set `{ "type": "plugins", "path": "plugins" }`.
- Keep plugin package dependencies relative to the canonical repo layout, e.g. `file:../../packages/core` from `plugins/openclaw-agent-mesh/package.json`.
- For OpenClaw-specific plugins, do not add them to every platform profile by default; select `plugins/<name>` only for OpenClaw targets.
