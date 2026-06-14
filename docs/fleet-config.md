# Fleet configuration

agentwheel can run as a local control plane for several agent runtimes. Define named targets in
`.agentwheel/config.json` or in the global `~/.agentwheel/config.json`, then address them with
`--agent`, `--all`, or `--profile`.

Project config overrides global config by agent or profile name.

## Agents

Local agents write to a local runtime root:

```jsonc
{
  "agents": {
    "local-codex": {
      "adapter": "codex",
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

Profiles group runtimes:

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
agentwheel install --profile daily --dry-run
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
      "mode": "tracking"
    },
    {
      "name": "agent-toolkit-nestdev",
      "source": "github:example-org/agent-toolkit#main",
      "driver": "git",
      "adapter": "codex",
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

Semantic plugin installs and programmatic adapter operations are local-only. If a package needs
those on an SSH target, run the command on the remote host after reviewing the dry-run output.
