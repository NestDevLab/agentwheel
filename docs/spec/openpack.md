# OpenPack 1.0-draft

OpenPack is a vendor-neutral package format for agent resources such as instructions, rules,
skills, commands, settings, MCP snippets, hooks, plugins, and reusable fragments. agentwheel is
the reference implementation, but the manifest and composition rules are intended for any
installer.

## Manifest

An OpenPack package declares its resources in `openpack.json` or `openpack.jsonc`. Tools may read
the legacy aliases `agentwheel.json` and `agentwheel.jsonc` for compatibility, but new packages
should use the OpenPack names.

`schemaVersion: 1` is the frozen legacy shape: `name`, `version`, and `provides[]` with
`type`, `path`, optional `assets`, and optional `required`. It does not support dependencies,
composition metadata, runtime targeting, or fragments.

`schemaVersion: 2` adds the OpenPack fields:

```jsonc
{
  "schemaVersion": 2,
  "name": "example/agent-pack",
  "version": "1.0.0",
  "runtimes": ["claude", "codex"],
  "requires": {
    "core": {
      "source": "registry:core-rules",
      "ref": "main",
      "version": "^1.2.0",
      "select": ["rules/safe-actions.md", "fragments/risk.md"],
      "mode": "pinned",
      "optional": false,
      "integrity": "sha256-...",
      "runtimes": ["claude"]
    }
  },
  "provides": [
    { "type": "fragments", "path": "fragments" },
    { "type": "rules", "path": "rules/codex.rules", "format": "codex-command-policy", "runtimes": ["codex"] },
    {
      "type": "skills",
      "path": "skills",
      "runtimes": ["claude", "codex"],
      "items": {
        "triage": {
          "requires": ["rules/safe-actions.md"],
          "compose": [
            { "include": "fragments/review-style.md" },
            { "include": "fragments/local-note.md", "optional": true, "markers": false }
          ],
          "runtimes": ["codex"]
        }
      }
    }
  ]
}
```

Dependency declarations in `requires` are part of the schema in this draft. Tools implementing
L4 resolve the dependency graph recursively, apply parseable semver ranges, and lock the selected
source identities. Tools below L4 may still validate and record these fields without resolving
them.

### Meta-packages

An OpenPack v2 manifest MAY omit `provides` or declare it empty when it declares at least one
`requires` dependency. Such a package installs nothing of its own and exists to aggregate or select
resources from other packages. Uninstalling it removes the dependencies it pulled in unless those
dependencies are still owned by other packages.

```json
{
  "schemaVersion": 2,
  "name": "test/meta-pack",
  "version": "0.1.0",
  "requires": {
    "dep": { "source": "../dep-a", "select": ["rules/a.md"] }
  }
}
```

## Layout And Types

Canonical package directories are:

```text
instructions/ or instructions.md or AGENTS.md
rules/
skills/<name>/SKILL.md
commands/
subagents/
mcp/
hooks/
settings/
plugins/
fragments/
```

The artifact type vocabulary is `instructions`, `rules`, `skills`, `commands`, `subagents`,
`mcp`, `hooks`, `settings`, `plugins`, and `fragments`. Fragments are source artifacts for
composition and are not installed into runtime directories unless a future runtime explicitly
defines a fragment target.

`provides[].format` and `provides[].items.<name>.format` optionally describe the concrete artifact
format inside a broad type. Installers may infer obvious formats from file names and structure, but
runtime adapters can reject artifacts whose format is unknown or incompatible with the target. Common
formats include `codex-command-policy` for Codex `.rules` files, `markdown-rule` or
`claude-markdown-rule` for Markdown behavioral rules, `copilot-instruction-rule` for Copilot rule
artifacts that render as instructions, and `openclaw-plugin` for OpenClaw plugin directories.

## Selectors

Selectors use `type/name` for local artifacts and `alias:type/name` for artifacts from a declared
dependency. `alias:` has lexical meaning only inside the declaring package. Dependency aliases do
not fall back to package names.

## Composition

Markdown files can include fragments with:

```md
<!-- openpack:include fragments/review-style.md -->
<!-- openpack:include? fragments/local-note.md -->
```

The `?` form is optional and is omitted when the target file does not exist. To show a literal
include marker in documentation, escape the colon:

```md
<!-- openpack\:include fragments/example.md -->
```

Installers expand from raw package source only. Generated output is never used as expansion input;
raw files containing generated `BEGIN` or `END` OpenPack include blocks are invalid unless the
example markers are escaped.

Generated output is wrapped by default:

```md
<!-- BEGIN openpack:include fragments/review-style.md sha256:0123456789abcdef -->
included content
<!-- END openpack:include fragments/review-style.md -->
```

The hash is the first 16 hex characters of the SHA-256 of the expanded included content. Manifest
`items.<name>.compose[]` entries append included content, in order, after inline marker expansion
for that item. `markers: false` suppresses the wrapper for that manifest-declared include only.

Nested includes are allowed. Composition cycles are fatal and must report the include chain.
Includes must stay inside the package root. Cross-package `alias:` includes require L4 dependency
support; dependency aliases are locked as include edges with source hashes.

## Registry Metadata

Registry entries may include optional compatibility metadata:

```jsonc
{
  "name": "example/agent-pack",
  "source": "github:Example/agent-pack",
  "openpack": {
    "schemaVersion": 2,
    "specVersion": "1.0-draft"
  }
}
```

Installers should parse this metadata permissively. An installer that sees a registry entry with
an OpenPack `schemaVersion` newer than it supports should warn before resolution.

## Runtimes

Runtime identifiers are well-known lowercase names, open to extension. The initial list is
`claude`, `codex`, `copilot`, `openclaw`, `hermes`, and `gemini`. Runtime filtering is an author
compatibility declaration; installers may also apply their own capability filters.

## Conformance

OpenPack tools can implement partial conformance:

- L1: read manifests and the source layout.
- L2: selective install by artifact selector.
- L3: Markdown composition with fragments.
- L4: dependency graph resolution.
