# Unified Artifact Search Implementation Plan

Status: implementation complete; delivery in progress

Base: `origin/main` at Agentwheel `0.15.0`

Branch: `feat/unified-artifact-search`

## Outcome

Agentwheel will expose one public discovery command:

```bash
agentwheel search <query>
```

It searches configured registries, the enriched public catalogue, and the compact Vercel skills
index. The old `agentwheel registry search` command is removed without an alias or deprecation
period. Registry resolution, update, list, and publish remain supported.

The CLI provides deterministic lexical retrieval. Semantic behavior belongs to the calling agent,
which may generate a bounded set of related queries, merge and rerank candidates, and suggest zero
to three artifacts. Version 1 does not add embeddings, an LLM dependency, vector search, fuzzy
matching, or subagent model configuration.

## Public CLI

```text
agentwheel search <query>
  --json
  --scope <all|registry|enriched|vercel>
  --type <package|skill|plugin|mcp|adapter>
  --ecosystem <official|openpack|mcp-registry|clawhub|skillkit|vercel>
  --limit <1-100>
  --include-archived
  --refresh
  --offline
  -t, --target-root <path>
```

Defaults:

- scope: `all`
- limit: `20`
- archived artifacts excluded
- catalogue cache TTL: 24 hours
- no-result searches exit successfully
- warnings use stderr so JSON stdout stays clean
- `--refresh` and `--offline` are mutually exclusive

The versioned JSON response is:

```ts
interface SearchResponse {
  schemaVersion: 1;
  query: string;
  scope: "all" | "registry" | "enriched" | "vercel";
  fromCache: boolean;
  results: SearchResult[];
}

interface SearchResult {
  id: string;
  name: string;
  description: string;
  type: "package" | "skill" | "plugin" | "mcp" | "adapter";
  ecosystem?: string;
  tags: string[];
  provides: string[];
  source?: string;
  repoUrl?: string;
  installCommand?: string;
  installability: "registry" | "source" | "informational";
  provenances: Array<"registry" | "enriched" | "vercel">;
  score: number;
  matchedFields: string[];
}
```

`fromCache` is true only when every requested source came from cache.

## Data and Ranking Contracts

Catalogue sources:

- `catalogue-data.json`
- `catalogue-vercel-index.json`

The catalogue cache is independent from registry resolution state, lives at
`~/.agentwheel/catalogue-cache.json`, rejects payloads above 32 MiB per file, and is written
atomically only after both source documents validate. A failed refresh may use a compatible stale
cache with a stderr warning; offline mode requires a compatible cache.

Deduplication:

1. Reject duplicate IDs inside one dataset.
2. Merge enriched and Vercel records only by exact stable ID.
3. Keep the enriched record and retain the compact description as alternate searchable text.
4. Merge registry and catalogue records only when name and canonical source match and the registry
   record has no selectors.
5. Prefer registry installation metadata, then enriched, then compact Vercel.
6. Never deduplicate by display name or repository alone.

Search text uses Unicode NFKC normalization, lowercase conversion, punctuation-to-space conversion,
and unique query tokens. The CLI does not apply edit distance, stemming, or synonyms.

| Signal | Weight |
|---|---:|
| exact name | 10,000 |
| name prefix | 5,000 |
| name phrase | 3,000 |
| tag or `provides` phrase | 2,000 |
| description phrase | 1,000 |
| type or ecosystem phrase | 800 |
| repository phrase | 400 |
| name token | 300 |
| name token prefix | 200 |
| tag or `provides` token | 180 |
| description token | 80 |
| type or ecosystem token | 60 |
| repository token | 40 |
| all terms covered | +500 |

Tie-breaking is score, featured status, stars, last-push time, normalized name, then stable ID.

## Agent Recommendation Contract

The Agentwheel companion skill may search automatically when a reusable capability, integration,
workflow, policy, or tool could satisfy the request.

1. Extract capability and constraints from the full request.
2. Generate one to four short lexical queries.
3. Run at most four `agentwheel search "<query>" --json --limit 10` calls.
4. Merge candidates by stable ID.
5. Treat CLI scores as retrieval signals, not semantic confidence.
6. Rerank against the original request using only result evidence.
7. Suggest zero to three artifacts.
8. Wait for explicit approval before any mutation.

Discovery is suppressed for explicit custom implementations, an already-selected or sufficient
installed artifact, weak matches, repeated suggestions without new evidence, or after four calls.

## Implementation Checklist

### Isolation and contracts

- [x] Verify the latest `origin/main` baseline.
- [x] Confirm Syncwheel tracking is `git-tracked`.
- [x] Create `feat/unified-artifact-search` in a dedicated worktree.
- [x] Register the `unified-artifact-search` Syncwheel stack.
- [x] Preserve the dirty original checkout.
- [x] Assign non-overlapping worker ownership.

### Catalogue and search core

- [x] Add enriched, compact, cache, entry, result, and response schemas.
- [x] Implement the catalogue client and atomic cache.
- [x] Implement normalization and deterministic merge.
- [x] Implement lexical scoring, filters, and stable ordering.
- [x] Add catalogue fixtures and focused tests.

### CLI

- [x] Add top-level `agentwheel search`.
- [x] Combine configured registries and selected catalogue sources.
- [x] Add human and JSON output.
- [x] Validate query, filters, limits, and cache flags.
- [x] Remove `agentwheel registry search`.
- [x] Remove only `RegistryClient.search()`.
- [x] Preserve registry resolution, update, list, and publish.
- [x] Add CLI tests.

### Agent behavior and documentation

- [x] Expand companion-skill discovery triggers.
- [x] Add bounded semantic query expansion and reranking instructions.
- [x] Add explicit mutation approval and suppression rules.
- [x] Replace skill examples using `registry search`.
- [x] Add a companion-skill contract test.
- [x] Document unified discovery in README and CHANGELOG.

### Validation and delivery

- [x] Run focused catalogue, CLI, skill, and registry tests.
- [x] Run `pnpm typecheck`.
- [x] Run the complete `pnpm test`.
- [x] Run `pnpm build`.
- [x] Smoke CLI help, registry help, JSON search, and removed command.
- [x] Run an independent blocking-only review.
- [x] Fix blocking findings once and rerun affected checks.
- [x] Review the scoped diff and confirm no unrelated files.
- [ ] Commit the implementation without a version bump.
- [ ] Record the commit range in Syncwheel.
- [ ] Validate and push the stack.
- [ ] Open a PR to `main`.

Validation note: full-catalogue warm-cache search is deterministic and successful, but measures
about 1.5 seconds wall-clock on the current container rather than the provisional sub-second target.
Avoiding that residual by duplicating the normalized catalogue in the cache increased the cache
from about 11 MiB to about 47 MiB and was rejected as a poor tradeoff for this delivery.

## Stop Condition

Stop when the unified search covers configured registries and both public datasets, the old search
is removed, the semantic workflow is present in the skill, required checks pass, and independent
review has no blocking findings. Embeddings, fuzzy search, optional filters, adjacent refactors,
runtime rollout, and release work are follow-ups rather than reasons to extend this delivery.
