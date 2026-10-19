# Release an ownership claim

`agentwheel ownership release-claim` retires one explicit plain file or directory entry from
an existing install manifest. It preserves the runtime contents, package declarations, sibling
entries, source lock, and the source manifest even when that manifest becomes empty. It does not
certify provenance or change the entry's recorded hash to disguise drift.

Use it only after reviewing the current claim and preserving any necessary recovery evidence.
Releasing the claim leaves the runtime artifact unmanaged until a later ordinary adoption.
Shared paths, overlapping claims, merge contributions, managed instruction blocks, semantic
artifacts, and symlink paths are refused. Targets must use the local filesystem transport.

Plan first, specifying the exact adapter target, state key, installation type, owner, selector,
path, and reason. The selector is the entry's `artifactType/artifactName`; its full logical
selector and entry contents are also included in the reviewed plan.

```sh
agentwheel ownership release-claim skills/example \
  --agent local-assistant --installation-type local \
  --state-key codex.local.example-target \
  --from-workspace-root /work/example \
  --path .agents/skills/example \
  --reason "Release the reviewed obsolete ownership claim" --json
```

For a Fleet-qualified owner, also pass `--from-fleet-id <id>`. `--fleet <id>` selects the
governing workspace; it does not silently choose the claim's current owner.

Repeat the same scope and reason with `--apply`, `--plan-digest <planDigest>`,
`--expected-source-revision <source.revision>`, and
`--expected-inventory-revision <manifestInventoryRevision>` from that plan. Any runtime byte
or mode change, including ignored cache files, invalidates the plan. Changes to any install
manifest in the target inventory also invalidate it. Planning writes no audit, config, or
runtime state.

The apply uses the effective mutation policy and provider check. It writes a declared immutable
intent dossier at `.agentwheel/ownership-releases/<operation-id>.json` inside the governing
workspace. The dossier records the reason, reviewed plan, original entry, and actual runtime
hash separately. Under commit-after-verify the path must be eligible for normal Git tracking;
an ignored dossier is refused before ownership changes. Agentwheel never changes ignore policy
or provider policy to make the command pass.

The native runtime journal binds the dossier contents and the reviewed state. An exclusive audit
file is created before manifest retirement. An interrupted write remains partial, with its
journal and mutation receipt intact. `agentwheel mutation recover-runtime <operation-id>`
can finish a governed operation only while the runtime, inventory, manifest, and audit still
match its exact recorded before/after states. Recovery never overwrites a concurrent change.
The dossier alone records intent, not completion: inspect the install state and resolved
mutation receipt. Audit transactions cannot be discarded with `journal abort`.

## Adopt an unmanaged destination

`agentwheel plan --adopt` and `agentwheel install --adopt` expose ordinary adoption for
unmanaged destinations. Matching unmanaged contents may be claimed without replacement;
differing unmanaged contents may be replaced with the selected source. Managed instruction
blocks preserve text outside their block, including an existing user prefix. Review the plan
before applying:

```sh
agentwheel install --agent local-assistant --adopt --dry-run
agentwheel install --agent local-assistant --adopt
```

This uses the existing unmanaged adoption semantics of `skill update --adopt`. It does not
allow managed drift or foreign ownership to be overwritten. Existing force options retain their
behavior; `--adopt` never enables `forceDrift` or `forceForeignState`.
