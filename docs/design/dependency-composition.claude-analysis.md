# Claude's grounded analysis (raw material for the synthesis)

## What actually exists today (cited)

- **Manifest schema** (`src/model/package.ts`): `agentwheel.json` = `{schemaVersion:1, name, version, provides[]}`.
  `provides` entries: `{type, path, assets?, required?}`. No `requires`, no semver, `version` is a free string.
- **Artifact** (`src/model/artifact.ts`): `{type, name, sourcePath, relativePath, kind, hash, packageName?,
  channel: managed|overlay|addition|override|ejected, assets?, required?}`. Already has provenance hook
  (`packageName`) and a customization `channel`.
- **Intra-package composition already exists**: `PackageAsset {from,into,include,mode}` +
  `composeAssets()` (`src/staging/staging.ts:84`) copies files from elsewhere in the SAME package into a
  skill dir at stage time. `resolvePackagePath` FORBIDS escaping the package root → today composition is
  strictly intra-package. This is the seed to generalize for cross-package DRY.
- **Customization/overlay layer** (`src/staging/customize.ts`): `.agentwheel/overlays|overrides|additions|ejected`
  compose a final artifact from managed-upstream + local at stage time, writing to `.agentwheel-composed/...`.
  The instruction overlay literally concatenates managed + local with BEGIN/END markers. **This is a working
  "compose at sync time into a self-contained artifact" precedent** — the foundation for transclusion.
- **Staging** (`stageSource`): ONE source -> resolve/fetch/translate/export -> list artifacts -> copy to a
  temp bundle -> selection filter -> customizations -> returns `{root, artifacts, sourceLock}`.
- **Plan** (`src/install/plan.ts`): one `StagedBundle` -> `InstallPlan`. Destinations are FLAT:
  `join(targetRoot, target.dest, artifact.name)` e.g. `.claude/skills/<name>`. Conflict rules:
  - dest exists but NOT in manifest -> `conflict` (blocking).
  - dest in manifest, hash changed outside -> `drift` (blocking).
  - manifest entry not in desired set -> `remove`.
- **Apply** (`src/install/apply.ts`): builds `entries` from THIS plan ONLY and `writeInstallManifest`
  OVERWRITES the whole file. Manifest + lock are keyed per **(targetRoot, adapter)**:
  `${adapter}.install-manifest.json`, `${adapter}.source-lock.json` (`src/install/paths.ts`).

## The decisive finding (this shapes everything)

**The install pipeline is single-bundle / single-source per (targetRoot, adapter).** A sync builds one
plan from one bundle and REPLACES the manifest. Because plan.ts marks any manifest entry not in the current
desired set as `remove`, syncing a second source into the same adapter root would *delete the first source's
artifacts* and overwrite the manifest. `runConfiguredPackages` loops packages but each iteration clobbers the
previous one's manifest. => There is today **no notion of a combined install set from multiple sources** with
shared provenance.

**Therefore the dependency system is, at its core, a generalization of the pipeline from
"one bundle -> plan -> manifest" to "the resolved dependency CLOSURE (N bundles) -> ONE combined plan ->
ONE manifest whose entries carry multi-requirer provenance (refcount)."** Everything else (manifest field,
CLI) is comparatively easy; this pipeline change is the real work.

## The flat-namespace problem (npm dedup doesn't map cleanly)

npm nests `node_modules/` so two versions coexist. agentwheel installs into a **flat, human-invoked**
namespace: `.claude/skills/run-nx-checks/`. The agent invokes a skill by its directory NAME. So:
- We CANNOT silently keep two versions of `skills/foo` — they collide on one dest path, and renaming one
  (`foo@2`) changes how the agent calls it (breaks the UX contract).
- Practical consequence: for human-facing artifacts (skills/rules/commands) we should **dedup to a single
  resolved version per name (hoist)**, and treat an unsatisfiable version conflict as a surfaced decision,
  not a silent nest. "Multiple coexisting versions" is viable only for NON-invoked, content-addressed
  building blocks (fragments/partials) that are transcluded, never directly named by the agent.
- This splits the problem cleanly:
  - **Invoked artifacts** (skills/rules/...): one version each, hoisted, refcounted. npm-style *dedup*, not
    npm-style *nesting*.
  - **Fragments/partials** (the DRY building blocks): content-addressed, may have many versions, transcluded
    into consumers at sync time, never occupy a named runtime slot. This is where the npm-nesting intuition
    actually fits.

## Recommended shape (to reconcile with Codex's proposal)

1. **Two distinct concepts, one system:**
   - `requires[]` in the manifest = *install-time dependency closure* (fetch other packages/artifacts).
   - `fragments` (new artifact type) + transclusion (`{{include source#fragments/x}}`) = *content composition*
     for DRY/SSOT; resolved & inlined at stage time into self-contained installed artifacts (extends the
     existing `.agentwheel-composed` + PackageAsset precedent).
2. **Resolution**: recursive over `requires`, dedup invoked artifacts by `type/name`, build the closure,
   then ONE combined plan. Cycle detection by (resolved source id). Version policy: compatible -> hoist to
   highest; incompatible on an invoked artifact -> surfaced conflict with a resolution hint (alias/pin), not
   a crash.
3. **Provenance/refcount**: extend `InstallManifestEntry` with `requiredBy: string[]` (the set of root
   packages/sources whose closure includes this entry). Uninstall removes an entry only when its `requiredBy`
   becomes empty. This is the user's chosen model and the manifest already carries `packageName`.
4. **Pipeline change**: introduce a "resolve closure -> stage many -> merge into one bundle/plan -> one
   manifest" path; make the manifest ADDITIVE/owned-by-closure instead of replaced-per-source. This is the
   crux and the main risk.
5. **UX**: `--dry-run` prints the dependency TREE; `install` shows hoist/dedup decisions and any conflicts;
   `requires` resolvable offline from cache; trust prompt before pulling transitive sources from new repos.
6. **Phasing**:
   - P1: `requires[]` (package-level), closure resolution, combined plan + refcount manifest, dedup-hoist,
     conflict surfaced (no nesting). Ships the dependency feature.
   - P2: `fragments` + transclusion (the DRY/SSOT composition layer).
   - P3: artifact-level `requires` (a single skill declares its needs in SKILL.md frontmatter), content-
     addressed fragment versions (the only place nesting applies).

## Open questions for the user / Codex to weigh
- Do resources need real **semver**, or is pin-by-commit + "compatible = same major string" enough for v1?
- Should fragments be a new artifact `type`, or a reserved subfolder convention (`_fragments/`) not installed
  directly? (Latter avoids adapter-target wiring.)
- Trust model for transitive sources: prompt-per-new-host, allowlist, or lockfile-pinned-only?
