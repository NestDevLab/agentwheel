import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Artifact } from "../model/artifact.js";
import { filterArtifactsBySelection } from "../model/selection.js";
import type { ScanFinding, SourceDriver, ResolvedSource } from "../source/types.js";

export const MAX_TRIAL_SKILL_BYTES = 512 * 1024;

export interface SkillTrial {
  schemaVersion: 1;
  mode: "read-only";
  source: string;
  resolvedCommit?: string;
  findings: ScanFinding[];
  skill: {
    name: string;
    relativePath: string;
    sha256: string;
    frontmatter: { name: string; description: string };
    content: string;
  };
}

export async function createSkillTrial(
  driver: SourceDriver,
  resolved: ResolvedSource,
  selectors: string[] | undefined,
): Promise<SkillTrial> {
  const scan = await driver.scan(resolved);
  if (!scan.ok) throw new Error("Skill trial blocked by source scan findings.");
  const selected = filterArtifactsBySelection(await driver.list(resolved), selectors);
  const skills = selected.filter((artifact) => artifact.type === "skills");
  if (skills.length !== 1) {
    throw new Error("Skill trial requires exactly one selected skill. Use --skill <name> or --select skills/<name>.");
  }
  const artifact = skills[0]!;
  const path = artifact.kind === "dir" ? join(artifact.sourcePath, "SKILL.md") : artifact.sourcePath;
  const info = await stat(path);
  if (info.size > MAX_TRIAL_SKILL_BYTES) {
    throw new Error(`Skill trial exceeds the ${MAX_TRIAL_SKILL_BYTES / 1024} KiB content limit.`);
  }
  const content = await readFile(path, "utf8");
  const frontmatter = readSkillFrontmatter(content, artifact);
  return {
    schemaVersion: 1,
    mode: "read-only",
    source: resolved.source,
    ...(resolved.resolvedCommit ? { resolvedCommit: resolved.resolvedCommit } : {}),
    findings: scan.findings,
    skill: {
      name: artifact.name,
      relativePath: artifact.relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      frontmatter,
      content,
    },
  };
}

function readSkillFrontmatter(content: string, artifact: Artifact): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Skill trial requires YAML frontmatter: ${artifact.relativePath}`);
  const parsed: unknown = parseYaml(match[1]!);
  if (!parsed || typeof parsed !== "object") throw new Error(`Skill trial frontmatter is invalid: ${artifact.relativePath}`);
  const value = parsed as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.description !== "string" || !value.description.trim()) {
    throw new Error(`Skill trial frontmatter needs name and description: ${artifact.relativePath}`);
  }
  return { name: value.name, description: value.description };
}
