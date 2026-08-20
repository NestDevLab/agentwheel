# Fleet configuration

Agentwheel can optionally run as a control plane for several agent runtimes. Register a named fleet,
define its targets in that fleet's config, then select it explicitly with `--fleet <fleet-id>` and
address its targets with `--agent`, `--all`, or `--profile`.

User, local, and fleet configurations are separate desired-state scopes. Agentwheel does not merge
them, and no named fleet has global priority. Commands that need workspace state must select exactly
one scope: `--user`, `--local`, or `--fleet <fleet-id>`.

Named fleets require a schema-v3-capable Agentwheel CLI. Upgrade first and verify
`agentwheel --version` and `agentwheel fleet --help`; only then create or inspect fleet state. Do
not downgrade the config, remove fleet data, or run an old CLI against it.

## Create and register a fleet

A fleet root is an existing canonical absolute directory with its own `.agentwheel/config.json`.
The config uses schema v3, declares a `fleetId` matching the intended registry key, and contains
every package named later with `--required-package`:

```jsonc
{
  "schemaVersion": 3,
  "fleetId": "example-fleet",
  "packages": [
    {
      "name": "core-agent-pack",
      "source": "github:example-org/core-agent-pack",
      "driver": "git",
      "adapter": "codex",
      "installationType": "local",
      "mode": "tracking"
    }
  ],
  "agents": {
    "local-codex": {
      "adapter": "codex",
      "installationType": "local",
      "root": "/workspace/project",
      "transport": "local"
    }
  },
  "profiles": {
    "daily": {
      "runtimes": [{ "agent": "local-codex" }]
    }
  }
}
```

Register it in user state after upgrading the CLI:

```bash
npm i -g agentwheel@latest
agentwheel --version
agentwheel fleet register example-fleet \
  --root /srv/agentwheel/fleets/example-fleet \
  --required-package core-agent-pack
agentwheel fleet list
agentwheel fleet show example-fleet
```

`fleet register` validates the canonical root, `fleetId`, and required packages before atomically
adding the registration. It preserves existing user packages and upgrades the user registry to
schema v3; it does not merge user desired state into the fleet. Repeat `--required-package` when a
fleet contract requires more than one package.

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
the resolved source snapshot. Use `agentwheel plan --fleet <fleet-id> --profile <name> --json` or
`agentwheel install --fleet <fleet-id> --profile <name> --dry-run` to review the source, export
hash, chain, and effective selection.

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
    "production-openclaw": {
      "adapter": "openclaw",
      "installationType": "local",
      "root": "/srv/agent-runtime",
      "transport": "ssh",
      "host": "agent-host.example",
      "user": "agent",
      "reloadCommands": [["systemctl", "restart", "agent-gateway.service"]]
    }
  },
  "profiles": {
    "production-plugins": {
      "runtimes": [
        { "agent": "production-openclaw", "executePlugins": true, "reloadRuntimes": true }
      ]
    }
  }
}
```

Run a single agent:

```bash
agentwheel install --fleet example-fleet --agent remote-codex --dry-run
agentwheel install --fleet example-fleet --agent remote-codex
```

Run all configured agents:

```bash
agentwheel install --fleet example-fleet --all --dry-run
```

Run a profile:

```bash
agentwheel update --fleet example-fleet --profile daily --dry-run
agentwheel install --fleet example-fleet --profile daily --dry-run
agentwheel install --fleet example-fleet --profile daily --execute-plugins --reload-runtimes
agentwheel status --fleet example-fleet --profile daily
agentwheel update --fleet example-fleet --all   # uses profile "all" when configured
agentwheel status --fleet example-fleet --all   # uses profile "all" when configured
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

## Exact MCP retirement

Use a separate, temporary Fleet workspace when a renamed MCP server must be removed after its
canonical replacement is already installed. The cutover workspace must contain exactly one legacy
MCP artifact per package and one named agent per runtime. An agent may declare an explicit
`stateKey` to select a pre-existing install manifest without depending on the current workspace
fingerprint:

```jsonc
{
  "agents": {
    "legacy-codex": {
      "adapter": "codex",
      "installationType": "user",
      "root": "/home/example",
      "transport": "local",
      "stateKey": "codex.user.legacy-state"
    }
  }
}
```

Preview with `agentwheel mcp retire <package> --agent legacy-codex --dry-run`. If the selected
manifest belongs to an earlier workspace, add `--from-workspace-root <exact-old-root>`; omission or
an owner mismatch fails closed. Unmanaged legacy state needs no owner flag. The plan is valid only
when it contains one `REMOVE`, no drift/conflict, the expected target root, and the expected legacy
server name. Apply is a separate decision using `--apply`; Agentwheel rechecks manifest revision and
the complete MCP subentry before writing, so changed arguments, environment, ownership, or state
abort without removing runtime content.

Semantic plugin installs and programmatic adapter operations are local-only. If a package needs
those on an SSH target, run the command on the remote host after reviewing the dry-run output.

## Ownership normalization

Selecting a fleet never takes ownership from user state, local state, or another fleet. An intended
path owned by a different scope is a blocking conflict even when both scopes render identical
bytes.

Use the dedicated normalization workflow to move declarations and ownership. The first command is
a dry-run; record and review its exact `planDigest`. Apply only the same source, destination,
package set, and digest:

```bash
agentwheel fleet normalize example-fleet --from user --package core-agent-pack --json
agentwheel fleet normalize example-fleet --from user --package core-agent-pack \
  --plan-digest <reviewed-sha256> --apply
```

Use `--from fleet:<source-fleet>` for fleet-to-fleet normalization. A stale digest, changed config,
changed manifest, or changed graph lock fails closed. The transaction transfers covered manifest
ownership and invalidates covered graph locks before removing the source declaration; it does not
rewrite runtime bytes.

If an interrupted apply leaves a pending normalization journal, recover the same source and
destination explicitly:

```bash
agentwheel fleet normalize example-fleet --from user --recover
```

Recovery restores the recorded source state and removes the journal only after confirming that the
configs, manifests, and graph locks have not changed outside the transaction. If those checks fail,
stop for manual review; do not delete the journal or edit generated runtime output.
