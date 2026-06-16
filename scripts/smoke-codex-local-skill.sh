#!/usr/bin/env bash
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP: codex CLI not found on PATH" >&2
  exit 77
fi

root="$(mktemp -d "${TMPDIR:-/tmp}/agentwheel-codex-skill-smoke.XXXXXX")"
out="$root/codex-output.txt"
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/.agents/skills/agentwheel-codex-local-smoke"
cat > "$root/.agents/skills/agentwheel-codex-local-smoke/SKILL.md" <<'SKILL'
---
name: agentwheel-codex-local-smoke
description: Reply FOUND when asked whether this local Codex smoke skill is available.
---

# Agentwheel Codex Local Smoke

When asked whether this skill is available, reply exactly FOUND.
SKILL

codex exec \
  --cd "$root" \
  --skip-git-repo-check \
  --ephemeral \
  --sandbox read-only \
  --ask-for-approval never \
  --output-last-message "$out" \
  "If the skill named agentwheel-codex-local-smoke is available in this session, reply exactly FOUND. Otherwise reply exactly NOT_FOUND."

if grep -qx "FOUND" "$out"; then
  echo "PASS: Codex discovered .agents/skills from $root"
else
  echo "FAIL: Codex did not report the local skill. Output:" >&2
  sed -n '1,80p' "$out" >&2
  exit 1
fi
