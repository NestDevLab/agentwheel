import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { targetMappingForArtifact, type AdapterConfig, type TargetMapping } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { artifactSelectorKey, normalizeArtifactSelectors } from "../model/selection.js";
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
  message?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type YamlRecord = Record<string, unknown>;

const behavioralRuleFormats = ["markdown-rule", "claude-markdown-rule", "copilot-instruction-rule"];
const pluginFormats = ["claude-plugin", "codex-plugin", "hermes-plugin", "copilot-plugin", "openclaw-plugin"];

export async function filterArtifactsByInstallFormat<T extends Artifact>(
  artifacts: T[],
  adapter: AdapterConfig,
  installationType: string,
  options: {
    selected?: string[];
    warn?: (message: string) => void;
  } = {},
): Promise<T[]> {
  const selectedSet = new Set(normalizeArtifactSelectors(options.selected ?? []) ?? []);
  const kept: T[] = [];
  const skipped: Array<{ artifact: T; compatibility: ArtifactFormatCompatibility }> = [];
  let installableCount = 0;

  for (const artifact of artifacts) {
    if (artifact.type === "fragments") {
      kept.push(artifact);
      continue;
    }
    const target = targetMappingForArtifact(adapter, artifact.type, installationType);
    if (!target?.enabled) {
      if (artifact.type === "rules") {
        skipped.push({
          artifact,
          compatibility: {
            compatible: false,
            knownIncompatible: true,
            expected: behavioralRuleFormats,
            message: "target does not support behavioral Markdown rules",
          },
        });
        continue;
      }
      kept.push(artifact);
      continue;
    }
    const compatibility = await artifactFormatCompatibility(artifact, target);
    if (compatibility.knownIncompatible) {
      skipped.push({ artifact, compatibility });
      continue;
    }
    kept.push(artifact);
    installableCount += 1;
  }

  if (installableCount === 0 && skipped.length > 0) return artifacts;

  for (const item of skipped) {
    options.warn?.(formatSkipWarning(item.artifact, item.compatibility, adapter, installationType, selectedSet));
  }
  return kept;
}

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
    if (!format) {
      issues.push({
        artifact,
        message: `format is unknown; expected one of: ${compatibility.expected.join(", ")}`,
      });
    } else if (!compatibility.compatible) {
      issues.push({
        artifact,
        message: compatibility.message ?? `format '${format}' is not compatible; expected one of: ${compatibility.expected.join(", ")}`,
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
  const format = artifact.format ?? await inferArtifactFormat(artifact, target) ?? semanticDefaultFormat(artifact, target);
  const expected = expectedFormats(artifact, target);
  if (!expected?.length) return { compatible: true, knownIncompatible: false, format };
  if (!format) return { compatible: false, knownIncompatible: false, expected };
  if (artifact.type === "rules" && target.formats?.length && target.formats.every((item) => !behavioralRuleFormats.includes(item))) {
    return {
      compatible: false,
      knownIncompatible: true,
      format,
      expected,
      message: `target does not support behavioral Markdown rules; expected one of: ${expected.join(", ")}`,
    };
  }
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
    if (artifact.format === "codex-command-policy" || hasExtension(artifact, ".rules")) return "codex-command-policy";
    if (hasExtension(artifact, ".md") || hasExtension(artifact, ".markdown")) return "markdown-rule";
    return undefined;
  }

  if (artifact.type === "plugins" && target.semantic === "openclaw-plugin") {
    if (artifact.kind === "dir" && (await openClawPluginManifestPaths(artifact)).length > 0) return "openclaw-plugin";
  }

  return undefined;
}

function semanticDefaultFormat(artifact: Artifact, target: TargetMapping): string | undefined {
  if (artifact.type === "plugins" && isPluginFormat(target.semantic)) return target.semantic;
  return undefined;
}

function expectedFormats(artifact: Artifact, target: TargetMapping): string[] | undefined {
  if (artifact.type === "rules") {
    const declared = target.formats?.filter((format) => behavioralRuleFormats.includes(format));
    if (target.formats?.length) return declared?.length ? declared : behavioralRuleFormats;
    return behavioralRuleFormats;
  }
  if (artifact.type === "plugins") {
    if (isPluginFormat(target.semantic)) return [target.semantic];
    const declared = target.formats?.filter((format) => pluginFormats.includes(format));
    if (target.formats?.length) return declared?.length ? declared : pluginFormats;
  }
  return target.formats;
}

async function validateKnownFormat(
  artifact: Artifact,
  format: string | undefined,
  target: TargetMapping,
): Promise<ArtifactValidationIssue[]> {
  if (!format) return [];
  if (format === "markdown-rule" || format === "claude-markdown-rule" || format === "copilot-instruction-rule") {
    return validateMarkdownRule(artifact, format);
  }
  if (format === "openclaw-plugin" || target.semantic === "openclaw-plugin") {
    return validateOpenClawPlugin(artifact);
  }
  if (format === "claude-plugin" || target.semantic === "claude-plugin") {
    return validateJsonPluginDescriptor(artifact, ".claude-plugin/plugin.json", "Claude");
  }
  if (format === "codex-plugin" || target.semantic === "codex-plugin") {
    return validateJsonPluginDescriptor(artifact, ".codex-plugin/plugin.json", "Codex");
  }
  if (format === "copilot-plugin" || target.semantic === "copilot-plugin") {
    return validateJsonPluginDescriptor(artifact, "plugin.json", "Copilot");
  }
  if (format === "hermes-plugin" || target.semantic === "hermes-plugin") {
    return validateHermesPlugin(artifact);
  }
  if (pluginFormats.includes(format)) return validatePluginArtifact(artifact, format);
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

  if (target.merge === "yaml-deep") {
    const parsed = await parseYamlObjectArtifact(artifact);
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

function validatePluginArtifact(artifact: Artifact, format: string): ArtifactValidationIssue[] {
  const issues: ArtifactValidationIssue[] = [];
  if (artifact.type !== "plugins") {
    issues.push({ artifact, message: `${format} format is only valid for plugins artifacts` });
  }
  if (artifact.kind !== "dir") {
    issues.push({ artifact, message: `${format} plugins must be directory artifacts` });
  }
  return issues;
}

async function validateJsonPluginDescriptor(artifact: Artifact, relativeManifestPath: string, label: string): Promise<ArtifactValidationIssue[]> {
  const generic = validatePluginArtifact(artifact, `${label.toLowerCase()}-plugin`);
  if (generic.length > 0) return generic;
  const manifestPath = join(artifactPath(artifact), relativeManifestPath);
  if (!(await pathExists(manifestPath))) {
    return [{ artifact, message: `${label} plugins must contain ${relativeManifestPath}` }];
  }
  const parsed = await parseJsonPluginManifest(manifestPath, label);
  return parsed.ok ? [] : [{ artifact, message: parsed.message }];
}

async function validateHermesPlugin(artifact: Artifact): Promise<ArtifactValidationIssue[]> {
  const generic = validatePluginArtifact(artifact, "hermes-plugin");
  if (generic.length > 0) return generic;
  const root = artifactPath(artifact);
  const manifestPaths = [join(root, "plugin.yaml"), join(root, "plugin.yml")];
  const manifestPath = await firstExistingPath(manifestPaths);
  if (!manifestPath) {
    return [{ artifact, message: "Hermes plugins must contain plugin.yaml or plugin.yml" }];
  }
  try {
    const document = parseDocument(await readFile(manifestPath, "utf8"));
    if (document.errors.length > 0) {
      return [{ artifact, message: `Hermes ${basename(manifestPath)} must be valid YAML: ${document.errors[0]?.message ?? "parse error"}` }];
    }
    const parsed = document.toJSON() as unknown;
    if (!isUnknownRecord(parsed)) {
      return [{ artifact, message: `Hermes ${basename(manifestPath)} must contain a YAML object` }];
    }
    if (!hasStringField(parsed, "name") && !hasStringField(parsed, "module") && !hasStringField(parsed, "package") && !hasNestedPackageName(parsed)) {
      return [{ artifact, message: `Hermes ${basename(manifestPath)} must declare a non-empty name, module, or package name` }];
    }
    return [];
  } catch (error) {
    return [{ artifact, message: `Hermes ${basename(manifestPath)} must be valid YAML: ${errorMessage(error)}` }];
  }
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

async function parseJsonPluginManifest(
  manifestPath: string,
  label: string,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as JsonValue;
    if (!isRecord(parsed)) {
      return { ok: false, message: `${label} ${basename(manifestPath)} must be a JSON object` };
    }
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
      return { ok: false, message: `${label} ${basename(manifestPath)} must declare a non-empty name` };
    }
    return { ok: true, name: parsed.name.trim() };
  } catch (error) {
    return { ok: false, message: `${label} ${basename(manifestPath)} must be valid JSON: ${errorMessage(error)}` };
  }
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

async function parseYamlObjectArtifact(artifact: Artifact): Promise<{ ok: true; value: YamlRecord } | { ok: false; message: string }> {
  if (artifact.kind !== "file") {
    return { ok: false, message: "merge artifacts must be YAML files" };
  }
  try {
    const document = parseDocument(await readFile(artifactPath(artifact), "utf8"));
    if (document.errors.length > 0) {
      return { ok: false, message: `merge artifact must be valid YAML: ${document.errors[0]?.message ?? "parse error"}` };
    }
    const parsed = document.toJSON() as unknown;
    if (!isUnknownRecord(parsed)) return { ok: false, message: "merge artifacts must contain a YAML object" };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `merge artifact must be valid YAML: ${errorMessage(error)}` };
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

function isPluginFormat(value: string | undefined): value is typeof pluginFormats[number] {
  return value !== undefined && pluginFormats.includes(value);
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is YamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringField(value: YamlRecord, field: string): boolean {
  const raw = value[field];
  return typeof raw === "string" && raw.trim().length > 0;
}

function hasNestedPackageName(value: YamlRecord): boolean {
  const raw = value.package;
  return isUnknownRecord(raw) && hasStringField(raw, "name");
}

function formatSkipWarning(
  artifact: Artifact,
  compatibility: ArtifactFormatCompatibility,
  adapter: AdapterConfig,
  installationType: string,
  selectedSet: Set<string>,
): string {
  const selector = artifactSelectorKey(artifact);
  const reason = selectedSet.has(selector) ? "selected but format-incompatible" : "format-incompatible";
  const expected = compatibility.expected?.join(", ") ?? "supported format";
  const format = compatibility.format ?? "unknown";
  const details = compatibility.message ?? `${adapter.name}/${installationType} expects ${expected}, got ${format}`;
  return `skip ${selector} (${reason}: ${details})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
