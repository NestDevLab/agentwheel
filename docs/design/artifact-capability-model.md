# Agentwheel Artifact Capability Model

> **Partly superseded by [`runtime-matrix.md`](runtime-matrix.md)** (current, evidence-based). Key updates from the co-design: `rules` is **Claude-native only** — others get behavioral guidance via `instructions`, NOT a "rules projection". There is **no `AGENTS.md` loader-block / projection**: instructions ship as a **managed content block** in each harness's native instruction file (bridge-aware via `@import`/symlink + realpath-dedup; Copilot-duplication is disclaimed+warned). Prefer the **deployable-artifact vs runtime-feature** distinction and the per-harness matrix in `runtime-matrix.md` over the `projected/emulated` taxonomy below.

## Summary

Agentwheel should model artifacts by semantic capability, not by folder names. An artifact declares a portable intent; each adapter declares whether that capability is `native`, `projected`, `emulated`, `custom`, or `unsupported`.

Baseline decision: OpenPack `rules` means behavioral Markdown guidance. It does not mean Codex command policy. Codex `.rules` command policies are out of scope for `rules`; they remain unsupported for now and may become a separate artifact later.

## V1 Scope

V1 is a guardrail and metadata cleanup. It must not introduce generated `AGENTS.md` loader blocks, projected rule installation, or new runtime mutation behavior.

- Add adapter capability metadata: `support`, `formats`, and optional future-facing `projection`.
- Reclassify built-in support:
  - Claude `rules`: native `markdown-rule`.
  - Codex `rules`: no command-policy support through `rules`; Markdown behavioral rules are not projected in V1.
  - OpenClaw/Hermes built-ins: no native rules; custom adapters may explicitly declare emulated/custom Markdown rules.
  - Copilot `rules`: projected custom instructions, not native rules.
- Enforce plugin guardrails: `plugins` require runtime-specific `format`, and multi-runtime/profile installs require `runtimes`.
- Update docs/spec/matrix to distinguish semantic artifact, concrete format, support level, and install/projection strategy.

## V2 / Deferred Scope

- Codex/OpenClaw/Hermes behavioral rule projection via loader blocks or generated instruction fragments.
- Best-effort `paths` frontmatter emulation outside Claude.
- Any future `command-policy` artifact for Codex `.rules`.
- Any broad redesign of `subagents`; keep existing adapter behavior unless required by V1 validation.

## Artifact Policy

| Artifact | Decision |
|---|---|
| `instructions` | Supported. General durable instructions; native or projected per harness. |
| `rules` | Behavioral Markdown guidance only. Claude native; non-native adapters must be explicit custom/emulated. Never Codex `.rules`. |
| `skills` | Strong portable support. `SKILL.md` validation remains required. |
| `commands` | Supported only when native or clearly mapped: Claude commands and Copilot prompts. No generic support. |
| `subagents` | Existing capability remains, but no new V1 scope. Codex TOML/render, Claude Markdown, Copilot `.agent.md`; unsupported otherwise. |
| `mcp` | Supported only with structured adapter merge/format behavior. No raw copy when the runtime requires a specific format. |
| `hooks` | Conservative: native or explicit custom support only, with clear schema/merge behavior. |
| `settings` | Strict: documented runtime formats or explicit custom adapter support only. |
| `plugins` | Runtime extension package; never automatically portable. `format` is required. |
| `fragments` | Composition input only. Never a runtime-installed artifact by default. |

## Plugin Guardrails

- `plugins` always requires `format`.
- Adapter whitelist:
  - OpenClaw accepts only `openclaw-plugin`.
  - Hermes accepts only `hermes-plugin`.
- Profile or multi-runtime installs require `runtimes` for plugin provides.
- Missing `format` is always an error.
- `format` without `runtimes`:
  - single-adapter explicit install: strong warning, continue only when format is compatible.
  - profile/multi-runtime: error.
- An OpenClaw plugin must never install on Hermes, and a Hermes plugin must never install on OpenClaw.

## Migration And Compatibility

- Treat V1 as a deprecation-compatible tightening pass where possible: existing manifests should receive clear errors or warnings before runtime writes.
- Existing lock/manifest entries should not be mass-removed solely because adapter metadata changes. Reconcile should be based on selected artifacts and current target compatibility.
- Fleet custom adapters must be updated before broad dry-runs:
  - add `support: "custom"` or `support: "emulated"` where appropriate.
  - add `formats` for `rules` and `plugins`.
- Known impacted profiles/packages: `all`, `e-boekhouden`, plugin profiles, and any profile using `hermes-with-plugins.jsonc` or `openclaw-with-rules.jsonc`.
- Rollout should start with dry-run only. No fleet install, force, or runtime cleanup belongs in the V1 implementation PR.

## Implementation Steps

1. Extend adapter target schema with `support` metadata and optional future `projection`.
2. Tighten validation:
   - `rules` accepts Markdown behavioral formats only.
   - Codex command-policy `.rules` fails under `rules`.
   - `plugins` requires `format`; profile/multi-runtime requires `runtimes`.
3. Update built-in adapters and fleet custom adapter examples to declare support level and formats.
4. Ensure planning validates `runtimes` before format compatibility so runtime-specific plugins do not cross-install.
5. Update docs/spec, compatibility matrix, README, and manifest examples.

## Test Plan

- Compatibility tests per artifact, harness, support level, and format.
- Negative tests:
  - Codex `.rules` under `rules` fails.
  - plugin without `format` fails.
  - `openclaw-plugin` on Hermes fails.
  - plugin with `format` but without `runtimes` fails in profile/multi-runtime planning.
- Positive tests:
  - Claude Markdown rules remain native.
  - OpenClaw/Hermes Markdown rules work only through explicit custom/emulated adapter metadata.
  - OpenClaw/Hermes plugins work only with matching `format` and `runtimes`.
- Regression dry-runs: `all`, `e-boekhouden`, `odido`, and plugin profiles.

## Assumptions

- V1 does not implement projected rules or AGENTS.md loader injection.
- V1 does not implement a `command-policy` artifact.
- Existing `subagents` behavior is kept stable unless validation metadata requires a small documentation update.
- Custom adapters remain supported, but must become explicit about support level and accepted formats.
