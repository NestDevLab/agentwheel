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

Review the owner, target, source/destination keys, selected paths, full inventory revision and
plan digest. Apply the same selection, adding the reviewed values (use `absent` for a null revision):

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
the target lock and checks manifest revisions, the complete inventory, runtime hashes and runtime
snapshots again at each metadata commit. Drift, missing files, semantic commands/plugins, incomplete
merge ownership, overlapping claims and pending journals fail closed. Exact managed instruction
blocks and complete JSON/TOML/YAML merge contributions are verified using the existing ownership
checks. The full runtime file is guarded even when only one contribution is owned.

The destination commits first. If interrupted, recover the pending journal through the original
mutation receipt (`mutation recover-runtime <operation-id>`), then obtain a new plan. An exact
duplicate already in the destination is retired from the source without rewriting the destination.
An emptied source manifest and its old source lock are removed by the existing state cleanup.
An absent source yields an empty plan, so repeated migration is a no-op. A fresh digest is required
for each apply; do not reuse a pre-interruption plan.

## Operator validation on a snapshot copy

An operator first captures the runtime and `.agentwheel` into a separate readable snapshot using
their existing backup procedure. The checker below never opens a live service root. Pass only that
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
```

Each invocation creates a new disposable directory and prints its location. Only that copy's
manifest target roots and matching owner strings are rebased into an isolated plain workspace;
source/destination revisions and plan digests are then recomputed. The copy apply uses a durable
receipt, verifies all non-metadata bytes and modes, and proves the next plan selects nothing.
Keep the printed directory as evidence. This verifies copied legacy claims, not the live endpoint,
service permissions, fleet identity or a real install; the CLI and confined-worker tests cover those
contracts separately. Never copy this rebased metadata back to the real target.
