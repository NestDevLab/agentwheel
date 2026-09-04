# Governed mutations and revision-provider protocol v1

Agentwheel workspace schema v4 can govern declarative mutations with a durable reason, receipt,
and optional Git revision. Runtime artifacts and install journals remain generated operational
state; only command-declared repository paths are eligible for revisioning.

## Policy

`mutationPolicy` is valid only in a schema-v4 `.agentwheel/config.json`:

```json
{
  "schemaVersion": 4,
  "mutationPolicy": {
    "reason": "required",
    "journal": "required",
    "revisioning": {
      "mode": "commit-after-verify",
      "allowNoCommitOverride": false,
      "reasonInCommit": "full",
      "provider": {
        "kind": "git",
        "id": "git",
        "protocolVersion": 1
      }
    }
  }
}
```

Providers are one of:

- `git`: Agentwheel's built-in exact-path Git provider.
- `command`: an absolute executable and fixed arguments in `command`. `executableSha256` pins the
  entrypoint, `timeoutMs` bounds it, and `trustBoundary: "entrypoint"` explicitly acknowledges
  that provider-owned imports or subprocesses are part of the external provider deployment trust
  boundary. On Linux, Agentwheel hashes the configured file, copies those exact verified bytes to
  a private mode-0700 directory, opens the snapshot read-only, unlinks it, and executes it through
  `/proc/self/fd`. Replacing, truncating, or rewriting the configured path after verification cannot
  change the executed bytes. Unsupported platforms fail closed. The pin covers only the executable
  entrypoint, not fixed arguments, imports, interpreters selected by a script, or subprocesses;
  those remain inside the explicitly declared provider deployment trust boundary. The provider runs
  in a dedicated process group, and timeout or output-limit enforcement kills the complete group.

User/global policy is the baseline for standard Agentwheel commands. A selected local or fleet
workspace may strengthen it and may select its own commit provider, but cannot turn off global
commit-after-verify, weaken a required reason or journal, or enable `--no-commit` when either
policy forbids it.

`--reason <text>` supplies the complete reason and `--operation-id <id>` supplies a stable
1-to-63-character correlation id matching `[A-Za-z0-9][A-Za-z0-9_-]*`. `--no-commit` is accepted
only for commit-after-verify policies that explicitly allow the audited override. It still runs
provider preflight and finalize and records `revisioning-skipped`.

## State machine

For a successful governed command:

1. Acquire one repository lock and persist a start receipt outside the repository under
   `~/.agentwheel/mutations` (or `AGENTWHEEL_MUTATION_STATE_ROOT`).
2. Snapshot HEAD, index safety, and pre-existing dirty paths; persist the prospective path
   declaration journal; call provider `check` while the operation has made no writes.
3. Run the command. Writers with statically known paths declare them before associated runtime
   apply. Commands whose exact declarative paths emerge only during planning require a completely
   clean working tree first. Initially dirty intended paths therefore fail before side effects.
4. Verify command-specific runtime and generated-state postconditions. A failed handler or failed
   postcheck is `partial` or `postcheck-failed` and is never eligible for ordinary finalize.
5. Compare the repository against the original snapshot. Reject changed pre-existing dirt and any
   newly dirty path outside the declaration journal. Record each exact before/after SHA-256.
6. Call provider `preflight`, then `finalize`. A provider or hook failure records
   `commit-pending`; `mutation finalize` or `mutation recover` retries without rerunning the
   command handler.

Apply journals written during governed installs use journal v2 and carry the operation id, reason,
and no-commit decision. This recovery contract also applies when journaling is required but Git
revisioning is off. A crash may leave a receipt-bound journal. `mutation recover-runtime` validates
the original HEAD and exact declarations when present without repeating clean-only provider
`check`, resumes the linked local journal, verifies its postconditions, then calls provider
`preflight` and `recover` when revisioning is enabled. Legacy v1 or differently owned journals
cannot be adopted by a governed operation.

Receipts use these terminal or actionable states: `succeeded`, `revisioning-skipped`,
`no-repository-delta`, `commit-pending`, `precheck-failed`, `partial`, and `postcheck-failed`.
Inspect them with `agentwheel mutation list` and `agentwheel mutation show <operation-id>`.

### Session ownership diagnostics

A clean-tree or repository-lock refusal remains a hard safety block. Agentwheel augments that
refusal from the read-only Agent Mesh graph projection when available; the graph never grants a
lease, removes a lock, or decides whether a caller may proceed.

Dirty repository paths are joined to graph nodes through opaque refs only:

```text
agentwheel-resource:<sha256(git-common-dir + NUL + normalized repository-relative path)>
```

The ref cannot be resolved back to a private path from graph state. Agentwheel names an owner only
when exactly one `active`, `waiting`, or `blocked` node has the exact ref. Duplicate live claims
remain `owner unknown` and list candidates; `quiet` and `closed` claims are inactive. A missing or
malformed projection, an inactive-only match, or no match also remains `owner unknown` and directs
the caller to inspect the session graph or ask the rollout coordinator before retrying. None of
these cases weakens the refusal.

New repository-lock metadata records the current runtime UUID when a supported harness exposes it.
On contention, the error includes structured operation, PID, runtime UUID, and creation-time facts,
then correlates the UUID to a session only on one exact live match. Older locks without a runtime
UUID remain valid and blocking; their diagnostic explains how to identify the owner safely.

## Wire contract

Every request is a strict JSON object with:

- `protocolVersion` (`1`), `action` (`check`, `preflight`, `finalize`, `recover`, or `release`)
- `operationId`, absolute `repositoryRoot`, `expectedHead`, and optional
  `expectedManifestDigest`
- `commandName`, the full `reason`, `noCommit`, and `paths`
- each path as normalized repository-relative POSIX `path`, `beforeSha256`, and `afterSha256`;
  either hash may be `null` for absence, but they must differ

`.git`, `.syncwheel/manifest.json`, and `.syncwheel/ledger` are provider control state and cannot
be product paths. Unknown fields, actions, or versions fail closed.

Every response contains `protocolVersion`, `providerId`, `action`, `operationId`, `ok`, and
`status`. Successful `finalize` and `recover` responses additionally contain `expectedHead`,
`resultingHead`, nullable `productCommitSha`, `draftStackId`, `draftBranch`, `draftTipSha`,
`controlCommitSha`, and `manifestDigest`, plus `unmappedIntegrationCommits` and literal
`published: false`. Rejected
terminal responses carry the same recovery fields, which may be null, and a bounded non-empty
`error`. Command providers use exit `0` for success and exit `2` for a structured rejection; any
JSON/exit-code inconsistency fails closed.

`check` succeeds only with `ready`. A first `preflight` normally returns `prepared`; an idempotent
replay may instead report `product_committed`, `stack_owned`, `control_committed`, or `verified`.
Terminal success is limited to `verified`, `already-verified`, `revisioning-skipped`, or
`no-repository-delta` as appropriate. Agentwheel correlates provider/action/operation identifiers
and verifies terminal HEAD leases, exact product paths and hashes, draft ownership completeness,
the exact local draft-branch tip, control-parent ancestry, empty/no-commit semantics, unpublished
state, and an empty unmapped-commit set before recording success. A successful draft handoff must
return stack, branch, draft tip, and control commit together; a rejected response may retain a
partial set to describe the last durable provider phase.

The canonical shared examples are in `test/fixtures/revision-provider-v1`. Provider
implementations should consume byte-equivalent fixtures or pin their published SHA-256 values.

## Built-in Git provider

The built-in provider requires an attached branch, unchanged HEAD, clean index, no conflicts or
in-progress merge/rebase/cherry-pick/revert, configured author and committer identities, and no
tracked `.syncwheel/manifest.json`. It constructs a temporary index from `expectedHead`, stages
only declared paths, runs executable `pre-commit`, `prepare-commit-msg`, and `commit-msg` hooks,
revalidates the exact index and full reason/trailers, creates the commit, and compare-and-swaps the
branch and real index. It does not reset, push, publish, or create an empty commit.

## Fail-closed boundaries

Commit-after-verify currently supports one Git repository per governed operation. Fleet
normalization spanning repositories and composite-profile install/update operations are refused
before mutation because Agentwheel does not yet have an atomic distributed receipt/commit
protocol. Split those changes into explicit single-repository operations or keep revisioning off
for that workflow. All governed remote runtime applies are refused before their first remote lock
or write until a durable remote recovery protocol exists. `mutation recover-runtime` handles linked
local journals only, including journal-required policies whose revisioning mode is off.

Receipt-to-runtime-journal links are published in two phases and include the transport identity and
an immutable journal-link digest. Missing journals are interpreted by their durable link phase:
reserved-before-create can be abandoned without adoption, pending is an error, and
resolving-after-delete can complete idempotently. Unsupported remote recovery is refused before a
runtime lock or journal write. Receipts carry a monotonic revision and canonical digest; every
transition rereads and compare-and-swaps those values, and runtime recovery rereads the receipt
after acquiring its mutation lock.

When a terminal response contains draft ownership with `published: false`, Agentwheel records the
draft stack, branch, projected tip, and control commit as `owned-but-unpublished`. Publication is
never automatic, and Agentwheel does not claim that a publication command exists. Inspect the
durable record and use only the provider's separately documented, authorized workflow. In
active-active coordination, a new provider `check` may intentionally fail while that ownership is
still unresolved.
