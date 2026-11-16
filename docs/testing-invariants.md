# Invariant baseline and command attribution

Run `node scripts/test-command-matrix.mjs [output.json]` from the repository root after installing dependencies. Without an output argument, the report is saved under the operating system temporary directory. Parser scratch files also live there. The script runs the entire Vitest suite with the default reporter streamed to stdout/stderr; failures remain in the output and yield a nonzero exit. It loads the actual Commander tree with only its executable entrypoint removed, including root, groups and hidden commands. No command handler runs during inventory.

`scripts/test-command-map.json` currently links only three commands and is deliberately conservative: every link names exactly one runner-registered file/full-name pair and documents why that test covers the command. Imports and shared files do not imply command coverage. Add audited links as coverage is established; an unattributed test is not evidence of absent behavior. Unknown commands, missing or ambiguous cases, duplicate IDs and registration/result mismatches refuse generation. Parameterized cases remain individual runner IDs. Per-command counts overlap; only the union of IDs is a suite total. IDs are Vitest IDs, stable for the same runner/project/module/test order. The separate JSON reporter reconciles the overall count.

The report records input-byte and parser hashes, runner and Node versions. It excludes timing, absolute paths and stack traces. `unattributedCommands` lists commands with no declared test links; this is not a claim that their behavior is untested. Unattributed tests are explicitly listed to reconcile the full runner inventory. `it.fails` outcomes count as runner passes and carry `expectedFailure: true`; this is not proof that the invariant holds. Skipped and pending outcomes are separate from executed cases. Generated reports are observations of one environment and are not committed as a portable status baseline.

## Effects harness

`test/helpers/effects.ts` records file bytes in base64, permission bits, directories and symlink targets without following links. Explicit manifest paths record complete parsed claims as well as original bytes. With `git: true`, the snapshot also records the staged index (semantic entries and raw bytes), refs and symbolic HEAD; the filesystem tree includes raw Git metadata. Locks under the fixture root are included. Filesystem atime, mtime, ctime and birthtime are not recorded; all listed content and permission fields are compared exactly. There are no default path exclusions. A caller may exclude only an exact file or symlink path with a nonempty reason; directories are always traversed and manifest claims cannot be excluded. Compare snapshots with `diffEffects`; unknown changed paths remain visible. This is an isolated filesystem observer, not a syscall/network/process tracer.

## Expected failures

The invariant tests use synthetic fixtures and no live targets. Each expected-failure test has an adjacent ordinary test that checks the exact current defect, so a broken setup cannot masquerade as an expected failure. A product fix must remove that marker in the same change: an unexpected pass fails CI. Do not replace the marker with skip or todo.

| Invariant | Case | Observed defect |
| --- | --- | --- |
| I2 | `read_missing_git_preserves_cache` | Fetch removes an existing incomplete cache directory and its sentinel before a failing local clone. |
| I5 | `stale_merge_metadata_rejected_in_all_paths` | Preview accepts unchanged source with stale contribution metadata while apply rejects the contribution. |

An unreachable source during pin preflight produces a warning by design, not a defect: it does not prove a new artifact collision. The existing pin-preflight tests retain that intended behavior.
