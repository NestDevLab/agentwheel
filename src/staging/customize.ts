import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact, ArtifactType } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

export interface CustomizationOptions {
  workspaceRoot: string;
  adapter: AdapterConfig;
  stageRoot: string;
  packageName?: string;
}

export async function applyCustomizations(artifacts: Artifact[], options: CustomizationOptions): Promise<Artifact[]> {
  let next = [...artifacts];
  next = await applyReplacements(next, options, "override");
  next = await applyReplacements(next, options, "ejected");
  next = await applyAdditions(next, options);
  next = await applyInstructionOverlay(next, options);
  return next.sort((a, b) => `${a.type}:${a.name}:${a.channel}`.localeCompare(`${b.type}:${b.name}:${b.channel}`));
}

async function applyInstructionOverlay(artifacts: Artifact[], options: CustomizationOptions): Promise<Artifact[]> {
  const overlayPath = join(options.workspaceRoot, ".agentwheel", "overlays", options.adapter.name, "instructions.local.md");
  if (!(await pathExists(overlayPath))) return artifacts;
  const index = artifacts.findIndex((artifact) => artifact.type === "instructions");
  if (index < 0) return artifacts;

  const artifact = artifacts[index];
  const managed = await readFile(artifact.stagedPath ?? artifact.sourcePath, "utf8");
  const local = await readFile(overlayPath, "utf8");
  const composedPath = join(options.stageRoot, ".agentwheel-composed", "instructions", "AGENTS.md");
  await mkdir(dirname(composedPath), { recursive: true });
  await writeFile(
    composedPath,
    [
      "<!-- BEGIN agentwheel managed: upstream -->",
      managed.trimEnd(),
      "<!-- END agentwheel managed: upstream -->",
      "",
      "<!-- BEGIN agentwheel local: editable -->",
      local.trimEnd(),
      "<!-- END agentwheel local: editable -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const updated: Artifact = {
    ...artifact,
    sourcePath: composedPath,
    stagedPath: composedPath,
    relativePath: "instructions/AGENTS.md",
    name: "AGENTS.md",
    hash: await hashPath(composedPath),
    channel: "overlay",
  };
  return [...artifacts.slice(0, index), updated, ...artifacts.slice(index + 1)];
}

async function applyAdditions(artifacts: Artifact[], options: CustomizationOptions): Promise<Artifact[]> {
  const additionsRoot = join(options.workspaceRoot, ".agentwheel", "additions");
  const rulesRoot = join(additionsRoot, "rules");
  if (!(await pathExists(rulesRoot))) return artifacts;
  const additions: Artifact[] = [];
  for (const entry of await sortedDirEntries(rulesRoot)) {
    const full = join(rulesRoot, entry.name);
    if (!entry.isFile()) continue;
    additions.push({
      type: "rules",
      name: entry.name,
      sourcePath: full,
      stagedPath: full,
      relativePath: join("additions", "rules", entry.name),
      kind: "file",
      hash: await hashPath(full),
      packageName: options.packageName,
      channel: "addition",
    });
  }
  return [...artifacts, ...additions];
}

async function applyReplacements(
  artifacts: Artifact[],
  options: CustomizationOptions,
  channel: "override" | "ejected",
): Promise<Artifact[]> {
  const packageName = options.packageName;
  if (!packageName) return artifacts;
  const root = join(options.workspaceRoot, ".agentwheel", channel === "override" ? "overrides" : "ejected", ...packageName.split("/"));
  if (!(await pathExists(root))) return artifacts;

  const byKey = new Map(artifacts.map((artifact) => [artifactKey(artifact), artifact]));
  for (const type of ["instructions", "rules", "skills", "commands", "subagents", "mcp", "hooks", "settings", "plugins"] as ArtifactType[]) {
    const typeRoot = join(root, type);
    if (!(await pathExists(typeRoot))) continue;
    for (const entry of await sortedDirEntries(typeRoot)) {
      const full = join(typeRoot, entry.name);
      const kind = entry.isDirectory() ? "dir" : "file";
      const existing = byKey.get(`${type}:${entry.name}`);
      const stagedPath = join(options.stageRoot, ".agentwheel-composed", channel, type, entry.name);
      await mkdir(dirname(stagedPath), { recursive: true });
      await cp(full, stagedPath, { recursive: kind === "dir", dereference: true });
      byKey.set(`${type}:${entry.name}`, {
        type,
        name: entry.name,
        sourcePath: full,
        stagedPath,
        relativePath: existing?.relativePath ?? join(type, entry.name),
        kind,
        hash: await hashPath(stagedPath),
        packageName,
        channel,
      });
    }
  }
  return [...byKey.values()];
}

function artifactKey(artifact: Artifact): string {
  return `${artifact.type}:${artifact.name}`;
}

async function sortedDirEntries(path: string) {
  return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}
