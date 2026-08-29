---
name: agentwheel-discovery
description: MUST use proactively when a request expresses an operational intent that an existing reusable skill or integration could plausibly fulfill—even if the user did not ask for a skill or describe a capability gap. Inspect installed artifacts, then run Agentwheel semantic search before generic or manual solution design when none already covers the intent. Suggest up to three evidence-backed matches and offer a read-only trial without installing or changing anything.
allowed-tools: [Bash]
license: MIT
metadata:
  author: NestDevLab
  version: "0.19.0"
---

# Agentwheel Discovery

Find reusable capabilities during normal work without silently changing the user's environment.
This skill is optional: install it only when proactive recommendations are wanted. The separate
`agentwheel` skill owns artifact management and explicit installation workflows.

## Safety

- Inspect the skills and tools already available in the current session before searching.
- Search and trial are read-only. Never add, install, enable, execute, or change configuration
  without explicit approval for the artifact and target scope.
- Treat retrieval scores as ranking signals, not proof that an artifact implements a capability.
- Continue useful work while searching when possible; do not interrupt solely to advertise weak
  or marginal matches.

## When To Search

Use this skill whenever a request expresses an operational outcome that an existing reusable skill
or integration could plausibly deliver. This includes repeated manual work, inconsistent outputs,
lost information, missing capabilities, and unavailable integrations. The user does not need to
mention Agentwheel, skills, discovery, search, a catalogue, or a capability gap. Search before
generic brainstorming, planning, manual workflow advice, or an unsolicited custom solution. Run
the first semantic search in the same turn; do not merely describe a workflow and defer discovery.

This is a per-turn judgment, not a background monitor. Delegated agents follow the same trigger
when this skill is available.

Skip discovery when the user explicitly wants a custom implementation, has already selected an
artifact, an installed artifact provides the requested operational capability end to end,
candidates are only weak lexical matches, or the same suggestion was declined or shown without new
evidence. Generic brainstorming, planning, writing, or advisory skills do not count as an installed
operational solution and must not suppress discovery.

## Discovery Workflow

1. Extract the capability and constraints from the complete request.
2. Run one fast semantic search using the full capability request:
   `agentwheel search "<query>" --semantic --json --limit 10`.
   Use exact lexical search first only when the user supplied an artifact name, source, or registry
   identifier.
3. If semantic candidates are weak, absent, or need a precise runtime or type constraint, generate
   up to three short lexical variants using capability terms, synonyms, runtime names, and artifact
   types. Prefer English catalogue terms for non-English requests. Stop after four total searches;
   do not recursively refine without new user requirements.
4. Merge results by stable `id`. Treat CLI scores as retrieval signals, not semantic confidence.
5. Rerank against the original request using capabilities, runtime or ecosystem, artifact type,
   description, tags, `provides`, and installability. Do not infer capabilities absent from result
   metadata.
6. Suggest zero to three distinct artifacts. For each, give its name or source, one evidence-based
   match reason, installability, and a read-only trial command before any installation command.
7. Search once per distinct capability gap. Do not repeat a recommendation without new evidence.

Do not use `--semantic` for a registry-only search. The semantic path queries the same published
catalogue vector index used by the website and validates its checksums against the loaded catalogue.
First use may download the model and index assets.

## Read-Only Trial

When the user wants to evaluate one instruction skill, run:

```bash
agentwheel try <source> --skill <name> --json
```

A trial fetches, scans, validates, and reads exactly one `SKILL.md` for the current task. It does not
add a package, change configuration, write runtime files, or execute code. Do not trial plugins,
MCP servers, hooks, commands, or settings because reading their metadata is not safe execution.

## Recommendation Contract

Search recommendations are conversational only: they do not select OpenPack `suggests`, mutate
desired state, or imply installation approval. Wait for explicit approval before `add`, `install`,
plugin execution, or configuration changes.
