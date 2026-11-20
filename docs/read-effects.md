# Status observation and explicit refresh

`status` now observes local state and existing caches by default, regardless of cache TTL. `status --refresh` explicitly permits cache population, source fetches, snapshot maintenance, version discovery and composite member refresh. `--offline` wins over `--refresh`. Missing or stale evidence remains visible in the status protocol instead of causing an implicit refresh. Useful cached Git snapshots and local sources still support pending-work inspection; an absent cached snapshot returns a named refresh requirement.

## Consumer behavior change and cache refresh responsibility

Previously, a status read could refresh expired member and package-version caches automatically. It no longer does. The default `fleet-diagnostics` wrapper forwards an observation to `status`; after the member or version TTL expires it therefore shows stale evidence (`STALE`, or a degraded status derived from stale package metadata) until an explicit refresh succeeds. Repeated diagnostics reads do not make those caches fresh. Missing caches stay missing and are reported as unavailable.

The operator or caller requesting fresh evidence now owns the refresh: run `agentwheel status` with the **same workspace/fleet and profile selectors** plus `--refresh`, or explicitly opt into the diagnostics caller's existing `--refresh` option. The refresh path updates the member-report and version-index caches; subsequent default reads consume those caches without extending their freshness. No background refresher, timer, or new automated refresh owner is added here. Any change to fleet-control consumers or their refresh schedule is a separate maintainer decision and follow-up; this PR does not change fleet-control.

For example, `agentwheel status --fleet example-fleet --profile example-profile --refresh --json` refreshes that selected scope. `--offline` must be omitted when refreshing. Existing mutating commands retain their own cache behavior; this change concerns the read route.

## Effect policy

The AsyncLocalStorage scope in `src/effects/read-policy.ts` centralizes this distinction across graph sources, registry/version indexes, member reports, and cache writers. Observation never creates cache leases or maintenance locks and does not prune snapshots. Incomplete checkout directories are preserved even during refresh: repair is a separate explicit operation. The error identifies the exact checkout directory to move into a new backup location outside its cache directory. Confirm the original checkout path is absent, then rerun the same scoped command with `--refresh` to clone it again. Do not overwrite existing backups. No repair command or automatic move/removal is provided. Git status disables optional index locks. The optional update notifier does not fetch or persist on status reads.

Observation supports built-in local targets and cached composite reports. Unqualified programmatic adapters, source drivers other than local/Git, and direct remote transports refuse before execution; explicit refresh retains their existing admission and execution paths. This deliberately avoids promising zero effects for arbitrary executable code. Other CLI read/preview verbs have not yet been qualified by this batch.

Diagnostics consumers of the versioned `status --json` protocol inherit this policy. Tests exercise a synthetic child-process consumer, not a private fleet configuration. No fleet diagnostics source is changed by this PR.

`scripts/agentwheel-local.mjs` is the generic source-owned local launcher. It requires a prebuilt, current `dist/index.js`, or refuses with an explicit build instruction. It never runs a package manager, acquires a build lock, or builds implicitly, for any verb. `AGENTWHEEL_REPO_DIR` selects a checkout; the default is the repository containing the launcher. This PR does not replace any installed wrapper or retarget a runtime launcher.

## Evidence and limits

The B0a effects helper is reused from PR #201; this PR is based on that branch. Before the product changes, synthetic status fixtures reproduced clone/fetch/tag queries, persistent cache leases and version-index writes, global pruning when a newer source commit creates a snapshot, and removal of a sentinel from an incomplete checkout. A separately isolated legacy-launcher probe reproduced one implicit build on a status invocation with a dummy builder. That launcher was unversioned: the replacement above establishes a source-owned implementation without copying host-specific defaults into public source.

The fixture snapshots synthetic HOME, workspace, cache, Git metadata and temp before/after each invocation. A child preload records process calls and rejects Node network APIs; only its exact evidence file is excluded from tree comparison. Tests cover cold/warm/offline/refused reads, a diagnostics protocol consumer, wrapper admission, and explicitly bounded refresh writes. External Git network access is checked through command arguments; this is an application-boundary trace, not a kernel syscall sandbox. Concurrent refresh/prune versus a lease-free observer remains a separate cache-lifecycle qualification concern: observation may report missing evidence but cannot repair or delete it.
