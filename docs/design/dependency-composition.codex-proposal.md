# agentwheel Dependency + Composition Design Proposal

Status: proposal only. No source changes.

## Executive Recommendation

Add a dedicated dependency resolver between source staging and install planning. Keep `SourceDriver`
focused on `resolve / fetch / list / export`; add a new graph layer that reads package manifests,
recursively resolves `requires`, stages each resolved package once, composes selected artifacts at
sync time, then hands a single flattened `StagedBundle`-like output to `createInstallPlan`.

For install layout, do not pretend flat runtime directories can behave like `node_modules`. They
cannot. The runtime-visible namespace is flat and agent-readable, so the resolver should use two
levels of identity:

- logical identity: `packageName@version type/name`, used for dependency solving and lockfiles;
- install identity: the final runtime path/name, chosen by a deterministic namespace policy.

Default install behavior should be stable and readable: direct/root package artifacts keep their
plain names; transitive dependency artifacts are installed only when selected or needed at runtime,
and if they would collide they are namespaced as `<safePackageName>--<artifactName>` or, for
directories, a metadata-bearing directory with the same name. This makes conflicts satisfiable
without silent overwrites. For composition, prefer sync-time transclusion into self-contained
installed artifacts, with provenance comments and source maps in the manifest. Runtime references
should be optional only for agents that natively support them, because most agents just read
Markdown files.

The first shippable slice should support package-level and artifact-level `requires`, exact/pinned
git refs, simple semver ranges for manifest `version`, graph lock/provenance, transclusion from
already-resolved artifacts/fragments, and refcount-aware uninstall. Deeper npm-style nested solving
can arrive next, but the data model should be ready for it from day one.

## Current System Anchors

The current code has clean places to extend:

- `src/model/package.ts` defines `packageManifestSchema` with `schemaVersion`, `name`, `version`,
  and `provides[]`. Each `PackageProvide` currently has `type`, `path`, optional `assets`, and
  optional `required`.
- `src/model/artifact.ts` defines `ArtifactType`, `PackageAsset`, and `Artifact`. An artifact has
  `type`, `name`, `sourcePath`, `relativePath`, `kind`, `hash`, optional `packageName`, optional
  `assets`, optional `required`, and `channel: managed|overlay|addition|override|ejected`.
- `src/model/workspace.ts` stores `.agentwheel/config.json` packages as `WorkspacePackage` entries
  with `name`, `source`, `driver`, `adapter`, `mode`, `requestedRef`, `select`, and legacy `skills`.
- `src/lifecycle/source-plan.ts` has `createSourcePlan`, which currently resolves exactly one source,
  calls `stageSource`, reads the install manifest, then calls `createInstallPlan`.
- `src/staging/staging.ts` turns one source into one `StagedBundle` with `root`, `source`,
  `artifacts`, and `sourceLock`. It already composes `assets` into directory artifacts before
  hashing.
- `src/install/plan.ts` is path-keyed: desired operations are keyed by `relativeDestPath`, and flat
  path collisions become `conflict` if a destination exists but is not managed.
- `src/model/manifest.ts` has `InstallManifestEntry` with `path`, `artifactType`, `artifactName`,
  `hash`, `sourceHash`, `channel`, and optional `packageName`; `SourceLock` records the one source
  resolved in the current model.
- `src/install/uninstall.ts` removes manifest entries, keeping drifted entries unless forced.
- Customization is already explicit: `remember` writes overlays, `ejectArtifact` copies an artifact
  into `.agentwheel/ejected/<package>/<type>/<name>`, and `applyCustomizations` applies
  `override`, `ejected`, `addition`, and instruction `overlay` channels during staging.

My proposal keeps that architecture. Dependencies and composition should not be shoved into
adapters, nor into every source driver. They belong in a resolver/lifecycle layer that can emit the
same artifact/install abstractions the rest of agentwheel already understands.

## Design Goals

1. Make dependencies satisfiable, not fragile. Compatible versions dedupe. Incompatible versions can
   coexist through deterministic install namespacing.
2. Preserve agent UX. Installed artifacts should still look like normal skills, rules, commands,
   and instructions where possible.
3. Preserve author UX. Package authors should declare dependencies in `agentwheel.jsonc` using
   JSONC, not a separate package manager DSL.
4. Preserve runtime compatibility. Because most agents read plain Markdown and directories, composed
   output should be self-contained by default.
5. Preserve local ownership. Overlays, overrides, ejections, drift detection, uninstall, and update
   should continue to work with dependency-installed artifacts.
6. Avoid central registry lock-in. Dependencies can come from any current source string:
   `github:`, `git:`, `skillkit:`, `vercel:`, local paths, or registry short names.

## Manifest Schema Changes

Keep `schemaVersion: 1` if these fields are optional and ignored by older versions, but emit a
feature warning for older CLIs. Move to `schemaVersion: 2` only if validation must reject older
semantics. I recommend adding optional fields under v1-compatible parsing first, then cutting v2
once the resolver stabilizes.

### Package-Level Dependencies

```jsonc
{
  "schemaVersion": 1,
  "name": "nestdevlab/agent-mesh",
  "version": "0.4.0",
  "requires": {
    "nestdevlab/core-rules": {
      "source": "github:NestDevLab/core-rules",
      "version": "^1.2.0",
      "mode": "tracking",
      "select": ["rules/safe-actions.md", "rules/no-secret-leakage.md"]
    },
    "francesco/toolkit": {
      "source": "github:FrancescoBorzi/agent-toolkit#main",
      "version": ">=0.1.0 <1.0.0",
      "select": ["skills/run-nx-checks"]
    }
  },
  "provides": [
    { "type": "instructions", "path": "instructions/AGENTS.md" },
    { "type": "rules", "path": "rules" },
    { "type": "skills", "path": "skills" }
  ]
}
```

Use object keys as dependency aliases, like npm package names. The alias is stable within the
declaring manifest and can be used in composition references. Required fields:

- `source`: any existing agentwheel source string or registry name.
- `version`: semver range against the dependency package manifest `version`; initially allow exact
  strings and semver ranges. If a package has no parseable semver, only exact match or `*` works.

Optional fields:

- `select`: artifact selectors using current `<type>/<name>` grammar.
- `mode`: `pinned|tracking`, same semantics as `WorkspacePackage`.
- `ref`: source ref override, equivalent to `#ref` where the driver supports it.
- `optional`: if true, missing or incompatible dependency is a warning unless selected content
  composes it directly.
- `trust`: see security section.

### Artifact-Level Dependencies

Package-level `requires` says, "this package uses these packages." Artifact-level `requires` says,
"this specific skill/rule needs these things if the artifact is selected."

```jsonc
{
  "type": "skills",
  "path": "skills",
  "assets": [{ "from": "shared/bin", "into": "bin", "mode": "preserve" }],
  "items": {
    "run-nx-checks": {
      "requires": [
        "rules/no-nonsense-comments.md",
        "nestdevlab/core-rules:rules/safe-actions.md",
        { "package": "nestdevlab/build-tools", "select": ["commands/nx.md"] }
      ]
    }
  }
}
```

Today `PackageProvide` describes a whole path. It does not have per-item metadata. Add optional
`items` keyed by discovered artifact `name`. This is better than adding sidecar metadata files into
each skill directory because it keeps the package contract in one manifest and works for files and
directories.

Selector grammar:

- local artifact: `rules/no-nonsense-comments.md`
- dependency artifact: `<depAlias>:<type>/<name>`
- package-level object: `{ "package": "<depAlias>", "select": ["skills/foo"] }`

### Fragments and Composition Sources

Add a new artifact type `fragments` only if we want fragments to be visible/listable/installable.
My recommendation: add `fragments` as a manifest-only type that is stageable and lockable but not
installed by default unless a runtime adapter explicitly supports it. That keeps SSOT pieces
addressable without polluting runtime dirs.

```jsonc
{
  "schemaVersion": 1,
  "name": "nestdevlab/core-agent-pack",
  "version": "1.3.0",
  "provides": [
    { "type": "fragments", "path": "fragments" },
    {
      "type": "skills",
      "path": "skills",
      "items": {
        "triage-pr": {
          "compose": [
            { "include": "fragments/review-style.md" },
            { "include": "fragments/github-safety.md" },
            { "include": "nestdevlab/core-rules:fragments/risk-rubric.md" }
          ]
        }
      }
    }
  ]
}
```

If adding an artifact type feels too wide, call them `partials` under a `compose.sources` field
instead. I prefer `fragments` because it becomes first-class in locks, provenance, and diagnostics.

### Inline Composition in Files

Support both manifest-declared composition and inline include markers. Manifest-declared is better
for validation; inline markers are better for authoring and local readability.

Markdown marker:

```md
<!-- agentwheel:include fragments/github-safety.md -->
<!-- agentwheel:include nestdevlab/core-rules:fragments/risk-rubric.md -->
```

Strict rule: include markers are resolved only inside staged package content. Included paths cannot
escape the package root. Cross-package includes must target resolved dependency aliases.

## Resolution Model

Introduce a graph resolver with these conceptual types:

```ts
type PackageIdentity = {
  name: string;
  version: string;
  source: string;
  driver: SourceDriverName;
  resolvedCommit?: string;
  sourceHash?: string;
};

type Requirement = {
  from: PackageIdentity | "workspace";
  alias: string;
  source: string;
  range: string;
  select?: string[];
  mode?: "pinned" | "tracking";
  optional?: boolean;
};

type ResolvedNode = {
  id: string;              // name@version+sourceDigest
  identity: PackageIdentity;
  parent?: string;         // for nested conflict placement
  depth: number;
  selected: Set<string>;   // artifact selectors
  requiredBy: string[];    // node ids / workspace package names
  bundle: StagedBundle;
};
```

The public output should be a `ResolvedGraphBundle`, not a plain single-source `StagedBundle`:

```ts
type ResolvedGraphBundle = {
  root: string;
  nodes: ResolvedNode[];
  artifacts: Artifact[];          // install-ready, renamed/composed as needed
  graphLock: GraphLock;
};
```

Then `createInstallPlan` can either accept `ResolvedGraphBundle` directly or the graph layer can
emit a compatibility `StagedBundle` with a richer `sourceLock`. Long term, make the richer type
explicit.

## Npm-Style Resolution Algorithm

### Step 1: Seed Roots

Roots come from:

- CLI `agentwheel sync <source>`;
- configured `.agentwheel/config.json` `packages[]`;
- profile sync package entries;
- dependencies of those roots.

Each root gets a dependency context. The root package's selected artifacts come from CLI/config
`select` plus any `required: true` artifacts, using current `filterArtifactsBySelection` behavior.

### Step 2: Fetch and Read Manifests

For each requirement:

1. `resolvePackageSource` resolves registry short names.
2. `inferSourceDriverName` / configured driver picks the `SourceDriver`.
3. The driver resolves and fetches. For git, `GitSourceDriver.fetch` already records
   `resolvedCommit`, `packageName`, `packageVersion`, and `sourceHash`.
4. Read `agentwheel.json(c)` using the existing `readPackageManifest`.
5. Validate the package manifest name and version.

Do not stage every version candidate repeatedly. Cache fetched manifests by
`driver + source + requestedRef/resolvedCommit + sourceHash`.

### Step 3: Semver Compatibility

Current manifest `version` is `z.string().min(1)`. That is fine for metadata, but dependency
resolution needs a normalized interpretation:

- If `version` parses as semver, ranges use npm semver rules.
- If it does not parse, only exact equality and `*` match.
- Git ref pinning is separate from manifest version. `github:org/repo#abc123` can satisfy
  `version: "^1.0.0"` only if the fetched manifest says `1.x`.

Recommended dependency fields:

- `version`: semver range over manifest version.
- `ref`: source-level ref. If present, it constrains the fetch candidate.
- `integrity`: optional content hash for security/reproducibility.

### Step 4: Deduplicate / Hoist

For each dependency requirement, the resolver tries:

1. Reuse an already resolved ancestor or root node with the same package name whose version satisfies
   the range and whose source is compatible.
2. Reuse any graph node at the lowest depth that satisfies the range and source.
3. Fetch/resolve a new node.

"Source compatible" should be conservative:

- Same explicit source URL/registry entry is compatible.
- Different source strings with the same normalized git remote and same package manifest `name` are
  compatible.
- Different sources with the same manifest `name` are not automatically compatible unless the lock
  proves same resolved commit or same integrity.

This is npm-like hoisting: dependencies are shared when compatible. Unlike npm, the output target is
flat, so hoisting affects logical graph sharing, not necessarily runtime path layout.

### Step 5: Nested Conflicts

If two requirements for `foo` are incompatible, both resolve:

```text
root-a
  foo@1.4.0
root-b
  foo@2.1.0
```

There is no physical `node_modules/root-a/node_modules/foo` in Claude's `~/.claude/skills`.
Instead, "nested" means logical ownership and deterministic install namespacing:

- Artifacts from hoisted/shared deps can use plain names only if no root/direct artifact owns that
  name and no same-type collision exists.
- Artifacts from non-hoisted conflicting deps are installed under a dependency-scoped name.

For directory artifacts:

```text
.claude/skills/run-nx-checks
.claude/skills/nestdevlab-core-rules--policy-check
.claude/skills/foo-v2-1-0--policy-check
```

For file artifacts:

```text
.claude/rules/no-nonsense-comments.md
.claude/rules/nestdevlab-core-rules--safe-actions.md
.claude/rules/foo-v2-1-0--safe-actions.md
```

Use the shortest stable suffix that avoids collision:

1. `artifactName` if unique and root/direct.
2. `<packageSlug>--<artifactName>` if unique.
3. `<packageSlug>@<major-or-version>--<artifactName>` if package slug conflicts.
4. `<packageSlug>@<version>+<shortSourceHash>--<artifactName>` as the final fallback.

This is not as pretty as npm's nested directories, but it is honest about runtime constraints and
keeps conflicts satisfiable.

### Step 6: Selection Propagation

Selections matter because installing every transitive artifact from every dependency will pollute
runtime dirs.

Rules:

- A root package installs its selected artifacts, plus `required: true` artifacts.
- A package-level dependency installs only its declared `select`, plus that dependency's
  `required: true` artifacts.
- Artifact-level dependencies install only the referenced artifacts needed by selected parent
  artifacts.
- Composition-only fragments are staged and locked but not installed unless selected explicitly or
  the adapter supports fragment targets.

This gives package authors control while avoiding transitive sprawl.

### Step 7: Cycle Detection

Track cycles at two levels:

- package graph cycles: `A requires B requires A`;
- composition cycles: `fragment x includes y includes x`.

Package cycles are allowed only if no new unsatisfied artifact selection is introduced while
re-entering the ancestor. In practice:

- If a requirement points to an already active ancestor and its version range is satisfied, reuse it.
- If it requires additional artifacts not yet selected, add those selectors to the ancestor and
  continue fixed-point resolution.
- If fixed-point resolution exceeds a small iteration cap or produces incompatible ranges, fail with
  a cycle diagnostic.

Composition cycles should be fatal and easy to explain:

```text
Composition cycle:
  nestdevlab/core:fragments/a.md
  -> nestdevlab/core:fragments/b.md
  -> nestdevlab/core:fragments/a.md
```

## The Flat-Namespace Problem

This is the hard part. npm can put incompatible packages under different nested `node_modules`.
agentwheel writes into shared runtime paths like:

- `.claude/skills/<name>`
- `.codex/skills/<name>`
- `.github/instructions/<name>`
- `.claude/rules/<file>.md`

Agents generally discover by file/directory name. Many do not understand nested package metadata.

### Rejected Option: First Wins

Crude first-wins is unacceptable. It makes install order observable, hides missing dependencies, and
turns conflicts into runtime ambiguity.

### Rejected Option: Always Fatal

Fatal conflicts are safe but too weak. The mission explicitly wants conflicts to be satisfiable.
Also, cross-repo ecosystems will commonly reuse names like `review`, `test`, `safety`, or
`git-workflow`.

### Recommended Option: Deterministic Runtime Namespacing

Add `installName` / `installRelativePath` to the resolved artifact before planning. Keep original
`Artifact.name` as author identity; add metadata for logical identity. Existing `operationForArtifact`
can then use the install name.

Conceptual addition:

```ts
type ResolvedArtifact = Artifact & {
  packageName: string;
  packageVersion: string;
  graphNodeId: string;
  originalName: string;
  installName: string;
  logicalSelector: string; // package@version:type/name
  dependencyRole: "root" | "direct" | "transitive" | "fragment";
};
```

The install planner remains path-keyed, but paths are now pre-disambiguated. If even the
namespaced path conflicts with an unmanaged file, keep current `conflict` behavior.

### UX Naming Policy

Default:

- Root package artifacts keep plain names.
- Direct dependency artifacts keep plain names only when no collision exists.
- Transitive dependency artifacts get package-scoped names if installed into runtime-visible dirs.
- Composition-only fragments are not installed.

Users can override:

```jsonc
{
  "packages": [
    {
      "name": "mesh",
      "source": "github:NestDevLab/agent-mesh",
      "adapter": "claude",
      "aliases": {
        "nestdevlab/core-rules:rules/safe-actions.md": "safe-actions.md",
        "nestdevlab/build-tools:skills/run-nx-checks": "nx-checks"
      }
    }
  ]
}
```

Alias conflicts should be fatal unless `--force-alias` or an explicit override channel is used.

## Composition and Transclusion

### Default: Sync-Time Expansion

Installed artifacts should be self-contained. This is the most compatible model because Claude,
Codex, Copilot, and many future agents mostly read Markdown or directory contents. They will not
resolve an agentwheel include protocol at runtime.

For a skill directory, expansion edits/copies the staged `SKILL.md`:

```md
<!-- BEGIN agentwheel include nestdevlab/core-rules@1.2.3:fragments/review-style.md sha256:... -->
...included content...
<!-- END agentwheel include nestdevlab/core-rules@1.2.3:fragments/review-style.md -->
```

For command/rule/instruction Markdown files, same behavior.

For non-Markdown artifacts, initially do not support transclusion. Use `assets` for copying files
into directories, and keep JSON/TOML composition limited to existing merge strategies.

### SSOT Preservation

Sync-time expansion sounds like copy-paste, but SSOT is preserved at author/workspace level:

- Source fragments live once in the package repo.
- Generated runtime output contains provenance markers and is drift-protected.
- On update, the resolver re-expands from current source fragments.
- Local edits go through overlays/overrides/eject, never through generated output.

The manifest should record composition sources so `plan --dry-run` can show that a skill changed
because an included fragment changed, not because the skill body changed.

### Composition Inputs

Allow includes from:

- same package fragments: `fragments/foo.md`;
- same package artifacts: `rules/safe-actions.md` if Markdown;
- dependency aliases: `core:fragments/foo.md`;
- fully-qualified package selectors in lock/debug output:
  `nestdevlab/core-rules@1.2.3:fragments/foo.md`.

Do not allow arbitrary HTTP includes. Sources must be declared dependencies so trust, caching, and
locks apply.

### Include Semantics

Opinionated rules:

- Includes are textual and UTF-8.
- Includes are resolved before hashing the install artifact.
- Includes can be nested.
- Include cycles are fatal.
- Missing optional includes are omitted only if explicitly marked optional:

```md
<!-- agentwheel:include? fragments/local-note.md -->
```

- Include indentation is not magical. Authors should include block-level Markdown.
- A file can opt out of marker comments:

```jsonc
{
  "compose": [{ "include": "fragments/foo.md", "markers": false }]
}
```

Default should keep markers for debuggability.

### Runtime References as Later Optimization

Some agents may eventually support native imports or rule references. Add a future `compose.mode`
per adapter:

- `inline`: default, self-contained output.
- `reference`: install dependency artifacts separately and leave references intact.
- `hybrid`: inline for unsupported targets, references for supported targets.

Do not ship `reference` first. It will produce surprising no-op behavior in agents that just read
Markdown.

## Lockfile, Provenance, and Refcounts

The current model has one `SourceLock` per adapter and one `InstallManifest` per adapter. Dependency
resolution needs a graph lock and ownership index.

### Graph Lock

Add a generated pure JSON lock, likely:

```text
.agentwheel/<adapter>.graph-lock.json
```

or fold into the existing source lock by bumping lock `version`. I prefer a separate graph lock in
phase 1 to reduce migration risk, then merge later if desired.

Example:

```json
{
  "version": 1,
  "adapter": "claude",
  "targetRoot": "/home/me/project",
  "generatedAt": "2026-06-10T00:00:00.000Z",
  "roots": [
    {
      "workspacePackage": "mesh",
      "source": "github:NestDevLab/agent-mesh",
      "nodeId": "nestdevlab/agent-mesh@0.4.0+abc123"
    }
  ],
  "nodes": [
    {
      "id": "nestdevlab/core-rules@1.2.3+def456",
      "name": "nestdevlab/core-rules",
      "version": "1.2.3",
      "driver": "git",
      "source": "github:NestDevLab/core-rules",
      "requestedRef": "main",
      "resolvedCommit": "def456",
      "sourceHash": "sha256...",
      "requiredBy": ["nestdevlab/agent-mesh@0.4.0+abc123"],
      "selected": ["rules/safe-actions.md", "fragments/review-style.md"]
    }
  ],
  "edges": [
    {
      "from": "nestdevlab/agent-mesh@0.4.0+abc123",
      "to": "nestdevlab/core-rules@1.2.3+def456",
      "alias": "core",
      "range": "^1.2.0",
      "select": ["rules/safe-actions.md"]
    }
  ]
}
```

### Install Manifest Extensions

Extend `InstallManifestEntry` with optional dependency metadata:

```jsonc
{
  "path": ".claude/skills/nestdevlab-core-rules--policy-check",
  "artifactType": "skills",
  "artifactName": "policy-check",
  "installName": "nestdevlab-core-rules--policy-check",
  "logicalSelector": "nestdevlab/core-rules@1.2.3:skills/policy-check",
  "graphNodeId": "nestdevlab/core-rules@1.2.3+def456",
  "dependencyRole": "transitive",
  "owners": [
    "workspace:mesh",
    "node:nestdevlab/agent-mesh@0.4.0+abc123"
  ],
  "refCount": 2,
  "composedFrom": [
    {
      "logicalSelector": "nestdevlab/core-rules@1.2.3:fragments/review-style.md",
      "hash": "sha256..."
    }
  ]
}
```

`refCount` can be derived from `owners`, so it is optional denormalization. The lock/manifest should
store owners; CLI can print counts.

### Refcount Uninstall

Today uninstall creates remove operations for all manifest entries. With dependencies:

- `agentwheel uninstall <package>` should remove only artifacts whose owner set becomes empty.
- If an installed dependency artifact is still required by another root package, plan action should
  be `keep` with reason `still required by <owner>`.
- If a dependency artifact is drifted and no longer required, keep by default unless `--force`, same
  as today.
- If an artifact has local override/eject, uninstall should remove the managed runtime output only
  when unowned; it should not delete `.agentwheel/overrides` or `.agentwheel/ejected` without an
  explicit cleanup command.

Conceptual uninstall flow:

1. Read workspace config and graph lock.
2. Remove the target root package from requested roots.
3. Re-resolve remaining roots, preferably from lock/offline cache unless `update`.
4. Diff old install manifest owners against new desired owners.
5. Plan:
   - `remove`: old entry has no owners in new graph and no drift;
   - `keep`: old entry still has owners or is drifted;
   - `update`: owner set/path/provenance changed but content remains managed;
   - `drift`: current hash differs from manifest hash.

Do not implement dependency uninstall as "walk reverse edges and decrement a mutable counter" only.
That is tempting but brittle after config edits. Recomputing desired ownership from remaining roots
is safer; counters are a cached view.

## Interaction With Drift, Overlays, Overrides, Eject

### Drift

Drift remains path/hash based. Namespaced dependency artifacts are still managed entries. If a
composed artifact differs from manifest hash, it is drift, even if only an included block was edited.

Better diagnostics:

```text
DRIFT MANAGED skills/review (composed artifact changed outside agentwheel)
  composed from:
  - nestdevlab/core-rules@1.2.3:fragments/review-style.md
```

### Overlays

Instruction overlays should apply after dependency composition. If multiple root packages provide
instructions, the resolver must first decide instruction composition order. I recommend:

1. Root package instructions in workspace package order.
2. Direct dependency instructions only if selected/required.
3. Transitive instructions not installed unless explicitly selected.
4. Local overlay appended last, as current `applyInstructionOverlay` does.

Longer term, add instruction sections with package provenance markers.

### Overrides

Current overrides path is `.agentwheel/overrides/<package>/<type>/<name>`. With multiple versions:

```text
.agentwheel/overrides/<package>/<type>/<name>
.agentwheel/overrides/<package>@<version>/<type>/<name>
.agentwheel/overrides/<graphNodeId>/<type>/<name>
```

Resolution order:

1. exact graph node override;
2. package@version override;
3. package-level override;
4. upstream artifact.

Package-level override should fail if multiple versions are installed and the override is ambiguous.

### Eject

`parseEjectItem` currently expects `<package>/<type>/<name>`. Keep that for unambiguous single
versions, but print exact suggestions when ambiguous:

```bash
agentwheel eject nestdevlab/core-rules@1.2.3/rules/safe-actions.md
agentwheel eject nestdevlab/core-rules@2.0.0/rules/safe-actions.md
```

Eject should preserve logical identity and install name metadata. If an ejected dependency is still
owned by two roots, both roots now use the ejected content until one uninstalls.

## CLI and UX Surface

### Authoring

```bash
agentwheel init package
agentwheel deps add github:NestDevLab/core-rules --as core --version '^1.2.0'
agentwheel deps tree
agentwheel package validate
```

`deps add` is convenience; editing JSONC by hand should be fully supported.

### Installing

No extra ceremony for users:

```bash
agentwheel add github:NestDevLab/agent-mesh --adapter claude --mode tracking
agentwheel sync --dry-run
agentwheel sync
```

Optional controls:

```bash
agentwheel sync --no-deps
agentwheel sync --deps=direct       # direct only, no transitive; mostly for debugging
agentwheel sync --offline
agentwheel sync --frozen-lock
agentwheel sync --trust github:NestDevLab/*
agentwheel sync --alias core:rules/safe-actions.md=safe-actions.md
```

### Dry-Run Output

Add a dependency tree before file operations:

```text
Dependency graph for claude at /home/me/project

ROOT mesh github:NestDevLab/agent-mesh#main
  RESOLVE nestdevlab/agent-mesh@0.4.0 abc123
  HOIST   core -> nestdevlab/core-rules@1.2.3 def456 (^1.2.0)
  NEST    build -> nestdevlab/build-tools@2.0.0 a1b2c3 (conflicts with @1.5.0)

Selections:
  mesh: skills/triage-pr, rules/team-style.md
  core: rules/safe-actions.md, fragments/review-style.md (composed)
  build@2.0.0: commands/nx.md

Namespacing:
  core:rules/safe-actions.md -> rules/nestdevlab-core-rules--safe-actions.md
```

Then existing plan lines:

```text
CREATE   MANAGED  rules/safe-actions.md ... (dependency required by mesh)
UPDATE   MANAGED  skills/triage-pr ... (included fragment changed)
KEEP     MANAGED  rules/other.md ... (still required by package x)
```

### Explain Commands

Add:

```bash
agentwheel deps tree
agentwheel deps why rules/nestdevlab-core-rules--safe-actions.md
agentwheel deps why nestdevlab/core-rules:rules/safe-actions.md
agentwheel deps locks
```

`why` is essential once refcounts and transitive installs exist.

## Security and Trust

Dependencies pull arbitrary transitive resources into agent runtimes. Treat that like executable
supply chain, even when the payload is Markdown. Agent instructions are code-shaped authority.

Recommended defaults:

- Transitive dependencies from git are allowed only from sources explicitly declared in a manifest
  fetched from a user-requested root, but dry-run prints them prominently.
- First install of a new transitive source asks for trust unless `--yes`, `--trust`, or config
  policy allows it.
- Lock stores `resolvedCommit` and `sourceHash`.
- `--frozen-lock` refuses new sources, new versions, or changed hashes.
- `--offline` uses only cache and lock; it fails if a needed source is not cached.
- `integrity` in dependency declarations can pin expected source hash.
- Programmatic adapters and semantic plugin execution remain gated by existing explicit flags.
- MCP/hooks/settings dependencies should get extra warnings because they can affect tools and
  execution. Consider a policy:

```jsonc
{
  "trust": {
    "allow": ["github:NestDevLab/*", "github:FrancescoBorzi/agent-toolkit"],
    "denyArtifactTypes": ["hooks", "mcp"],
    "requireReviewForTransitive": true
  }
}
```

Do not allow transitive dependencies to execute plugins by default. They may plan semantic plugin
installs, but `--execute-plugins` should list each transitive plugin explicitly.

## Caching and Offline Behavior

Current git caching lives under `.agentwheel/cache` via `GitSourceDriver`. Extend cache metadata:

```text
.agentwheel/cache/
  sources/...
  manifests/<sourceDigest>.json
  graphs/<adapter>/<graphHash>.json
```

Resolver cache keys should include:

- driver;
- normalized source;
- requested ref;
- resolved commit or content hash;
- manifest hash;
- selection set;
- adapter only when composition or adapter capabilities affect output.

`agentwheel sync --offline`:

- reads graph lock;
- verifies cached source paths exist and hashes match;
- stages from cache;
- refuses tracking updates.

`agentwheel update`:

- re-resolves tracking roots and tracking deps;
- keeps pinned deps fixed unless range/source/ref changed;
- shows graph diff.

## Edge Cases and Failure Modes

- Same artifact name, same content hash, different package: dedupe install path only if user opts
  into content dedupe. Default should still preserve package provenance because future updates may
  diverge.
- Same package name from two different sources: fail unless manifest names and trust policy allow a
  source alias, or install as separate source-qualified nodes.
- Non-semver package versions: exact only.
- Missing manifest version: invalid for dependency target; package can still be root-installed if
  current schema allows it, but cannot satisfy ranges.
- Local path dependency in a published package: warn; allow for private monorepos, but registry
  publication should reject non-relative local dependencies unless marked private.
- Dependency requires artifact that root selection excluded: dependency wins for required children
  of selected artifacts.
- Two roots alias the same dependency differently: graph node can be shared; aliases are local to
  declaring package.
- Composition includes a runtime-installed rule that was overridden locally: use the overridden
  content only if the include target is the same logical artifact and override applies before
  composition. This is powerful but potentially surprising; dry-run must show it.
- Ejected composed artifact: ejected output freezes the expanded content. Future fragment updates no
  longer affect it until unejected.
- Adapter lacks artifact type support: if dependency artifact is only needed for composition, OK; if
  it must be installed, warn or fail depending on `required`.
- Semantic plugin transitive dep: plan only unless explicitly executed.
- SSH targets: resolution and staging happen locally; install manifest/hash reads happen remotely as
  today. Graph lock should live in workspace, not remote runtime, unless target root is the
  workspace.
- Multiple profiles/runtimes: graph resolution may differ by adapter if adapter capabilities affect
  composition. Lock per adapter/profile target is safer than one global lock.

## Phased Rollout

### Phase 0: Schema and Diagnostics Only

- Add manifest fields behind permissive parsing: `requires`, `items`, `compose`.
- Add `agentwheel package validate` or extend `scan` to validate dependency declarations without
  installing.
- Add no install behavior yet.

Value: authors can start experimenting; schema bikeshedding happens before installer risk.

### Phase 1: Simple Dependencies, No Conflicting Versions

- Resolve package-level `requires` recursively.
- Support semver exact/range for manifest versions.
- Deduplicate compatible versions.
- If incompatible versions appear, fail with a good diagnostic.
- Install selected dependency artifacts into namespaced paths.
- Write graph lock and owner metadata.
- Implement refcount-aware uninstall by recomputing remaining roots.

This is the smallest useful install-time dependency system. It avoids nested conflicts at first but
builds the lock/owner model needed for them.

### Phase 2: Sync-Time Composition

- Add `fragments` and include markers.
- Resolve includes from same package and dependencies.
- Expand Markdown at staging time with provenance comments.
- Hash expanded output.
- Show `composedFrom` in dry-run and manifest.
- Composition cycles fatal.

This can ship before or after Phase 1, but it becomes more valuable when cross-package fragments
exist.

### Phase 3: Npm-Style Conflicting Version Satisfaction

- Allow multiple incompatible versions in the graph.
- Add install-name disambiguation policy.
- Add `deps tree`, `deps why`, alias overrides, and ambiguity diagnostics.
- Add override/eject syntax for package@version/graph node.

This is the full answer to the flat namespace problem.

### Phase 4: Trust, Frozen Locks, Offline

- Trust policy prompts/config.
- `--frozen-lock`.
- `--offline`.
- Integrity pins.
- Graph diff on update.

Some trust basics should appear earlier, but the full policy surface can mature after the graph
format stabilizes.

### Phase 5: Runtime Reference Mode and Advanced Composition

- Adapter capability for native references.
- JSON/TOML structured includes if needed.
- Content-dedupe optimization.
- Registry metadata for dependency compatibility.

Do not block the core design on this.

## Alternatives We Might Be Missing

### Alternative A: Bundle Dependencies Into Parent Artifacts Only

Dependencies never install independently; they are always transcluded into selected root artifacts.

Pros:

- Avoids flat namespace conflicts almost entirely.
- Great runtime compatibility.
- Simple uninstall/refcount because fewer shared installed files exist.

Cons:

- Bad for dependencies that are real runtime artifacts, like MCP, hooks, commands, or reusable
  skills.
- Duplicates expanded content across multiple root artifacts.
- Harder to use `deps why` or override one shared dependency.

Verdict: use for fragments/composition, not for all dependencies.

### Alternative B: Vendor Directory Inside Each Skill

Install dependency content under each skill directory, for example
`skills/triage-pr/.agentwheel/vendor/...`.

Pros:

- Gives a physical nested model for directory artifacts.
- Avoids global skill/rule name conflicts for skill-local dependencies.

Cons:

- Rules/instructions/commands are not naturally skill-local.
- Agents may ignore nested vendor content unless the parent `SKILL.md` references it.
- Creates hidden complexity and repeated copies.

Verdict: useful for assets and scripts, not as the primary dependency model.

### Alternative C: Agentwheel Runtime Loader

Install a tiny loader/instruction that teaches agents to resolve `agentwheel://` references at
runtime.

Pros:

- Preserves perfect SSOT.
- Avoids expansion copies.

Cons:

- Most agents do not execute loaders before reading instructions.
- Adds runtime coupling and failure modes.
- Undermines agentwheel's "install native files" premise.

Verdict: not first. Maybe a future adapter-specific optimization.

### Alternative D: Central Registry With Global Names

Require all dependencies to be registry packages with unique global artifact names.

Pros:

- Easier resolution and trust policy.
- Better discovery.

Cons:

- Violates current "registry optional" design.
- Does not work for private repos/monorepos.
- Still does not solve same artifact names across ecosystems.

Verdict: registry can enrich metadata, not become required.

### Alternative E: OCI/Nix-Style Content Addressed Store

Install every dependency into `.agentwheel/store/<hash>` and generate runtime files as symlinks or
materialized views.

Pros:

- Excellent dedupe and reproducibility.
- Natural multiple-version coexistence.

Cons:

- Symlinks are brittle across agents, OSes, and SSH targets.
- Runtime dirs still need human-readable names.
- Much more implementation work.

Verdict: consider an internal cache/store later, but materialize normal runtime files.

### Alternative F: Capability-Based Dependencies

Instead of requiring `package X`, a skill requires a capability:

```jsonc
{ "requires": [{ "capability": "javascript.monorepo.nx-checks", "version": "^1" }] }
```

The resolver picks a provider from installed packages or registry.

Pros:

- More abstract and composable.
- Lets users choose preferred providers.

Cons:

- Needs registry/index semantics.
- Harder to make reproducible.
- Harder for authors to reason about.

Verdict: promising later. Start with explicit dependencies; add `providesCapabilities` once the
ecosystem has enough packages.

## Opinionated Decisions

1. Dependencies are declared in `agentwheel.json(c)`, not in separate files.
2. Dependency resolution belongs in lifecycle/resolver, not in source drivers or adapters.
3. Semver is supported when parseable; non-semver is exact-only.
4. Conflicts are satisfiable via logical nesting plus deterministic runtime namespacing.
5. Root artifacts keep pretty names; transitive artifacts accept namespaced names.
6. Composition is inline at sync time by default.
7. Fragments should be first-class in locks and validation, but not installed by default.
8. Refcounts should be recomputed from the graph, not mutated blindly.
9. Trust prompts/policies are required before this becomes broadly safe.
10. `plan` / `sync --dry-run` must explain graph, namespacing, and ownership before file operations.

## Open Questions and Risks

- Should `schemaVersion` stay at 1 for optional fields, or should dependencies force v2? I lean
  v1-compatible during preview, v2 once stable.
- Should `fragments` be added to `ArtifactType`, or should fragments remain package-internal
  composition sources? I lean first-class because provenance matters.
- How should instruction artifacts from multiple packages combine? Current adapters often target a
  single file. A deterministic sectioned composition model is needed.
- How much user prompting is acceptable in CLI? CI needs `--yes`, `--frozen-lock`, and policy files.
- Should dependency artifacts install by default, or only when selected/required? I strongly prefer
  selected/required only to avoid runtime pollution.
- How do semantic plugin dependencies compose with refcounts if plugin uninstall is not symmetric?
  Need per-plugin adapter uninstall semantics before auto-removing transitive plugins.
- Can local overrides apply to fragments before transclusion? I think yes, but dry-run must make it
  visible.
- Should install-name aliases live in workspace config or lock? Config for user intent; lock for
  resolved result.
- How do we handle package rename? Lock should track source and previous name, then require an
  explicit migration if manifest name changes.

## Proposed Implementation Shape

No code in this task, but the likely module boundaries are:

- `src/resolve/graph.ts`: recursive dependency resolution, hoist/nest decisions.
- `src/resolve/semver.ts`: parse/range behavior with exact fallback.
- `src/resolve/names.ts`: install-name disambiguation.
- `src/compose/markdown.ts`: include expansion and provenance.
- `src/model/graph-lock.ts`: graph lock schema.
- `src/lifecycle/source-plan.ts`: replace single `stageSource` call with `createGraphPlan`, then
  pass install-ready artifacts to `createInstallPlan`.
- `src/install/manifest.ts`: extend optional entry metadata.
- `src/install/uninstall.ts`: add owner-aware uninstall plan.
- `src/cli/format.ts`: graph tree and `why` explanations.

This keeps current source drivers, adapters, staging, drift checks, and install operations mostly
intact while adding the missing orchestration layer.

## Round 2 Answers

**A. Agree.** The current pipeline is effectively single-source per `(targetRoot, adapter)`: `stageSource`
returns one bundle, `createInstallPlan` treats entries missing from that bundle as removals, and
`applyInstallPlan` overwrites the adapter manifest. Dependency support must therefore change sync semantics
to resolve all configured roots plus their closure into one combined desired set and one plan/manifest per
target adapter. I would bump manifest version for the new multi-owner shape, but keep a migration path that
imports existing v1 entries as one synthetic root/owner so current installs do not get mass-removed on first
sync.

**B. Agree with surfacing the collision; deterministic rule:** if two direct roots both provide
`skills/review` with different hashes/logical identities, neither should silently "win" by install order.
If one entry is already managed and unchanged, keep it as the incumbent plain name and mark the newcomer as a
blocking direct/direct collision requiring alias, deselect, or override; on a fresh install with no incumbent,
sort roots by workspace config order, give the first root the plain name, and block the second with the same
resolution hint. Direct roots are user intent, so automatic namespacing is too surprising for invoked skills.

**C. Agree.** Intra-package fragments/includes should ship first because they generalize existing
`composeAssets()` and `applyInstructionOverlay()` without needing graph resolution, trust prompts, or
cross-repo locks. That gives immediate DRY/SSOT value and validates transclusion markers, composition
hashing, source maps, and drift behavior. Cross-package includes should be unlocked later by the dependency
graph, where aliases, provenance, trust, and cache/offline behavior are available.

**D. Agree for P1.** Drop semver range-solving from the first dependency slice and resolve by source identity:
dedupe by normalized source plus manifest `name`, with pin/tracking refs and lock hashes providing
reproducibility. Manifest `version` should still be recorded and displayed, but not used for solving until
packages actually version meaningfully. Semver ranges belong with the later conflict-satisfaction phase, when
there is enough UX for incompatible versions, aliases, and explicit user decisions.
