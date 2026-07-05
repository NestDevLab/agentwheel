import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

export async function renderOpenClawSubagents(
  artifacts: Artifact[],
  stageRoot: string,
  adapter?: AdapterConfig,
): Promise<Artifact[]> {
  if (adapter?.name !== "openclaw") return artifacts;

  const names = new Set<string>();
  const rendered: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== "subagents") {
      rendered.push(artifact);
      continue;
    }

    const next = await renderOpenClawSubagent(artifact, stageRoot);
    if (names.has(next.name)) {
      throw new Error(`OpenClaw subagents produce duplicate agent id '${next.name}'.`);
    }
    names.add(next.name);
    rendered.push(next);
  }
  return rendered;
}

async function renderOpenClawSubagent(artifact: Artifact, stageRoot: string): Promise<Artifact> {
  const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
  const agentId = openClawAgentId(artifact);
  const markdownPath = artifact.kind === "dir" ? join(sourcePath, "AGENTS.md") : sourcePath;
  if (artifact.kind === "dir" && !(await pathExists(markdownPath))) {
    throw new Error(`OpenClaw subagent directory ${artifact.relativePath} must contain AGENTS.md.`);
  }
  if (artifact.kind === "file" && !artifact.name.toLowerCase().endsWith(".md") && !sourcePath.toLowerCase().endsWith(".md")) {
    throw new Error(`OpenClaw subagent ${artifact.relativePath} must be a .md file or directory containing AGENTS.md.`);
  }

  const parsed = splitFrontmatter(await readFile(markdownPath, "utf8"));
  const body = parsed.body.trim().length > 0
    ? parsed.body.trim()
    : `# ${titleFromAgentId(agentId)}\n\n${parsed.description ?? `OpenClaw subagent ${agentId}.`}`;
  const renderedPath = join(stageRoot, ".agentwheel-rendered", "openclaw-subagents", agentId, "AGENTS.md");
  await mkdir(dirname(renderedPath), { recursive: true });
  await writeFile(renderedPath, `${body}\n`, "utf8");

  const renderedDir = dirname(renderedPath);
  return {
    ...artifact,
    name: agentId,
    sourcePath: renderedDir,
    stagedPath: renderedDir,
    relativePath: join("subagents", agentId),
    kind: "dir",
    hash: await hashPath(renderedDir),
  };
}

function openClawAgentId(artifact: Artifact): string {
  const raw = artifact.kind === "dir" ? artifact.name : basename(artifact.name);
  return raw
    .replace(/\.agent\.md$/i, "")
    .replace(/\.md$/i, "");
}

function splitFrontmatter(markdown: string): { body: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { body: markdown };

  const frontmatter = match[1] ?? "";
  const body = markdown.slice(match[0].length);
  const description = frontmatter
    .split(/\r?\n/)
    .map((line) => /^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/.exec(line.trim()))
    .find((item): item is RegExpExecArray => item !== null);
  return {
    body,
    description: description ? (description[1] ?? description[2] ?? description[3] ?? "").trim() : undefined,
  };
}

function titleFromAgentId(agentId: string): string {
  return agentId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
