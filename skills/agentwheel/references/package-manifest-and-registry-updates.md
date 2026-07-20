# Package manifest and registry update workflow

Use this when converting an AgentWheel-installable repo to OpenPack, adding optional plugin artifacts, or updating catalogue metadata.

## Manifest rule

- `openpack.json` / `openpack.jsonc` is the canonical package manifest.
- `agentwheel.json` is legacy. Do not add or keep it unless a specific old AgentWheel runtime requires it.
- After removing legacy manifest files, verify with:

```bash
agentwheel scan . --driver local
agentwheel package validate .
```

If testing a local source from inside the package directory, pass the absolute path rather than bare `.` when dependency resolution treats `.` as a registry name:

```bash
agentwheel install /absolute/path/to/pkg \
  --driver local \
  --adapter openclaw \
  --target-root /tmp/agentwheel-smoke \
  --select plugins/<name> \
  --dry-run \
  --only-source
```

Expected optional OpenClaw plugin signal:

```text
PLUGIN   MANAGED  plugins/<name> ... (semantic plugin install planned) :: openclaw plugins install --link ...
```

## Optional plugin packaging

For packages that provide runtime-neutral skills/rules plus platform-specific plugins:

```jsonc
{
  "schemaVersion": 2,
  "name": "Owner/package",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "AGENTS.md" },
    { "type": "skills", "path": "skills" },
    { "type": "plugins", "path": "plugins" }
  ]
}
```

Install platform-specific plugins explicitly with `--select plugins/<plugin-name>` so non-target runtimes do not receive optional integrations.

## README update checklist

When changing package shape, update the README in the same PR:

- State that OpenPack (`openpack.json`) is canonical.
- Remove references to deprecated `agentwheel sync`; use `agentwheel install --dry-run` and `agentwheel install`.
- Show runtime-neutral install flow.
- Show optional plugin install flow with `--select plugins/<name>`.
- Mention that generated runtime files are not committed.

## Registry/catalogue update pattern

AgentWheel registry source of truth is usually `index.json`.

- Update `index.json` entry description/tags for the package.
- Do not commit generated catalogue files (`catalogue-data.json`, `catalogue-vercel-index.json`) unless the repo specifically requires it for that PR.
- If there is a workflow that regenerates catalogue data on `main` after `index.json` or `catalogue/**` changes, leave generated data to that workflow. This avoids noisy diffs from volatile GitHub stars, timestamps, and sitemap refreshes.
- Verify JSON only:

```bash
python3 -m json.tool index.json >/tmp/index-check.json
```

Then open a small registry PR that references the package PR.
