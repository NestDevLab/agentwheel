# Invariant baseline and command attribution

Run `node scripts/test-command-matrix.mjs [output.json]` from the repository root after installing dependencies. The script runs the entire Vitest suite; failures remain in the output and yield a nonzero exit. It loads the actual Commander tree with only its executable entrypoint removed, including root, groups and hidden commands. No command handler runs during inventory.

`scripts/test-command-map.json` is deliberately conservative: every link names exactly one runner-registered file/full-name pair and documents why that test covers the command. Imports and shared files do not imply command coverage. Add audited links as coverage is established; an unattributed test is not evidence of absent behavior. Unknown commands, missing or ambiguous cases, duplicate IDs and registration/result mismatches refuse generation. Parameterized cases remain individual runner IDs. Per-command counts overlap; only the union of IDs is a suite total. IDs are Vitest IDs, stable for the same runner/project/module/test order. The separate JSON reporter reconciles the overall count.

The report records input-byte and parser hashes, runner and Node versions. It excludes timing, absolute paths and stack traces. Unattributed tests are explicitly listed to reconcile the full runner inventory. `it.fails` outcomes count as runner passes and carry `expectedFailure: true`; this is not proof that the invariant holds. Skipped and pending outcomes are separate from executed cases. Generated reports are observations of one environment and are not committed as a portable status baseline.

## Effects harness

`test/helpers/effects.ts` records file bytes in base64, permission bits, directories and symlink targets without following links. Explicit manifest paths record complete parsed claims as well as original bytes. With `git: true`, the snapshot also records the staged index (semantic entries and raw bytes), refs and symbolic HEAD; the filesystem tree includes raw Git metadata. Locks under the fixture root are included. Filesystem atime, mtime, ctime and birthtime are not recorded; all listed content and permission fields are compared exactly. There are no default path exclusions. A caller may exclude only an exact file or symlink path with a nonempty reason; directories are always traversed and manifest claims cannot be excluded. Compare snapshots with `diffEffects`; unknown changed paths remain visible. This is an isolated filesystem observer, not a syscall/network/process tracer.

## Expected failures

The invariant tests use synthetic fixtures and no live targets. Each assertion is first reproduced as an ordinary failing test, then marked `it.fails`. A product fix must remove that marker in the same change: an unexpected pass fails CI. Do not replace the marker with skip or todo.

| Invariant | Case | Observed defect |
| --- | --- | --- |
| I2 | `read_missing_git_preserves_cache` | Fetch removes an existing incomplete cache directory and its sentinel before a failing local clone. |
| I5 | `stale_merge_metadata_rejected_in_all_paths` | Preview accepts unchanged source with stale contribution metadata while apply rejects the contribution. |
| I7 | `pin_provenance_and_feature_floor_enforced` | Unresolvable local pin emits a warning and returns successfully. This case covers unreachable pins only. |
