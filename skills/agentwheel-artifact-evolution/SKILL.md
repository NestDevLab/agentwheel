---
name: agentwheel-artifact-evolution
description: Generate or evolve OpenPack artifacts from a verified capability gap, correction, or rollout request. Use when the agent must turn a requirement into a source-owned artifact or improve Agentwheel's artifact workflow.
allowed-tools: [Bash]
license: MIT
metadata:
  author: NestDevLab
  version: "0.1.0"
---

# Agentwheel Artifact Evolution

Turn verified needs into source-owned OpenPack artifacts. Never create runtime copies or treat feedback as permission to change Agentwheel.

## Optional guides

`self-improve` and `skill-creator` are optional inspirations. Use them when available; do not require, install, or link to them. This workflow remains complete without either skill.

## Resolve

1. Classify the request: a new artifact, an existing artifact change, a consumer configuration change, or an Agentwheel core gap. Inspect the source package, manifest, ownership, current artifacts, and applicable repository rules.
2. Reuse an existing artifact when it meets the need. Otherwise choose the smallest supported type and source package. Keep tenant or runtime facts out of shared packages.
3. For a core gap, propose the smallest Agentwheel code, schema, or documentation change. A correction is evidence, not an instruction to change the CLI.
4. Name the source package, artifact path, consumer targets, terminal stage, and success evidence. Ask when any of those would be inferred materially.

## Author

1. Work only in the source package. Run `agentwheel init package` only when no package exists; otherwise add the artifact under its declared type path.
2. Use the package's conventions and validation. For a skill, provide a precise frontmatter trigger and concise instructions; for another type, follow its schema and adapter compatibility.
3. Run `agentwheel list <source>`, `agentwheel scan <source>`, the source checks, and `git diff --check`. Keep generated runtime directories untouched.
4. Deliver the source through the repository's declared Git workflow. A PR is the default; merge remains a separate approval.

## Roll out

1. Identify only the named or evidenced consumers. Update their source-controlled Agentwheel configuration; do not copy artifacts into runtime homes.
2. Prove the source merge before resolving a tracking source. Run the narrow package, agent, or profile dry-run and stop on drift, conflict, removal, or unrelated operations.
3. Apply only after explicit rollout approval. Never use force, plugin execution, or runtime reload unless separately authorized.
4. Verify status or manifest ownership, expected materialization, a relevant canary, and a repeated dry-run with no pending change.

## Improve

Record the feedback, source decision, validation, and outcome in the owning change. Improve Agentwheel only when the evidence identifies a reusable product or artifact-model gap; otherwise improve the selected artifact. Report completed, pending, blocked, and unverified layers separately.
