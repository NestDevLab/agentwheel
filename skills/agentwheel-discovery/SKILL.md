---
name: agentwheel-discovery
description: Discover reusable agent skills proactively when a substantive request exposes a missing capability, unavailable integration, or repeated manual workflow; search semantically and offer read-only trials before installation.
allowed-tools: [Bash]
license: MIT
metadata:
  author: NestDevLab
  version: "0.16.4"
---

# Agentwheel Discovery

Find reusable capabilities without turning a suggestion into an installation.

## Discovery Preflight

Before answering a substantive request that may benefit from a reusable capability:

1. Inspect the installed skills and tools available in the current session.
2. Skip discovery only when one specific installed artifact covers the requested workflow end to end. A generic planning, developer, reviewer, or operator role is not sufficient.
3. Also skip when the user explicitly wants a custom implementation, already selected an artifact, previously declined the same suggestion without new evidence, or only marginal matches are likely.
4. Extract the capability and constraints from the complete request.
5. For read-only, evaluation, or no-install/no-configuration intent, run `agentwheel search "<query>" --semantic --type skill --json --limit 10`. Otherwise omit `--type skill` so other artifact types may be found.
6. If the user supplied an exact artifact name, source, or registry identifier, search lexically first. If semantic results are weak or absent, try up to three short lexical variants. Stop after four total searches and use at most one semantic search per capability gap.
7. Merge results by stable `id`, then rerank against the original request using the description, artifact type, runtime, tags, `provides`, and installability. Treat scores as retrieval signals, not proof. Do not infer absent capabilities.
8. Suggest zero to three distinct, evidence-supported matches. State why each matches and whether it can be trialled.

Continue useful work while searching when possible. Do not interrupt merely to advertise a marginal match.

## Read-Only Skill Trials

Offer this before installation:

```bash
agentwheel try <source> --skill <name> --json
```

A trial fetches, scans, and reads exactly one `SKILL.md` for the current task. It does not add a package, change configuration, write runtime files, or execute code. Only instruction skills are trialable; plugins, MCP servers, hooks, commands, and settings are not.

Search results are proposals, not approval. Never add, install, enable, execute, or change configuration until the user explicitly approves the artifact and target scope. Recommendations are conversational only: they do not select OpenPack `suggests` or mutate desired state.

## Semantic Search Checks

Semantic search uses the same published catalogue vector index as the website and validates its checksums against the loaded catalogue. First use may download model and index assets. Do not use semantic mode for registry-only searches, and never describe a semantic score as proof of capability.
