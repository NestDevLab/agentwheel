import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

export async function renderClaudeSubagents(
  artifacts: Artifact[],
  stageRoot: string,
  adapter?: AdapterConfig,
): Promise<Artifact[]> {
  if (adapter?.name !== "claude") return artifacts;

  const names = new Set<string>();
  const rendered: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== "subagents") {
      rendered.push(artifact);
      continue;
    }

    const next = await renderClaudeSubagent(artifact, stageRoot);
    if (names.has(next.name)) {
      throw new Error(`Claude subagents produce duplicate agent name '${next.name}'.`);
    }
    names.add(next.name);
    rendered.push(next);
  }
  return rendered;
}

async function renderClaudeSubagent(artifact: Artifact, stageRoot: string): Promise<Artifact> {
  const sourcePath = artifact.stagedPath ?? artifact.sourcePath;
  const agentName = claudeAgentName(artifact);
  const markdownPath = artifact.kind === "dir" ? join(sourcePath, "AGENTS.md") : sourcePath;
  if (artifact.kind === "dir" && !(await pathExists(markdownPath))) {
    throw new Error(`Claude subagent directory ${artifact.relativePath} must contain AGENTS.md.`);
  }
  if (artifact.kind === "file" && !artifact.name.toLowerCase().endsWith(".md") && !sourcePath.toLowerCase().endsWith(".md")) {
    throw new Error(`Claude subagent ${artifact.relativePath} must be a .md file or directory containing AGENTS.md.`);
  }

  const content = await readFile(markdownPath, "utf8");
  const renderedPath = join(stageRoot, ".agentwheel-rendered", "claude-subagents", `${agentName}.md`);
  await mkdir(dirname(renderedPath), { recursive: true });
  await writeFile(renderedPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");

  return {
    ...artifact,
    name: `${agentName}.md`,
    sourcePath: renderedPath,
    stagedPath: renderedPath,
    relativePath: join("subagents", `${agentName}.md`),
    kind: "file",
    hash: await hashPath(renderedPath),
  };
}

function claudeAgentName(artifact: Artifact): string {
  const raw = artifact.kind === "dir" ? artifact.name : basename(artifact.name);
  return raw
    .replace(/\.agent\.md$/i, "")
    .replace(/\.md$/i, "");
}
