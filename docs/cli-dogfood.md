# Real CLI regression checks

Run `pnpm build` followed by `python3 scripts/cli-dogfood.py`. The script uses
the freshly built CLI, two disposable runtime roots, and a local source package.
It verifies installation, updates, no-op planning, and profile recovery when
stable and legacy metadata disagree. The legacy fixture is derived from a real
installation. Recovery must preserve the unrelated legacy state; planning must
leave all observed files unchanged.

Each subprocess has a 45-second timeout and records elapsed time, exit status,
and output in the temporary evidence directory printed at startup. These are
small local smoke timings, not remote-fleet performance percentiles.
