# Multi-runtime Plugin Install Design Spike

Date: 2026-06-22

Scope: make Agentwheel install `plugins` artifacts from a local OpenPack source into the built-in runtimes. This is a design spike only. OpenClaw is the reference implementation; the work is Claude Code, Codex CLI, GitHub Copilot CLI, and Hermes.

## Findings

Current `origin/main` state:

- `src/install/plan.ts` only turns `plugins` into a semantic `plugin` operation for `target.semantic === "openclaw-plugin"`.
- `src/targets/plugins/openclaw.ts` returns `openclaw plugins install --force <path>`.
- `src/install/apply.ts` can execute a single `semanticCommand` behind `--execute-plugins`, including over ssh by copying `operation.sourcePath` to a temporary remote staging directory.
- `src/adapters/{claude,codex,copilot,hermes}.ts` declare plugin targets as directory destinations with semantic labels, so Agentwheel currently copies plugin directories to inert paths.
- `src/install/uninstall.ts` treats manifest entries as real paths. A semantic plugin entry whose `relativeDestPath` is virtual will not uninstall correctly unless uninstall learns semantic plugin operations.

Verified runtime facts:

- Claude Code: `claude plugin install` installs from available marketplaces. `claude plugin marketplace add <source>` accepts URL, path, or GitHub repo. Official docs also describe skills-directory plugins under `.claude/skills` or `~/.claude/skills`, loaded as `<name>@skills-dir` with no marketplace install step.
- Codex CLI 0.141.0: `codex plugin add` installs only from a configured marketplace snapshot. `codex plugin marketplace add` accepts local marketplace roots, GitHub shorthand, and Git URLs.
- GitHub Copilot CLI: the binary is not installed on this host, but current GitHub docs list `copilot plugin install ./my-plugin` and `/abs/path` as persistent local-path installs. `--plugin-dir` remains process-scoped and ephemeral.
- Hermes on CT110 is v0.17.0. `hermes plugins install` accepts `Git URL or owner/repo`; installed source confirms it also accepts `file://` Git URLs and `#subdir`, warns on `file://`, then runs `git clone --depth 1`.
- OpenClaw already supports `openclaw plugins install --force <path>` from a local directory.

## Design Principle

Stop modeling non-OpenClaw plugins as directory-copy artifacts. A runtime plugin install is a semantic side effect with runtime-specific staging, install commands, enabled state, and uninstall commands.

Keep the existing adapter `semantic` labels, but route all built-in plugin semantics through runtime helpers under `src/targets/plugins/`. Do not leave `claude-plugin`, `codex-plugin`, `copilot-plugin`, or `hermes-plugin` to the generic copy path.

## Shared Agentwheel Changes

Add a richer semantic plugin operation model. A plain `semanticCommand: string[]` is not enough for marketplaces, multiple commands, persistent shims, or uninstall.

Recommended shape:

```ts
interface SemanticPluginSpec {
  runtime: "openclaw" | "claude" | "codex" | "copilot" | "hermes";
  pluginName: string;
  marketplaceName?: string;
  stateRoot?: string;
  installCommands: string[][];
  uninstallCommands: string[][];
  enableCommands?: string[][];
  disableCommands?: string[][];
}
```

Implementation points:

- Add runtime helpers:
  - `src/targets/plugins/claude.ts`
  - `src/targets/plugins/codex.ts`
  - `src/targets/plugins/copilot.ts`
  - `src/targets/plugins/hermes.ts`
  - keep `openclaw.ts`
- Use a persistent Agentwheel state root, not the temporary staging bundle, for marketplace and git shims:
  - local install: `<targetRoot>/.agentwheel/plugins/<adapter>/<installationType>/<safe-package>/<safe-plugin>/`
  - user install: `<home>/.agentwheel/plugins/<adapter>/<installationType>/<safe-package>/<safe-plugin>/`
  - remote ssh install: create/copy the same state tree on the remote target before running commands.
- Read the runtime plugin name from the runtime manifest, falling back to the OpenPack artifact name:
  - Claude: `.claude-plugin/plugin.json`
  - Codex: `.codex-plugin/plugin.json`
  - Copilot: `plugin.json`
  - Hermes: `plugin.yaml`, `plugin.yml`, or package/module name for Python-style plugins
  - OpenClaw: `plugin.json` or `openclaw.plugin.json`
- Make `createInstallPlan` aware of semantic plugin execution intent, or include `executed` in skip logic:
  - If a manifest entry has the same `sourceHash` but `executed !== true`, a later `--execute-plugins` run must still produce a pending `plugin` operation.
  - Preferred: do not treat an unexecuted semantic plugin entry as installed. If kept for ownership, it must never block later execution.
- Update apply:
  - Execute multiple install commands in order.
  - Use `transport.execFile` for remote commands.
  - Stage marketplace/git shims onto the remote side before command execution.
  - Store `executed: true`, `pluginName`, `marketplaceName`, and uninstall command metadata in the manifest.
- Update uninstall:
  - Semantic plugin manifest entries must produce semantic uninstall operations even if no real path exists at `relativeDestPath`.
  - `agentwheel uninstall --dry-run` prints uninstall commands.
  - Normal uninstall runs runtime uninstall commands. `--keep-files` keeps the runtime plugin installed and removes only Agentwheel ownership/config state.
- Update validation:
  - Add runtime-specific plugin manifest validation instead of only checking that plugin artifacts are directories.
  - Keep OpenClaw's stricter descriptor validation.
- Update compatibility docs/tests:
  - Directory targets for Claude/Codex/Copilot/Hermes plugins should no longer be documented as native install paths.
  - Add negative tests proving generic copies are not planned for those semantics.

## Runtime Mechanisms

### OpenClaw

Verdict: implementable now via local install command. Already wired.

Mechanism:

```bash
openclaw plugins install --force <staged-plugin-path>
```

Agentwheel changes:

- Keep `openclaw-plugin` as the reference semantic operation.
- Migrate it to the shared `SemanticPluginSpec` model.
- Preserve `--execute-plugins` gating.
- Add generic semantic uninstall support. Verify the exact OpenClaw remove/disable command before implementing uninstall; do not infer it from the install command.

Risks:

- Current OpenClaw plan/apply can record `executed: false` and later skip by hash. Fix shared executed-state logic before broadening plugins.

### Claude Code

Verdict: implementable now via Agentwheel-generated local marketplace. A skills-directory copy is also possible, but should be a fallback path, not the primary install model.

Preferred mechanism:

1. Copy the staged Claude plugin into a persistent marketplace root:

```text
<stateRoot>/marketplace/
  .claude-plugin/marketplace.json
  plugins/<pluginName>/.claude-plugin/plugin.json
  plugins/<pluginName>/...
```

2. Generate `.claude-plugin/marketplace.json`:

```json
{
  "name": "agentwheel-<safe-package>-<safe-plugin>",
  "owner": { "name": "Agentwheel" },
  "plugins": [
    {
      "name": "<pluginName>",
      "source": "./plugins/<pluginName>",
      "description": "Installed by Agentwheel from <packageName>"
    }
  ]
}
```

3. Execute:

```bash
claude plugin marketplace add <stateRoot>/marketplace --scope <user|project|local>
claude plugin install <pluginName>@agentwheel-<safe-package>-<safe-plugin> --scope <user|project|local>
```

Scope mapping:

- Agentwheel `user` -> Claude `user`.
- Agentwheel `local` -> Claude `local` (`.claude/settings.local.json`).
- Consider adding Agentwheel `project` later for Claude `project` (`.claude/settings.json`) rather than overloading `local`.

Uninstall:

```bash
claude plugin uninstall <pluginName>@<marketplaceName> --scope <scope>
claude plugin marketplace remove <marketplaceName> --scope <scope>
```

Notes:

- Do not merely merge `enabledPlugins`; the plugin cache may not exist until `claude plugin install` runs.
- The install command writes enabled state into the scoped settings file.
- If enterprise managed settings block directory marketplaces, the install must fail clearly.

Fallback mechanism:

- Copy a plugin containing `.claude-plugin/plugin.json` into `.claude/skills/<pluginName>` or `~/.claude/skills/<pluginName>`.
- Claude loads it as `<pluginName>@skills-dir` on the next session without marketplace install.
- Uninstall is deleting the managed directory.
- Risk: project-scope `@skills-dir` plugins only load from the directory where Claude starts; this is less explicit than the marketplace path.

### Codex CLI

Verdict: implementable via Agentwheel-generated local marketplace shim.

Mechanism:

1. Copy the staged Codex plugin into a persistent marketplace root:

```text
<stateRoot>/marketplace/
  .agents/plugins/marketplace.json
  plugins/<pluginName>/.codex-plugin/plugin.json
  plugins/<pluginName>/...
```

2. Generate `.agents/plugins/marketplace.json`:

```json
{
  "name": "agentwheel-<safe-package>-<safe-plugin>",
  "plugins": [
    {
      "name": "<pluginName>",
      "source": {
        "source": "local",
        "path": "./plugins/<pluginName>"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Agentwheel"
    }
  ]
}
```

3. Execute:

```bash
codex plugin marketplace add <stateRoot>/marketplace --json
codex plugin add <pluginName>@agentwheel-<safe-package>-<safe-plugin> --json
```

Uninstall:

```bash
codex plugin remove <pluginName>@<marketplaceName> --json
codex plugin marketplace remove <marketplaceName> --json
```

Notes:

- There is no documented `codex plugin add <local-dir>` command.
- Local marketplace roots are documented and supported by the installed CLI.
- Codex does not expose install scope flags in `plugin add`; the marketplace root may be repo-local or user-local, but the installed plugin state is managed by Codex config/cache. Document this scope mismatch in CLI output.

### GitHub Copilot CLI

Verdict: implementable now for persistent user-level installs via local install command. Project-local persistent install is not currently documented; `--plugin-dir` is ephemeral and should not be modeled as Agentwheel install.

Mechanism:

1. Copy the staged Copilot plugin into a persistent Agentwheel state directory.
2. Execute:

```bash
copilot plugin install <stateRoot>/plugin
```

Uninstall:

```bash
copilot plugin uninstall <pluginName>
```

Optional commands:

```bash
copilot plugin enable <pluginName>
copilot plugin disable <pluginName>
copilot plugin update <pluginName>
```

Notes:

- Current GitHub docs list local path as a valid `copilot plugin install` specification and describe direct installs under `~/.copilot/installed-plugins/_direct/`.
- The local host used for this spike does not have the `copilot` binary installed; implementation tests should mock command execution and optionally add a smoke test that skips when `copilot` is unavailable.
- The existing `.github/plugins` and `~/.copilot/plugins` copy targets should be removed or marked unsupported for plugin artifacts. They do not correspond to documented persistent plugin installs.
- If Agentwheel keeps both `local` and `user` installation types for Copilot plugins, `local` must fail clearly or be documented as "source is local, install is user-level". Prefer supporting only `user` until Copilot documents project-scoped persistent plugin installs.

### Hermes

Verdict: implementable via Agentwheel-generated local Git shim. Not installable from a raw local directory.

Mechanism:

1. Copy the staged Hermes plugin into a persistent Git repo whose repository root is the plugin root:

```text
<stateRoot>/repo/
  .git/
  plugin.yaml
  ...
```

2. Initialize and commit deterministically:

```bash
git init <stateRoot>/repo
git -C <stateRoot>/repo add -A
git -C <stateRoot>/repo -c user.name=agentwheel -c user.email=agentwheel@example.invalid commit -m "agentwheel plugin <sourceHash>"
```

3. Execute:

```bash
hermes plugins install --force --enable file://<stateRoot>/repo
```

Uninstall:

```bash
hermes plugins remove <pluginName>
```

Notes:

- CT110 Hermes source accepts `file://` URLs, warns, then clones them. This makes a local Git shim viable.
- Put the plugin at the repository root. Hermes moves the cloned target into `~/.hermes/plugins/<name>`; if a subdir is used, the installed plugin will not contain `.git`, and `hermes plugins update` cannot pull.
- For ssh targets, Agentwheel must build or copy the Git shim on the remote target and use the remote `file://` path in the command.
- Existing Hermes adapter supports only `user` plugins. Keep it that way.

## Idempotency

For all runtimes:

- Desired hash is the staged plugin directory hash, not the generated marketplace or git shim hash.
- Rebuild shims when desired hash changes.
- Skip only when the manifest has matching `sourceHash` and the runtime install was executed.
- On changed source, prefer runtime-supported update where it is clearly safe. Otherwise uninstall/reinstall or use force reinstall:
  - Claude: install after marketplace refresh/add; if stale behavior is observed, uninstall then install.
  - Codex: remove then add if `plugin add` will not refresh an installed local source.
  - Copilot: uninstall then install.
  - Hermes: `hermes plugins install --force --enable file://...`.
  - OpenClaw: `openclaw plugins install --force ...`.

## Risks

- Runtime docs are moving. Copilot local path support appears in current docs even though the local binary is absent here.
- Claude has two local mechanisms. Marketplace install is more explicit; skills-dir is simpler but has cwd/trust caveats.
- Codex and Copilot plugin installs are ambient user/runtime state, while Agentwheel has `local` and `user` installation types. Do not pretend a user-level runtime install is project-scoped.
- Generated marketplaces and Git shims are managed state. They must not be placed in runtime plugin directories or committed accidentally.
- Multi-command semantic operations need transaction behavior. Marketplace add may succeed while plugin install fails; apply recovery must report the partial runtime state and re-run idempotently.
- Remote ssh execution needs richer staging than the current "copy sourcePath to temp and replace exact arg" behavior.

## Phased Implementation Plan

1. Shared semantic plugin infrastructure:
   - Add runtime helper dispatch.
   - Add multi-command semantic specs.
   - Fix executed-state skip logic.
   - Add semantic uninstall planning/apply.
   - Port OpenClaw to the shared shape without changing behavior.
2. Codex and Claude:
   - Implement local marketplace shims.
   - Add validation for `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`.
   - Add fake-exec apply tests and docs updates.
3. Copilot:
   - Implement user-level local path install.
   - Disable or clearly fail project-local persistent plugin installs.
   - Add skip-if-binary-missing smoke coverage.
4. Hermes:
   - Implement persistent Git shim generation.
   - Add remote staging support for `file://` shims.
   - Add fake ssh transport tests that assert remote command and copied repo layout.
5. Compatibility cleanup:
   - Update `docs/design/artifact-harness-compatibility.md`.
   - Replace old directory-copy tests with semantic operation tests.
   - Add negative tests for inert paths such as `.claude/plugins`, `plugins`, `.github/plugins`, `.copilot/plugins`, and `.hermes/plugins`.
