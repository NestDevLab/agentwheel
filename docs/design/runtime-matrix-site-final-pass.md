# Runtime Matrix Site Final Pass

## Current Screenshot

![Current runtime matrix screenshot](</home/administrator/.codex/attachments/f5c57b41-573a-4686-b090-2ac3d1a16479/codex-clipboard-a85c6571-eacb-4dd2-9d7a-5e2df18b082c.png>)

## Problem To Fix

The current public matrix mixes two different ideas:

- whether an OpenPack **artifact type** is supported by an adapter;
- where similar runtime behavior can be achieved through another artifact, usually `instructions`.

That makes cells like `Rules = via md` confusing. If a package contains `rules/foo.md`,
Agentwheel does not install that artifact on Codex, OpenClaw, or Hermes. Those cells should read
`no`, not `via md`.

Copilot is the exception in the current implementation: it has a real `rules` target that maps
OpenPack `rules` to Copilot custom instruction files.

## Matrix I Propose

| Artifact | Claude | Codex | OpenClaw | Hermes | Copilot |
|---|---|---|---|---|---|
| Instructions | `md` | `md` | `md user` | `md` | `md` |
| Rules | `md` | `no` | `no` | `no` | `md mapped` |
| Skills | `dir` | `dir` | `dir` | `dir user` | `dir` |
| Commands | `md` | `no` | `no` | `no` | `md` |
| Subagents | `md` | `toml` | `no` | `no` | `md` |
| MCP | `json` | `toml` | `json user` | `yaml user` | `json` |
| Hooks | `json` | `json` | `no` | `no` | `json` |
| Settings | `json` | `no` | `json user` | `yaml user` | `json` |
| Plugins | `dir` | `dir` | `semantic` | `dir user` | `dir` |
| Fragments | `compose` | `compose` | `compose` | `compose` | `compose` |

## Note To Show Under The Matrix

Behavioral guidance for Codex, OpenClaw, and Hermes should be authored as `instructions`, not
`rules`. `rules` is a Claude-native behavioral artifact; Copilot currently maps OpenPack `rules`
to custom instruction Markdown. Codex `.codex/rules` is shell command policy, not OpenPack
behavioral rules.

## Product Decision To Confirm

If we want the public rule to be "Rules are Claude-only" with no exception, then Copilot should
also become `no` in this matrix and the Copilot adapter should stop exposing a `rules` target.
If we keep the current implementation, `Copilot = md mapped` is the honest cell.
