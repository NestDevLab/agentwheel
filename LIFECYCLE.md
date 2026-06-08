# agentweave — Lifecycle, Storage & Distribution Model

Status: **design agreed** (2026-06-08). This is the reference spec for v0.2/v0.3.
v0.1 = the install spine; this document defines publish → install → update → customize.

## The three locations (the base rule)
Everything maps to exactly one of three places:

| | Where | What | Editable? |
|---|---|---|---|
| **(P)** | the package **Author's** repo | upstream content | NO — we read/fetch, never edit it there |
| **(W)** | **our workspace**, under `.agentweave/` | control plane: config, locks, **our customizations** | YES — this is where we work |
| **(R)** | the **Runtime** dirs (`.openclaw/`, `~/.claude/`, …) | **generated output** of `sync` | NO — drift-protected, never hand-edit |

Flow: **(P) upstream + (W) our layer → `sync` → (R) output**.

## 1. Package format (how you publish)
An **agentweave package** = a repo/dir with a JSON manifest + canonical per-type layout:
```
agentweave.json            # or agentweave.jsonc — manifest (JSONC accepted, plain JSON works natively)
instructions/AGENTS.md
rules/*.md
skills/<name>/SKILL.md
commands/*.md
hooks/
mcp/
plugins/
```
Minimal manifest:
```jsonc
{
  "schemaVersion": 1,
  "name": "nestdevlab/core-agent-pack",
  "version": "0.1.0",
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules",        "path": "rules" },
    { "type": "skills",       "path": "skills" }
  ]
}
```
Optional later: `description, license, homepage, targets, compatibility, dependencies`.
Format rule: **JSON everywhere. No YAML.** JSONC (comments/trailing commas) allowed for human-authored
files (manifest, adapter configs); generated files (`*.install-manifest.json`, `*.source-lock.json`)
are always pure JSON. Single parser (`jsonc-parser`) reads both.

## 2. Distribution (where it's published)
- **Default: git URL** — no central registry required:
  - `agentweave add github:owner/repo`
  - `agentweave add git:https://host/repo.git#ref`
  - `agentweave add ./local-path`
- **Skills** may also live in SkillKit / Vercel ecosystems; agentweave consumes them as a source driver.
- **Registry/index** = a separate git repo (`NestDevLab/agentweave-registry`) holding `index.json`,
  cached in `~/.agentweave/registry-cache.json` (workspace cache optional for reproducibility/offline).
  Populated by (a) curated PRs and (b) federation of existing registries (SkillKit/Vercel/MCP) via source drivers.
- **The registry is OPTIONAL** — discovery + short-names only (`agentweave add core-agent-pack`).
  Never a gatekeeper or single point of failure: git-URL/path install always works.

## 3. Update
- `source-lock` pins `requestedRef → resolvedCommit + hash`. Two modes:
  - **pinned** (reproducible): updates only when you change the ref/version.
  - **tracking** (branch/tag): `agentweave update` re-resolves → re-stages → re-plans → applies **only if no drift**.
- Generated `install-manifest` records what was written + expected hash (drift basis).

## 4. Customization channels (drift ≠ customization)
**Golden rule:** drift means "you accidentally edited a managed output file" (blocked). Intentional
customization has four official channels, all stored in **(W) `.agentweave/`** — never in the runtime
dir, never in the author's repo:
```
.agentweave/
  config.json                               # installed packages, sources, modes
  overlays/<runtime>/instructions.local.md  # (1) LAYERING — editable AGENTS.md region
  additions/rules/*.md                      # (2) ADDITIVE — extra rules, composed with upstream
  overrides/<package>/<type>/<name>         # (3) OVERRIDE — replaces the upstream item, shown in plan
  ejected/<package>/...                     # (4) EJECT — item taken into local ownership; update won't touch
  *.source-lock.json   *.install-manifest.json
```
- **(1) Layering** is the default for instructions/AGENTS.md. The generated runtime file is a composition:
  ```
  <!-- BEGIN agentweave managed: upstream -->  ...updatable...  <!-- END ... -->
  <!-- BEGIN agentweave local: editable -->    ...your edits survive updates...  <!-- END ... -->
  ```
- **Agent-editable AGENTS.md** ("remember X durably"): the agent writes to
  `.agentweave/overlays/<runtime>/instructions.local.md` (in W), then `sync` regenerates R.
  **No round-trip from the runtime file** (that would create two editable sources and muddy drift).
  Future command: `agentweave remember --runtime openclaw "X"`.

`.agentweave/` is **version-controllable** → commit it to your project repo for reproducible, portable,
update-surviving customizations.

## 5. Adapters — pluggable, no fork, can stay private
Adapters describe a runtime's layout (capabilities + paths + transforms) as a config (file-drop model).
They are **pluggable without forking agentweave and without publishing to our repo**:
- **Built-in**: openclaw / claude / codex (then hermes / copilot), bundled.
- **Local declarative adapter (JSONC/JSON)**: a private/custom runtime is just an adapter config file —
  `agentweave sync --adapter-config ./my-runtime.jsonc`, or dropped in `.agentweave/adapters/`. Stays
  private in your own repo/machine; never needs the registry or our repo. (v0.1 already supports
  `--adapter-config`.)
- **Programmatic adapter (later)**: for runtimes needing custom logic beyond declarative file-drop,
  load a local module via an adapter contract — still without publishing upstream.

## CLI surface (target)
`init, add, list, scan, plan, sync, sync --dry-run, update, eject, uninstall, doctor, remember`
(`plan` / `sync --dry-run` are the central trusted commands.)
