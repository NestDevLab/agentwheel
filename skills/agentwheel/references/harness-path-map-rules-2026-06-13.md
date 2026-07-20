# Harness path-map rules pattern — 2026-06-13

Use this when Joseph asks to make CT107/CT110 workspace/harness topology visible to all agents through AgentWheel.

## Durable pattern

- Put detailed machine-readable topology in the shared docs root:
  - `/home/administrator/env/workspace/itermodus/brain-shared/mappings/harnesses.yaml`
- Put the short, always-installed instruction in the private core toolkit:
  - `/home/administrator/env/workspace/itermodus/nestdevlab/agent-core-toolkit-private/rules/harness-path-map.md`
- The `agent-core-toolkit-private` package exposes `rules/` via `openpack.json`, so any new file under `rules/` is discoverable by `agentwheel list .` and installable by configured runtimes.

## Content split

- Rule file: concise operational policy and pointers. Avoid a huge topology dump.
- YAML file: detailed host/path/mount map, legacy path status, canonical runtime homes.

## Current canonical layout

```text
/home/administrator/env/workspace/itermodus/brain-shared   # shared docs/memory/maps/runbooks
/home/administrator/env/workspace/itermodus/nestdevlab     # AgentWheel/OpenPack/plugin/source repos
/home/administrator/.hermes                                # Hermes harness home
/home/administrator/.openclaw                              # OpenClaw harness home
/home/administrator/.codex                                 # Codex harness home
/home/administrator/.claude                                # Claude harness home
/home/administrator/.agentwheel                            # AgentWheel home
```

CT107 `/home/administrator/env/ai-agents` is a technical SSHFS view of `CT110:/home`, not the canonical docs root. Do not propose active CT110 harness state under `/root`; treat `/root` paths as legacy/backup/compatibility until audited.

## Verification

From the package root:

```bash
agentwheel list .
```

Expected: it lists both existing and newly added `rules/*.md` artifacts.

Before applying to runtimes, prefer:

```bash
agentwheel install --dry-run
```

Apply only after Joseph approves runtime/generated-file changes.

## Completion pattern for fleet propagation

When Joseph approves completing propagation of this rule, do not only run a source-scoped install. Make the package part of durable AgentWheel desired state, then apply both configured remote agents and locally detected runtimes.

1. Add the private core toolkit rule to AgentWheel global config once:

```bash
sudo -u administrator -H bash -lc 'agentwheel add /home/administrator/env/workspace/itermodus/nestdevlab/agent-core-toolkit-private \
  --name NestDevLab/agent-core-toolkit-private \
  --driver local \
  --adapter openclaw \
  --mode tracking \
  --select rules/harness-path-map.md'
```

2. Preview/apply configured named agents, including SSH targets such as CT110 OpenClaw/Hermes/Tirrenia:

```bash
sudo -u administrator -H bash -lc 'agentwheel install --all --dry-run'
sudo -u administrator -H bash -lc 'agentwheel install --all'
```

3. Separately preview/apply runtimes auto-detected on the current host. `--all` only covers configured agents; it does not cover local auto-detected `.openclaw`, `.claude`, or `.codex` directories unless those are named agents.

```bash
sudo -u administrator -H bash -lc 'agentwheel install --all-detected --dry-run'
sudo -u administrator -H bash -lc 'agentwheel install --all-detected'
```

4. Verify with checksums against the package source and final dry-runs. A clean completion has identical hashes for source/generated rule files and summaries with `drift 0, conflict 0`.

```bash
sha256sum /home/administrator/env/workspace/itermodus/nestdevlab/agent-core-toolkit-private/rules/harness-path-map.md \
  /home/administrator/.openclaw/rules/harness-path-map.md \
  /home/administrator/.claude/rules/harness-path-map.md \
  /home/administrator/.codex/rules/harness-path-map.md

ssh root@192.168.1.110 'sha256sum \
  /home/administrator/env/workspace/itermodus/nestdevlab/agent-core-toolkit-private/rules/harness-path-map.md \
  /home/administrator/.openclaw/rules/harness-path-map.md \
  /home/administrator/.hermes/rules/harness-path-map.md \
  /home/openclaw-tirrenia/.openclaw/rules/harness-path-map.md'
```

## Pitfalls

- Use `--only-source` when doing an ad-hoc source-scoped dry-run; otherwise AgentWheel may try to apply the current workspace's configured packages and report irrelevant selected-artifact errors.
- A failed apply may leave a pending journal that AgentWheel can recover on the next run. Fix the underlying issue and rerun `agentwheel install`; do not hand-edit generated files unless ownership/permissions block AgentWheel itself.
- If remote Hermes rule directories are owned by `root`, fix ownership of the directory and rerun AgentWheel instead of copying the file manually, e.g. `chown administrator:administrator /home/administrator/.hermes/rules` on CT110.
