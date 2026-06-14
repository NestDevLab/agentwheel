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
      "root": "/home/administrator/project",
      "transport": "local"
    }
  }
}
```

SSH agents write to a runtime root on a remote host:

```jsonc
{
  "agents": {
    "ct110-codex": {
      "adapter": "codex",
      "root": "/home/administrator/project",
      "transport": "ssh",
      "host": "ct110.example",
      "user": "administrator",
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
        { "agent": "ct110-codex" }
      ]
    }
  }
}
```

Run a single agent:

```bash
agentwheel install --agent ct110-codex --dry-run
agentwheel install --agent ct110-codex
```

Run all configured agents:

```bash
agentwheel install --all --dry-run
```

Run a profile:

```bash
agentwheel install --profile daily --dry-run
```

`plan`, `install --dry-run`, `install`, `update`, and `uninstall` all use the target transport. For SSH
targets, agentwheel reads the remote install manifest and hashes remote files before planning, so
drift and conflict detection have the same semantics as local targets.

Semantic plugin execution is local-only. Built-in programmatic adapter operations may use the
target transport; local adapter modules still require explicit `--allow-adapter-code` review.

## Restart Advice

After an apply changes runtime files, agentwheel recommends the reload action
that usually matches the target:

- OpenClaw and Hermes gateway targets: restart the gateway process.
- Codex and Claude targets: refresh or reopen the agent session.

Recommendations are printed automatically. Agentwheel executes a restart only
when the target declares a restart command and the CLI receives `--restart` or
`-R`.

```jsonc
{
  "agents": {
    "native-clean": {
      "adapter": "openclaw",
      "root": "/home/administrator/env/workspace/native-clean",
      "transport": "local",
      "restart": {
        "service": "openclaw-native-clean.service",
        "sudo": true,
        "reason": "OpenClaw loads generated config and skills at process start."
      }
    }
  }
}
```

Profile runtimes may override the named agent restart policy:

```jsonc
{
  "profiles": {
    "gateways": {
      "runtimes": [
        {
          "agent": "native-clean",
          "restart": {
            "command": ["pm2", "restart", "openclaw-native-clean"]
          }
        }
      ]
    }
  }
}
```

Use the same `restart` object with custom adapters. A `service` maps to
`systemctl restart <service>` and adds `sudo` when requested; `command` runs the
exact argv array. Without `--restart`, both forms are advice only.

## OpenClaw Per-Agent Skill Allowlists

OpenClaw installs skills globally under the runtime root, but `agents.list[].skills` is a full
per-agent allowlist. If an agent has `skills: []`, globally installed skills remain hidden from
that agent.

Adapter configs can opt in to appending Agentwheel-managed skills to explicit OpenClaw
allowlists:

```jsonc
{
  "name": "openclaw-native-clean",
  "targets": {
    "rules": { "dest": ".openclaw-native-clean/rules" },
    "skills": { "dest": ".openclaw-native-clean/skills" }
  },
  "openclaw": {
    "agentSkills": {
      "enabled": true,
      "configPath": ".openclaw-native-clean/openclaw.json",
      "agents": { "include": ["native-clean"] }
    }
  }
}
```

Agents without an explicit `skills` array are left unchanged because OpenClaw treats them as
unrestricted unless `agents.defaults.skills` is configured.
