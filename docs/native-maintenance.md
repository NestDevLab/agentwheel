# Native maintenance storage

When a registered fleet's repository depends on the tool being maintained, use
an independently reviewed Git checkout for configuration and graph-lock storage.
This is an explicit maintenance operation, not a provider bypass or a new owner.
The registered workspace root and fleet ID continue to own installed files,
runtime journals and receipts. Its existing mutation lock remains authoritative.

```sh
agentwheel --maintenance-source "$SOURCE" --maintenance-revision "$REVIEWED_SHA" \
  --reason "Install reviewed maintenance resources" \
  install example-pack --fleet example-fleet --profile daily --dry-run
```

Inspect the plan, then apply the same command without `--dry-run`. The global
options also support `pin`, `plan`, `status` and mutation recovery. They require
an existing `--fleet`; they do not register or transfer ownership. Composite
profiles must be qualified one owning workspace at a time.

Repository-local Git environment selectors must be unset; Agentwheel rejects
them rather than changing effective configuration or hooks. The canonical Git
root is frozen in the receipt and rechecked for normal operations and recovery.
The source must be clean, use a separate Git directory, and have no redirected
or executable commit/ref hooks. Its exact reviewed 40-hex revision must descend
from the registered workspace HEAD. Later commits may change only
`.agentwheel/config.json` and `.agentwheel/locks/**`; history that changes and
then reverts other files is rejected. Configuration and graph-lock storage may
not use symlinks. Fleet identity and runtime profiles must match the registered
configuration; package selections may differ. The source policy must require a
reason, journal and native Git commit-after-verify, with no no-commit override.

Agentwheel reads configuration and graph locks from the independent source,
commits only those paths there, and records that binding in its mutation receipt.
It rechecks the registered workspace's HEAD, configuration bytes and registration
before revisioning. A pending operation must be recovered with its original
source/revision binding. Recovery may reopen dirty configuration/lock paths only
with that original operation receipt; ordinary installs still require clean
source storage. It never changes the registered repository's refs,
index, configuration or hooks as part of this storage binding. Runtime installs
still require their ordinary plan, drift, ownership and verification checks.

Do not disable hooks or relax another repository's provider. Deliver and review
the source first, preserve rollback pins, and verify installed bytes and actual
subprocesses independently before declaring a maintenance rollout complete.
