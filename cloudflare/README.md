# Catalogue preview Worker

The preview routes render social metadata and canonical links; the browser still
loads the current full catalogue from the registry. Runtime requests must never
download, parse, index or hash either complete catalogue.

## Asset build and freshness

Wrangler's custom build runs `node build-catalogue-assets.mjs` from this directory.
Run Wrangler from `cloudflare/` (or pass `--cwd cloudflare` from the repository
root), since custom build commands are relative to the invocation directory.
It fetches both public registry datasets and extracts only id, name (200 characters)
and description (512 characters). It creates 1,024 deterministic JSON shards and
copies the local catalogue HTML template into ignored `.catalogue-assets/`.
The build rejects shards over 64 KiB and templates over 256 KiB rather than shipping
unbounded request-time work. This uses 1,025 assets, including empty shards.

The `ASSETS` binding serves these files locally to the Worker. Every lookup parses
one shard, including on a cold isolate; a share redirect does not read the template.
The Worker runs before assets so internal asset paths are not public routes.
No full-catalogue network fallback exists: missing build assets return 503, and
resources absent from the built snapshot return 404.

**Preview metadata is now a deployment snapshot.** New entries, names and social
descriptions become available after rebuilding and deploying this Worker. Registry
updates alone do not update social previews; the browser catalogue remains live.
Before any separately approved deployment, build with current registry data and
check that representative recently added native and Vercel links resolve. This
change does not configure automatic deployment or change routes, DNS or billing.

## Verification

From the repository root:

```sh
pnpm exec vitest run test/catalogue-share-worker.test.ts test/catalogue-site.test.ts
node cloudflare/benchmark-catalogue-worker.mjs --baseline-ref origin/main
```

The benchmark compares the baseline Worker against the candidate with real public
datasets and in-memory responses, excluding network latency. It reports process
CPU for first calls and median/P95 across 30 measured calls. Baseline source must
be the revision before this optimization; after merge, supply that revision
explicitly. Optional `--catalogue /path/catalogue-data.json` and
`--vercel-index /path/catalogue-vercel-index.json` pin local fixtures. The builder
accepts those same two fixture paths as positional arguments for offline builds.

Local Node CPU is evidence of reduced work, not a guarantee of Cloudflare CPU time.
After an approved deployment, verify invocation CPU and resource failures in
Cloudflare metrics, including first requests and newly built resource links.
