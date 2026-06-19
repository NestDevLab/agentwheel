import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { targetMappingForArtifact, type AdapterConfig, type TargetMapping } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { pathExists } from "../utils/fs.js";

interface ArtifactValidationIssue {
  artifact: Artifact;
  message: string;
}

export interface ArtifactFormatCompatibility {
  compatible: boolean;
  knownIncompatible: boolean;
  format?: string;
  expected?: string[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export async function validateArtifactsForInstall(
  artifacts: Artifact[],
  adapter: AdapterConfig,
  installationType: string,
): Promise<void> {
  const issues: ArtifactValidationIssue[] = [];
  for (const artifact of artifacts) {
    if (artifact.type === "fragments") continue;
    const target = targetMappingForArtifact(adapter, artifact.type, installationType);
    if (!target?.enabled) {
      issues.push({ artifact, message: `adapter ${adapter.name} does not support this artifact for installation type '${installationType}'` });
      continue;
    }
    issues.push(...await validateArtifact(artifact, target));
  }

  if (issues.length === 0) return;
  throw new Error([
    `Package artifacts are not installable for ${adapter.name}/${installationType}:`,
    ...issues.map((issue) => `- ${artifactLabel(issue.artifact)}: ${issue.message}`),
  ].join("\n"));
}

async function validateArtifact(artifact: Artifact, target: TargetMapping): Promise<ArtifactValidationIssue[]> {
  const issues: ArtifactValidationIssue[] = [];
  const compatibility = await artifactFormatCompatibility(artifact, target);
  const format = compatibility.format;

  if (compatibility.expected?.length) {
    if (!compatibility.format) {
      issues.push({
        artifact,
        message: `format is unknown; expected one of: ${compatibility.expected.join(", ")}`,
      });
    } else if (!compatibility.compatible) {
      issues.push({
        artifact,
        message: `format '${format}' is not compatible; expected one of: ${compatibility.expected.join(", ")}`,
      });
    }
  }

  issues.push(...await validateKnownFormat(artifact, format, target));
  issues.push(...await validateGenericStructure(artifact, target));
  return issues;
}

export async function artifactFormatCompatibility(
  artifact: Artifact,
  target: TargetMapping,
): Promise<ArtifactFormatCompatibility> {
  const format = artifact.format ?? await inferArtifactFormat(artifact, target) ?? semanticDefaultFormat(target);
  const expected = target.formats;
  if (!expected?.length) return { compatible: true, knownIncompatible: false, format };
  if (!format) return { compatible: false, knownIncompatible: false, expected };
  const compatible = expected.includes(format);
  return {
    compatible,
    knownIncompatible: !compatible,
    format,
    expected,
  };
}

async function inferArtifactFormat(artifact: Artifact, target: TargetMapping): Promise<string | undefined> {
  if (artifact.type === "rules") {
    if (hasExtension(artifact, ".rules")) return "codex-command-policy";
    if (hasExtension(artifact, ".md") || hasExtension(artifact, ".markdown")) return "markdown-rule";
    return undefined;
  }

  if (artifact.type === "plugins" && target.semantic === "openclaw-plugin") {
    if (artifact.kind === "dir" && (await openClawPluginManifestPaths(artifact)).length > 0) return "openclaw-plugin";
  }

  return undefined;
}

function semanticDefaultFormat(target: TargetMapping): string | undefined {
  if (target.semantic === "openclaw-plugin") return "openclaw-plugin";
  return undefined;
}

async function validateKnownFormat(
  artifact: Artifact,
  format: string | undefined,
  target: TargetMapping,
): Promise<ArtifactValidationIssue[]> {
  if (!format) return [];
  if (format === "codex-command-policy") return validateCodexCommandPolicyRule(artifact);
  if (format === "markdown-rule" || format === "claude-markdown-rule" || format === "copilot-instruction-rule") {
    return validateMarkdownRule(artifact, format);
  }
  if (format === "openclaw-plugin" || target.semantic === "openclaw-plugin") {
    return validateOpenClawPlugin(artifact);
  }
  return [];
}

async function validateGenericStructure(artifact: Artifact, target: TargetMapping): Promise<ArtifactValidationIssue[]> {
  const issues: ArtifactValidationIssue[] = [];
  if (artifact.type === "skills") {
    if (artifact.kind === "dir") {
      const skillMd = join(artifactPath(artifact), "SKILL.md");
      if (!(await pathExists(skillMd))) {
        issues.push({ artifact, message: "skill directory must contain SKILL.md" });
      } else {
        issues.push(...await validateSkillFrontmatter(artifact, skillMd));
      }
    } else if (!hasExtension(artifact, ".md")) {
      issues.push({ artifact, message: "file skill artifacts must be Markdown files" });
    } else {
      issues.push(...await validateSkillFrontmatter(artifact, artifactPath(artifact)));
    }
  }

  if (target.merge === "json-deep") {
    const parsed = await parseJsonObjectArtifact(artifact);
    if (!parsed.ok) issues.push({ artifact, message: parsed.message });
  }

  if (target.merge === "codex-toml-mcp") {
    const parsed = await parseJsonObjectArtifact(artifact);
    if (!parsed.ok) {
      issues.push({ artifact, message: parsed.message });
    } else if (Object.keys(extractMcpServers(parsed.value)).length === 0) {
      issues.push({ artifact, message: "Codex MCP artifact must contain at least one server object, either under mcpServers or as top-level server entries" });
    }
  }
  return issues;
}

// Codex and other harnesses silently skip a skill whose SKILL.md does not begin
// with YAML frontmatter at byte 0 (no BOM, no content before the first `---`).
async function validateSkillFrontmatter(artifact: Artifact, skillMdPath: string): Promise<ArtifactValidationIssue[]> {
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf8");
  } catch (error) {
    return [{ artifact, message: `could not read SKILL.md: ${errorMessage(error)}` }];
  }

  if (content.charCodeAt(0) === 0xfeff) {
    return [{ artifact, message: "SKILL.md must not start with a UTF-8 BOM; YAML frontmatter must be the first bytes" }];
  }

  const isDelimiter = (line: string): boolean => line.trimEnd() === "---";
  const lines = content.split(/\r?\n/);
  if (!isDelimiter(lines[0] ?? "")) {
    return [{ artifact, message: "SKILL.md must begin with YAML frontmatter delimited by '---' on the first line (no content before it)" }];
  }
  const closing = lines.findIndex((line, index) => index > 0 && isDelimiter(line));
  if (closing === -1) {
    return [{ artifact, message: "SKILL.md frontmatter is not closed with a '---' delimiter" }];
  }

  const issues: ArtifactValidationIssue[] = [];
  const frontmatter = lines.slice(1, closing);
  if (!frontmatter.some((line) => /^name\s*:/.test(line))) {
    issues.push({ artifact, message: "SKILL.md frontmatter must define 'name'" });
  }
  if (!frontmatter.some((line) => /^description\s*:/.test(line))) {
    issues.push({ artifact, message: "SKILL.md frontmatter must define 'description'" });
  }
  return issues;
}

async function validateCodexCommandPolicyRule(artifact: Artifact): Promise<ArtifactValidationIssue[]> {
  const issues: ArtifactValidationIssue[] = [];
  if (artifact.type !== "rules") {
    return [{ artifact, message: "codex-command-policy format is only valid for rules artifacts" }];
  }
  if (artifact.kind !== "file") {
    issues.push({ artifact, message: "Codex command-policy rules must be files" });
  }
  if (!hasExtension(artifact, ".rules")) {
    issues.push({ artifact, message: "Codex command-policy rules must use the .rules extension" });
  }
  const content = await readUtf8Artifact(artifact, issues);
  if (content === undefined) return issues;
  if (!/\bprefix_rule\s*\(/.test(content)) {
    issues.push({ artifact, message: "Codex command-policy rules must contain at least one prefix_rule(...)" });
  }
  if (/\bprefix_rule\s*\(/.test(content) && !/\bpattern\s*=/.test(content)) {
    issues.push({ artifact, message: "Codex command-policy rules must define a pattern field" });
  }
  for (const match of content.matchAll(/\bdecision\s*=\s*["']([^"']+)["']/g)) {
    const decision = match[1];
    if (decision !== "allow" && decision !== "prompt" && decision !== "forbidden") {
      issues.push({ artifact, message: `Codex command-policy decision '${decision}' must be allow, prompt, or forbidden` });
    }
  }
  return issues;
}

function validateMarkdownRule(artifact: Artifact, format: string): ArtifactValidationIssue[] {
  const label = format === "copilot-instruction-rule"
    ? "Copilot instruction rules"
    : format === "claude-markdown-rule"
      ? "Claude markdown rules"
      : "Markdown rules";
  const issues: ArtifactValidationIssue[] = [];
  if (artifact.type !== "rules") {
    issues.push({ artifact, message: `${format} format is only valid for rules artifacts` });
  }
  if (artifact.kind !== "file") {
    issues.push({ artifact, message: `${label} must be files` });
  }
  if (!hasExtension(artifact, ".md") && !hasExtension(artifact, ".markdown")) {
    issues.push({ artifact, message: `${label} must use a Markdown extension` });
  }
  return issues;
}

async function validateOpenClawPlugin(artifact: Artifact): Promise<ArtifactValidationIssue[]> {
  const issues: ArtifactValidationIssue[] = [];
  if (artifact.type !== "plugins") {
    return [{ artifact, message: "openclaw-plugin format is only valid for plugins artifacts" }];
  }
  if (artifact.kind !== "dir") {
    return [{ artifact, message: "OpenClaw plugins must be directory artifacts" }];
  }

  const manifestPaths = await openClawPluginManifestPaths(artifact);
  if (manifestPaths.length === 0) {
    return [{ artifact, message: "OpenClaw plugins must contain plugin.json or openclaw.plugin.json" }];
  }
  const parsed = await Promise.all(manifestPaths.map(async (manifestPath) => {
    const result = await parseOpenClawPluginManifest(manifestPath);
    if (!result.ok) issues.push({ artifact, message: result.message });
    return result;
  }));
  const names = new Set(parsed.filter((result): result is { ok: true; path: string; name: string } => result.ok).map((result) => result.name));
  if (names.size > 1) {
    issues.push({ artifact, message: "OpenClaw plugin descriptors must declare the same name" });
  }
  return issues;
}

async function openClawPluginManifestPaths(artifact: Artifact): Promise<string[]> {
  const root = artifactPath(artifact);
  const candidates = [join(root, "plugin.json"), join(root, "openclaw.plugin.json")];
  const existing = await Promise.all(candidates.map(async (candidate) => await pathExists(candidate) ? candidate : undefined));
  return existing.filter((candidate): candidate is string => candidate !== undefined);
}

async function parseOpenClawPluginManifest(
  manifestPath: string,
): Promise<{ ok: true; path: string; name: string } | { ok: false; path: string; message: string }> {
  const manifestName = basename(manifestPath);
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as JsonValue;
    if (!isRecord(parsed)) {
      return { ok: false, path: manifestPath, message: `OpenClaw ${manifestName} must be a JSON object` };
    }
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
      return { ok: false, path: manifestPath, message: `OpenClaw ${manifestName} must declare a non-empty name` };
    }
    return { ok: true, path: manifestPath, name: parsed.name.trim() };
  } catch (error) {
    return { ok: false, path: manifestPath, message: `OpenClaw ${manifestName} must be valid JSON: ${errorMessage(error)}` };
  }
}

async function readUtf8Artifact(artifact: Artifact, issues: ArtifactValidationIssue[]): Promise<string | undefined> {
  if (artifact.kind !== "file") return undefined;
  try {
    return await readFile(artifactPath(artifact), "utf8");
  } catch (error) {
    issues.push({ artifact, message: `could not read artifact: ${errorMessage(error)}` });
    return undefined;
  }
}

async function parseJsonObjectArtifact(artifact: Artifact): Promise<{ ok: true; value: JsonRecord } | { ok: false; message: string }> {
  if (artifact.kind !== "file") {
    return { ok: false, message: "merge artifacts must be JSON files" };
  }
  try {
    const parsed = JSON.parse(await readFile(artifactPath(artifact), "utf8")) as JsonValue;
    if (!isRecord(parsed)) return { ok: false, message: "merge artifacts must contain a JSON object" };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `merge artifact must be valid JSON: ${errorMessage(error)}` };
  }
}

function extractMcpServers(source: JsonRecord): Record<string, JsonRecord> {
  const raw = isRecord(source.mcpServers) ? source.mcpServers : source;
  const servers: Record<string, JsonRecord> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isRecord(value)) servers[name] = value;
  }
  return servers;
}

function artifactPath(artifact: Artifact): string {
  return artifact.stagedPath ?? artifact.sourcePath;
}

function artifactLabel(artifact: Artifact): string {
  const owner = artifact.packageName ? `${artifact.packageName}:` : "";
  return `${owner}${artifact.type}/${artifact.name}`;
}

function hasExtension(artifact: Artifact, extension: string): boolean {
  return basename(artifact.name).toLowerCase().endsWith(extension)
    || basename(artifactPath(artifact)).toLowerCase().endsWith(extension);
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
