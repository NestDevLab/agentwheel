# Migrate current-owner legacy state

`ownership migrate-legacy` moves verified entries already owned by the current workspace (or
its registered fleet) from an explicitly selected old manifest into the state key that configured
`install` uses. It does not change owners, graph locks, workspace configuration, or runtime files.
Use `ownership handoff` separately when the owner must change. No historical graph lock is required.

```bash
cd /path/to/governing-workspace
agentwheel ownership migrate-legacy --local --agent example \
  --source-state-key openclaw.user.old-key --json > /tmp/migration-plan.json
```

A registered fleet can instead use `--fleet example`. Choose one agent or one profile resolving to
one target. Configured packages must resolve to one adapter configuration and installation type.
The destination is calculated exactly as for install, including explicit configured state keys.
Use repeatable `--path relative/path` to select a subset; otherwise all current-owner entries move.
Other owners' source entries remain untouched.

The plan computes desired coverage from the current graph, as `ownership adopt-legacy` does, and
records it in the plan JSON and digest. Each selected entry reports whether the configured packages
still install it. An entry the graph no longer installs is refused by default: after migration the
next `install` would treat it as stale and remove its runtime files. Pass `--allow-undesired` only
when that removal is intended or the configuration will be updated first; the flag is part of the
digest, so plan and apply must agree on it. An entry whose path the graph assigns to a different
artifact is always refused. A destination manifest that is absent next to a stable graph lock is
refused too; reconcile that orphan lock before migrating.

Review the owner, target, source/destination keys, selected paths, full inventory revision and
plan digest. Apply the same selection, adding the reviewed values (use `absent` for a null revision).
The plan's `applyCommand` prints the exact command, including `--reason`:

```bash
agentwheel ownership migrate-legacy --local --agent example \
  --source-state-key openclaw.user.old-key \
  --plan-digest "$(jq -r .planDigest /tmp/migration-plan.json)" \
  --expected-source-revision "$(jq -r '.source.revision // "absent"' /tmp/migration-plan.json)" \
  --expected-destination-revision "$(jq -r '.destination.revision // "absent"' /tmp/migration-plan.json)" \
  --expected-inventory-revision "$(jq -r .manifestInventoryRevision /tmp/migration-plan.json)" \
  --apply --reason 'Migrate reviewed current-owner claims'
agentwheel install --local --agent example --dry-run --format json
```

Apply requires an effective `mutationPolicy` with `journal: "required"` (revisioning may be `off`
or `commit-after-verify`) and a durable receipt for the governing workspace. Without it, apply
refuses before touching target metadata. This ensures both destination and source journals have
a recovery path through `mutation recover-runtime <operation-id>`; keep the operation ID from
the command's mutation receipt output.

Local-run-as targets use the same command and pinned identity checks. Apply runs through the normal
GovernedMutation receipt and confined worker; SSH is unsupported. Planning is read-only. Apply takes
the target lock, re-reads both manifests and refuses unless their revisions still equal the plan's,
then checks the complete inventory, runtime hashes and runtime
snapshots again at each metadata commit. Drift, missing files, semantic commands/plugins, incomplete
merge ownership, overlapping claims and pending journals fail closed. Exact managed instruction
blocks and complete JSON/TOML/YAML merge contributions are verified using the existing ownership
checks. The full runtime file is guarded even when only one contribution is owned.

The destination commits first. If interrupted, recover the pending journal through the original
mutation receipt (`mutation recover-runtime <operation-id>`), then obtain a new plan. An exact
duplicate already in the destination is retired from the source without rewriting the destination.
An emptied source manifest and its old source lock are removed by the existing state cleanup.
An absent source yields an empty plan, so repeated migration is a no-op. With `--path`, a path that
is already absent from the source and present in the destination with a verified current-owner
entry is listed under `alreadyMigrated` and selects nothing, so the same command can be rerun. A
path missing from both manifests, or owned by another workspace, is still refused. A fresh digest
is required for each apply; do not reuse a pre-interruption plan.

## Operator validation on a snapshot copy

An operator first captures the runtime and `.agentwheel` into a separate readable snapshot using
their existing backup procedure, with no install or migration running. The checker refuses a
snapshot that holds a runtime apply lock or a pending apply journal. It only reads the snapshot
root it is given and never resolves a live service root itself; keeping the live root out of
`--snapshot-root` is the operator's responsibility. Pass only that
snapshot, an exact old state key, and the exact current owner string from the snapshot (after any
separately reviewed handoff). A metadata-only snapshot is insufficient: include every claimed
runtime path needed to verify hashes and merge contributions.

```bash
python3 scripts/legacy-migration-copy-check.py \
  --snapshot-root "$SNAPSHOT_ROOT" --source-state-key "$SOURCE_STATE_KEY" \
  --current-owner "$CURRENT_OWNER" --cli "$PWD/dist/index.js"
python3 scripts/legacy-migration-copy-check.py \
  --snapshot-root "$SNAPSHOT_ROOT" --source-state-key "$SOURCE_STATE_KEY" \
  --current-owner "$CURRENT_OWNER" --cli "$PWD/dist/index.js" --apply
python3 scripts/legacy-migration-copy-check.py \
  --snapshot-root "$SNAPSHOT_ROOT" --source-state-key "$SOURCE_STATE_KEY" \
  --current-owner "$CURRENT_OWNER" --cli "$PWD/dist/index.js" --apply \
  --path relative/path
```

Each invocation creates a new disposable directory and prints its location. The CLI runs with a
minimal environment (`PATH`, `HOME` set to the copy, and the isolated mutation state root); on a
failure its stderr and stdout are printed before the checker exits. Repeatable `--path` is passed
through unchanged, and the rerun must report exactly those paths as already migrated. The copy is
an isolated empty workspace with no configured packages, so the checker always passes
`--allow-undesired`; desired coverage is verified only by the real plan. Only that copy's
manifest target roots and matching owner strings are rebased into an isolated plain workspace;
source/destination revisions and plan digests are then recomputed. The copy apply uses a durable
receipt, verifies all non-metadata bytes and modes, and proves the next plan selects nothing.
The printed directory is a full copy of the runtime snapshot and may hold the same sensitive files;
review it, then remove it. This verifies copied legacy claims, not the live endpoint,
service permissions, fleet identity or a real install; the CLI and confined-worker tests cover those
contracts separately. Never copy this rebased metadata back to the real target.

## Proposal: retire one covered stale claim

A legacy manifest can contain a superseded skill claim alongside claims that still own live
artifacts. When the stable manifest already covers the selected path, add one optional exact
`--path` selector to `ownership retire-stale`. Keep the existing destination coverage checks.
The selected claim must be uniquely identified by the source state key, artifact identity,
owner and path. The stable destination must prove the same artifact and current runtime
content. A shared artifact also needs proof of all selected contributions. Refuse ambiguous
overlaps, missing coverage, drift, pending journals, and symlink or identity mismatches.

Bind the path, source and destination revisions, full inventory revision, and runtime evidence
to the plan digest. During apply, acquire the existing target lock and revalidate those
snapshots before the source manifest compare-and-swap. Preserve other entries byte-for-byte
at the entry level. Preserve the destination manifest, runtime bytes and workspace declarations.
Retain the source lock while its manifest still has entries. Reuse the existing transaction
journal, recovery and empty-manifest cleanup.

Acceptance cases should include two covered claims with one selected, a sibling that lacks
coverage, a changed runtime or inventory between plan and apply, and an intervening ownership
change. A target with no covering destination needs a separate migration or handoff.
