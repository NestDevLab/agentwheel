import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

const requiredCodexAgentFields = ["name", "description", "developer_instructions"] as const;

export async function renderCodexSubagents(
  artifacts: Artifact[],
  stageRoot: string,
  adapter?: AdapterConfig,
): Promise<Artifact[]> {
  if (adapter?.name !== "codex") return artifacts;

  const names = new Set<string>();
  const rendered: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== "subagents") {
      rendered.push(artifact);
      continue;
    }

    const next = await renderCodexSubagent(artifact, stageRoot);
    if (names.has(next.name)) {
      throw new Error(`Codex subagents produce duplicate custom agent name '${next.name}'.`);
    }
    names.add(next.name);
    rendered.push(next);
  }
  return rendered;
}

async function renderCodexSubagent(artifact: Artifact, stageRoot: string): Promise<Artifact> {
  const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
  const agentName = codexAgentName(artifact);
  const renderedPath = join(stageRoot, ".agentwheel-rendered", "codex-subagents", `${agentName}.toml`);

  const lowerSourcePath = sourcePath.toLowerCase();
  if (artifact.kind === "file" && (artifact.name.toLowerCase().endsWith(".toml") || lowerSourcePath.endsWith(".toml"))) {
    const content = await readFile(sourcePath, "utf8");
    validateCodexAgentToml(content, sourcePath);
    return {
      ...artifact,
      name: agentName,
      relativePath: join("subagents", `${agentName}.toml`),
      kind: "file",
      hash: await hashPath(sourcePath),
    };
  }

  const markdownPath = artifact.kind === "dir" ? join(sourcePath, "AGENTS.md") : sourcePath;
  if (artifact.kind === "dir" && !(await pathExists(markdownPath))) {
    throw new Error(`Codex subagent directory ${artifact.relativePath} must contain AGENTS.md.`);
  }
  if (artifact.kind === "file" && !artifact.name.toLowerCase().endsWith(".md") && !lowerSourcePath.endsWith(".md")) {
    throw new Error(`Codex subagent ${artifact.relativePath} must be a .toml file, .md file, or directory containing AGENTS.md.`);
  }

  const markdown = await readFile(markdownPath, "utf8");
  const toml = markdownToCodexAgentToml(agentName, markdown);
  await mkdir(dirname(renderedPath), { recursive: true });
  await writeFile(renderedPath, toml, "utf8");

  return {
    ...artifact,
    name: agentName,
    sourcePath: renderedPath,
    stagedPath: renderedPath,
    relativePath: join("subagents", `${agentName}.toml`),
    kind: "file",
    hash: await hashPath(renderedPath),
  };
}

function codexAgentName(artifact: Artifact): string {
  const raw = artifact.kind === "dir" ? artifact.name : basename(artifact.name);
  return raw
    .replace(/\.toml$/i, "")
    .replace(/\.md$/i, "");
}

function validateCodexAgentToml(content: string, path: string): void {
  for (const field of requiredCodexAgentFields) {
    const pattern = new RegExp(`(^|\\n)\\s*${escapeRegExp(field)}\\s*=`, "m");
    if (!pattern.test(content)) {
      throw new Error(`Codex custom agent TOML ${path} is missing required field '${field}'.`);
    }
  }
}

function markdownToCodexAgentToml(agentName: string, markdown: string): string {
  const parsed = splitFrontmatter(markdown);
  const description = parsed.description ?? firstMeaningfulMarkdownLine(parsed.body) ?? `Custom Codex subagent ${agentName}.`;
  const developerInstructions = parsed.body.trim().length > 0 ? parsed.body.trimEnd() : description;
  const lines = [
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(description)}`,
  ];
  if (parsed.model) lines.push(`model = ${tomlString(parsed.model)}`);
  if (parsed.modelReasoningEffort) lines.push(`model_reasoning_effort = ${tomlString(parsed.modelReasoningEffort)}`);
  lines.push(`developer_instructions = ${tomlMultilineString(developerInstructions)}`, "");
  return lines.join("\n");
}

function splitFrontmatter(markdown: string): {
  body: string;
  description?: string;
  model?: string;
  modelReasoningEffort?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { body: markdown };

  const frontmatter = match[1] ?? "";
  const body = markdown.slice(match[0].length);
  const metadata = parseYaml(frontmatter) as Record<string, unknown> | null;
  return {
    body,
    description: optionalFrontmatterString(metadata, "description"),
    model: optionalFrontmatterString(metadata, "model"),
    modelReasoningEffort: optionalFrontmatterString(metadata, "model_reasoning_effort"),
  };
}

function optionalFrontmatterString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`Codex subagent frontmatter field '${key}' must be a string.`);
  }
  return value.trim();
}

function firstMeaningfulMarkdownLine(markdown: string): string | undefined {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    return (heading?.[1] ?? line).trim();
  }
  return undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlMultilineString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"""', '\\"\\"\\"')
    .replace(/\r\n?/g, "\n");
  return `"""\n${escaped.endsWith("\n") ? escaped : `${escaped}\n`}"""`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
