# agentwheel Bootstrap Skill Design

Proposed skill name: `agentwheel`.

Reason: agents and users naturally ask for "agentwheel" when they need to install or manage skills. `agentwheel-skills` is accurate but narrower than the actual reference, which covers skills plus rules, instructions, commands, subagents, MCP, hooks, settings, plugins, adapters, registry discovery, sync/update, drift, eject, and uninstall.

## A. Auto-Install Mechanism

Use a bundled local package entry created by `agentwheel init`.

The skill should live in this repo at:

```text
skills/agentwheel/SKILL.md
```

The package should expose it through the repository/package manifest:

```json
{
  "schemaVersion": 2,
  "name": "NestDevLab/agentwheel",
  "version": "0.7.0",
  "provides": [
    { "type": "skills", "path": "skills", "required": true }
  ]
}
```

Minimal wiring:

- `package.json`: include `"skills"` and `"openpack.json"` in `files` so the npm package ships the bundled skill and manifest.
- `openpack.json`: add the manifest above at the package root, or merge the `provides` entry into a future root manifest if one exists by then.
- `src/cli/index.ts`: in the `init` workspace branch, write a default package entry when creating/updating `.agentwheel/config.json`.
- Recommended helper in `src/cli/index.ts`: `defaultBootstrapPackage(root)` or similar, using the installed package root as a local source.

Config entry shape:

```json
{
  "name": "agentwheel",
  "source": "<absolute path to installed agentwheel package root>",
  "driver": "local",
  "adapter": "openclaw",
  "mode": "tracking",
  "select": ["skills/agentwheel"]
}
```

The adapter in a package entry is only the default used when `agentwheel sync` is run from a generic workspace target. When the current directory auto-detects a runtime, or when `--agent`, `--all`, `--profile`, or `--adapter` is used, existing target resolution can still select the actual runtime adapter.

Why this is the cleanest fit:

- It uses the existing configured-package path: `agentwheel init` writes config, then `agentwheel sync --dry-run` and `agentwheel sync` install configured packages.
- It keeps the bootstrap skill visible in `.agentwheel/config.json` instead of hiding it in every adapter.
- It avoids a postinstall side effect. Installing the npm package should not mutate arbitrary workspaces.
- It avoids adapter-level always-include behavior, which would bypass package selection, source locks, dry-runs, update planning, and uninstall semantics.
- It lets users eject or remove the bootstrap package entry if they intentionally do not want the skill in a workspace.

Important implementation detail: a local source path to the installed package root is absolute, so it survives running from any workspace. In ESM, derive it from `import.meta.url` and walk from `dist/index.js` to the package root in the published layout.

## B. Skill Directory Layout

Draft layout:

```text
skills/
  agentwheel/
    SKILL.md
```

`SKILL.md` is the runtime-facing skill content. This design note lives under `docs/design/` so it is not installed with the runtime skill.

## C. Manifest Provides Entry

Root `openpack.json` draft:

```json
{
  "schemaVersion": 2,
  "name": "NestDevLab/agentwheel",
  "version": "0.7.0",
  "provides": [
    { "type": "skills", "path": "skills", "required": true }
  ]
}
```

The manifest schema accepts `schemaVersion`, `name`, `version`, and `provides`; do not add `description`, `license`, `homepage`, `targets`, `compatibility`, or dependencies beyond the OpenPack schema until the implementation resolves them.

## D. Rollout Note

New workspaces:

1. `agentwheel init` creates `.agentwheel/config.json`.
2. The config includes the bootstrap package entry for `skills/agentwheel`.
3. `agentwheel sync --dry-run` shows the skill install for the detected or selected runtime.
4. `agentwheel sync` installs it into runtimes whose adapter enables `skills`.

Existing workspaces:

- They are unchanged until a user runs an updated `agentwheel init`, or a future explicit migration command is added.
- Re-running `agentwheel init` should preserve existing config and upsert the bootstrap package entry by name rather than replacing the user package list.
- If the user removed the bootstrap entry intentionally, set top-level `"bootstrapSkills": false` in `.agentwheel/config.json`.

Updates:

- Because the bootstrap source is the installed agentwheel package root and the package entry is `tracking`, `agentwheel update --dry-run` can notice changes when the npm package is upgraded and the local source hash changes.
- Drift handling remains normal: manual edits in the runtime-installed `SKILL.md` block sync/update. Intentional local ownership uses `agentwheel eject agentwheel/skills/agentwheel`.
- Ejecting copies the current bootstrap skill to `.agentwheel/ejected/agentwheel/skills/agentwheel`; future agentwheel updates leave that ejected copy alone.

Copilot caveat:

- The current Copilot adapter has `skills` disabled, so the bootstrap skill will not install into GitHub Copilot until a conversion target exists. It can still install into OpenClaw, Claude, Codex, and Hermes.

## Contradictions Or Code Mismatches Found

- `AGENTS.md` was requested in the brief, but there is no `AGENTS.md` file in this working tree. The provided conversation instructions were used instead.
- README profile examples show `"daily": [ ... ]`, but `src/model/workspace.ts` requires `"daily": { "runtimes": [ ... ] }`. The draft skill uses the schema that the code accepts.
- The brief asks for "every workspace agentwheel manages ends up with it WITHOUT a manual add." Previous code did not do this; the implemented `init` config seeding is the minimal code change that fits existing flows.
- `agentwheel add` saves config but does not install runtime files. Agents must run `agentwheel sync --dry-run` and then `agentwheel sync`.
- `agentwheel plan` requires a source argument; only `sync` can run configured packages without a source.
- `uninstall` operates from the install manifest and has no source argument.
- The current Copilot adapter disables raw `SKILL.md` skills.
