# Fleet configuration

agentwheel can run as a local control plane for several agent runtimes. Define named targets in
`.agentwheel/config.json` or in the global `~/.agentwheel/config.json`, then address them with
`--agent`, `--all`, or `--profile`.

Project config overrides global config by agent or profile name.

## Portable project selections

Keep a project's local runtime profiles in that project when they need to work without a fleet
control plane. A `schemaVersion: 2` project config can export a named selection under
`exports.selections`; a fleet package then imports just that data from the already resolved package
source.

```json
{
  "schemaVersion": 2,
  "packages": [
    {
      "name": "project-workspace",
      "source": "/workspace/project",
      "driver": "local",
      "adapter": "hermes",
      "mode": "pinned",
      "selection": { "export": "remote" }
    }
  ]
}
```

This does not merge the project config into the fleet config. Fleet-owned agents, SSH hosts,
profiles, adapter settings, and trust policy stay fleet-owned; only the source project's validated
selection export is used. `selection` is supported for `local` and `git` sources and is locked with
the resolved source snapshot. Use `agentwheel plan --profile <name> --json` or `agentwheel install
--profile <name> --dry-run` to review the source, export hash, chain, and effective selection.

## Agents

Local agents write to a local runtime root:

```jsonc
{
  "agents": {
    "local-codex": {
      "adapter": "codex",
      "installationType": "local",
      "root": "/workspace/project",
      "transport": "local"
    }
  }
}
```

SSH agents write to a runtime root on a remote host:

```jsonc
{
  "agents": {
    "remote-codex": {
      "adapter": "codex",
      "installationType": "local",
      "root": "/workspace/project",
      "transport": "ssh",
      "host": "agent-host.example",
      "user": "agent",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519"
    }
  }
}
```

For SSH agents, `root` is a remote path and is not expanded relative to the local workspace. The
optional `identityFile` is resolved like other local config paths, so `~` and relative paths work.

SSH targets require these commands on the remote host:

- `ssh` access from the control machine
- `node` for manifest-compatible hashing
- `tar` for file and directory transfer

## Profiles

Leaf profiles group runtimes:

```jsonc
{
  "profiles": {
    "daily": {
      "runtimes": [
        { "agent": "local-codex" },
        { "agent": "remote-codex" }
      ]
    }
  }
}
```

Composite profiles group autonomous Agentwheel workspaces instead. A member keeps its own config,
locks, manifests, profiles, and standalone update path; the parent invokes the member's native
Agentwheel CLI locally or over SSH:

```jsonc
{
  "profiles": {
    "operations": {
      "refreshTtlSeconds": 86400,
      "members": [
        {
          "id": "control",
          "transport": "local",
          "workspace": ".",
          "profile": "all"
        },
        {
          "id": "selfhost",
          "transport": "ssh",
          "host": "selfhost-agent",
          "workspace": "/srv/selfhost-toolkit",
          "profile": "standalone",
          "refreshTtlSeconds": 3600
        }
      ]
    }
  }
}
```

A profile contains either `runtimes` or `members`, never both. Composite profiles may contain
other composite profiles; cycles and duplicate member IDs fail validation. `status`, `plan`,
`install`, and `update` use the same `--profile` interface for both profile kinds.

Member status is a versioned JSON protocol. A compatible CLI version mismatch is a warning;
an incompatible schema blocks plan and apply. Member snapshots use a 24-hour TTL by default.
TTL expiry or `--refresh` forces a live refresh. `--offline` may show cached data, but labels it
`STALE`; failed required refreshes are `DEGRADED` and never presented as current.

Composite apply is two-phase: every member must pass preflight before any member is changed, then
members run in declared order and stop on the first failure. Agentwheel revalidates member
revisions immediately before apply and uses each member's native locks. It never steals a busy
lock and does not claim distributed rollback.

`installationType` is optional on agents and profile runtimes. Use `local` for project/workspace
targets and `user` for documented user-level harness targets. A CLI `--installation-type` overrides
the configured value for that invocation.

Agents and profile runtimes may declare structured `reloadCommands` for live reload/restart steps
that should run after semantic plugin changes. Agentwheel never runs these commands by default; pass
`--reload-runtimes` (or `--restart-runtimes`) on the apply command, or set `reloadRuntimes: true` on
a profile runtime. Commands are argv arrays, not shell strings:

```jsonc
{
  "agents": {
    "tirrenia": {
      "adapter": "openclaw",
      "installationType": "local",
      "root": "/home/openclaw-tirrenia",
      "transport": "ssh",
      "host": "ct110",
      "user": "openclaw-tirrenia",
      "reloadCommands": [["systemctl", "restart", "openclaw-gateway-tirrenia.service"]]
    }
  },
  "profiles": {
    "tirrenia-plugins": {
      "runtimes": [
        { "agent": "tirrenia", "executePlugins": true, "reloadRuntimes": true }
      ]
    }
  }
}
```

Run a single agent:

```bash
agentwheel install --agent remote-codex --dry-run
agentwheel install --agent remote-codex
```

Run all configured agents:

```bash
agentwheel install --all --dry-run
```

Run a profile:

```bash
agentwheel update --profile daily --dry-run
agentwheel install --profile daily --dry-run
agentwheel install --profile daily --execute-plugins --reload-runtimes
agentwheel status --profile daily
agentwheel update --all   # uses profile "all" when configured
agentwheel status --all   # uses profile "all" when configured
```

## Source overrides for fleets

Fleet configs can intentionally put a forked source ahead of an artifact that is pulled in by a
meta-package. Declare the fork as its own package, select the replacement artifacts, and list the
upstream artifacts it may replace under `overrides`.

```jsonc
{
  "packages": [
    {
      "name": "nestdev-must-have-core",
      "source": "github:NestDevLab/agent-must-have#core",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking"
    },
    {
      "name": "agent-toolkit-nestdev",
      "source": "github:example-org/agent-toolkit#main",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking",
      "select": [
        "rules/self-improve-on-correction.md",
        "skills/self-improve"
      ],
      "overrides": [
        "github:example-upstream/agent-toolkit::rules/self-improve-on-correction.md",
        "github:example-upstream/agent-toolkit::skills/self-improve"
      ]
    }
  ]
}
```

`source::type/name` identifies the losing artifact. The replacing package must select one artifact
with the same `type/name`; if there is no exact loser or no exact replacement, planning fails.
Dry-runs print `OVERRIDE` lines, so review those before applying a fleet-wide install.

`plan`, `install --dry-run`, `install`, `update`, and `uninstall` all use the target transport. For SSH
targets, agentwheel reads the remote install manifest and hashes remote files before planning, so
drift and conflict detection have the same semantics as local targets.

If a profile source moves to another workspace root without changing an installed artifact, use
`agentwheel ownership handoff <type/name> --dry-run` and then repeat with the printed
`--expected-hash` and `--expected-revision`. The apply path is intentionally single-target and
single-artifact: it checks the exact previous workspace owner and current runtime hash under the
normal apply lock, then atomically changes only that entry's `workspaceOwner`. Local and named SSH
targets share this transport-neutral behavior. It never copies, removes, or rewrites the runtime
artifact.

Semantic plugin installs and programmatic adapter operations are local-only. If a package needs
those on an SSH target, run the command on the remote host after reviewing the dry-run output.
