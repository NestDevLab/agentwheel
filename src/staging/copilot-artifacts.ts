import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

export async function renderCopilotArtifacts(
  artifacts: Artifact[],
  stageRoot: string,
  adapter?: AdapterConfig,
): Promise<Artifact[]> {
  if (adapter?.name !== "copilot") return artifacts;

  const names = new Set<string>();
  const rendered: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== "subagents") {
      rendered.push(artifact);
      continue;
    }

    const next = await renderCopilotSubagent(artifact, stageRoot);
    if (names.has(next.name)) {
      throw new Error(`Copilot subagents produce duplicate custom agent name '${next.name}'.`);
    }
    names.add(next.name);
    rendered.push(next);
  }
  return rendered;
}

async function renderCopilotSubagent(artifact: Artifact, stageRoot: string): Promise<Artifact> {
  const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
  const agentName = copilotAgentName(artifact);
  const renderedPath = join(stageRoot, ".agentwheel-rendered", "copilot-subagents", `${agentName}.agent.md`);
  const markdownPath = artifact.kind === "dir" ? join(sourcePath, "AGENTS.md") : sourcePath;

  if (artifact.kind === "dir" && !(await pathExists(markdownPath))) {
    throw new Error(`Copilot subagent directory ${artifact.relativePath} must contain AGENTS.md.`);
  }
  if (artifact.kind === "file" && !artifact.name.toLowerCase().endsWith(".md")) {
    throw new Error(`Copilot subagent ${artifact.relativePath} must be a .md file or directory containing AGENTS.md.`);
  }

  const markdown = await readFile(markdownPath, "utf8");
  await mkdir(dirname(renderedPath), { recursive: true });
  await writeFile(renderedPath, ensureCopilotAgentDescription(agentName, markdown), "utf8");

  return {
    ...artifact,
    name: `${agentName}.agent.md`,
    sourcePath: renderedPath,
    stagedPath: renderedPath,
    relativePath: join("subagents", `${agentName}.agent.md`),
    kind: "file",
    hash: await hashPath(renderedPath),
  };
}

function copilotAgentName(artifact: Artifact): string {
  const raw = artifact.kind === "dir" ? artifact.name : basename(artifact.name);
  return raw
    .replace(/\.agent\.md$/i, "")
    .replace(/\.md$/i, "");
}

function ensureCopilotAgentDescription(agentName: string, markdown: string): string {
  const parsed = splitFrontmatter(markdown);
  if (parsed.frontmatter !== undefined && /^description\s*:/im.test(parsed.frontmatter)) {
    return markdown;
  }

  const description = firstMeaningfulMarkdownLine(parsed.body) ?? `Custom Copilot agent ${agentName}.`;
  const frontmatter = parsed.frontmatter === undefined
    ? `description: ${yamlString(description)}`
    : `${parsed.frontmatter.trimEnd()}\ndescription: ${yamlString(description)}`;
  return [
    "---",
    frontmatter,
    "---",
    "",
    parsed.body.trimStart(),
  ].join("\n");
}

function splitFrontmatter(markdown: string): { body: string; frontmatter?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { body: markdown };
  return {
    body: markdown.slice(match[0].length),
    frontmatter: match[1] ?? "",
  };
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

function yamlString(value: string): string {
  return JSON.stringify(value);
}
