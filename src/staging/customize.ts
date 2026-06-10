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
  packageVersion?: string;
  graphNodeId?: string;
  packageNameAmbiguous?: boolean;
}

export async function applyCustomizations(artifacts: Artifact[], options: CustomizationOptions): Promise<Artifact[]> {
  let next = [...artifacts];
  next = await applyReplacements(next, options, "override", installableArtifactTypes());
  next = await applyReplacements(next, options, "ejected", installableArtifactTypes());
  next = await applyAdditions(next, options);
  next = await applyInstructionOverlay(next, options);
  return next.sort((a, b) => `${a.type}:${a.name}:${a.channel}`.localeCompare(`${b.type}:${b.name}:${b.channel}`));
}

export async function applyFragmentCustomizations(artifacts: Artifact[], options: CustomizationOptions): Promise<Artifact[]> {
  let next = [...artifacts];
  next = await applyReplacements(next, options, "override", ["fragments"]);
  next = await applyReplacements(next, options, "ejected", ["fragments"]);
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
  artifactTypes: ArtifactType[],
): Promise<Artifact[]> {
  const packageName = options.packageName;
  if (!packageName) return artifacts;

  const byKey = new Map(artifacts.map((artifact) => [artifactKey(artifact), artifact]));
  const roots = replacementRoots(options, channel);
  if (roots.length === 0) return artifacts;
  const seen = new Set<string>();

  for (const { root, kind: rootKind } of roots) {
    if (!(await pathExists(root))) continue;
    if (rootKind === "package" && options.packageNameAmbiguous) {
      throw new Error(
        `Ambiguous ${channel} shorthand for ${packageName}; multiple graph nodes share this package name. `
        + `Use .agentwheel/${channel === "override" ? "overrides" : "ejected"}/${options.graphNodeId}/... `
        + `or .agentwheel/${channel === "override" ? "overrides" : "ejected"}/${packageName}@${options.packageVersion}/...`,
      );
    }
    for (const type of artifactTypes) {
      const typeRoot = join(root, type);
      if (!(await pathExists(typeRoot))) continue;
      for (const entry of await sortedDirEntries(typeRoot)) {
        const artifactMapKey = `${type}:${entry.name}`;
        if (seen.has(artifactMapKey)) continue;
        seen.add(artifactMapKey);
        const full = join(typeRoot, entry.name);
        const artifactKind = entry.isDirectory() ? "dir" : "file";
        const existing = byKey.get(artifactMapKey);
        const stagedPath = join(options.stageRoot, ".agentwheel-composed", channel, type, entry.name);
        await mkdir(dirname(stagedPath), { recursive: true });
        await cp(full, stagedPath, { recursive: artifactKind === "dir", dereference: true });
        byKey.set(artifactMapKey, {
          ...existing,
          type,
          name: entry.name,
          sourcePath: full,
          stagedPath,
          relativePath: existing?.relativePath ?? join(type, entry.name),
          kind: artifactKind,
          hash: await hashPath(stagedPath),
          packageName,
          channel,
        });
      }
    }
  }
  return [...byKey.values()];
}

function replacementRoots(
  options: CustomizationOptions,
  channel: "override" | "ejected",
): Array<{ root: string; kind: "node" | "version" | "package" }> {
  const stateDir = channel === "override" ? "overrides" : "ejected";
  const roots: Array<{ root: string; kind: "node" | "version" | "package" }> = [];
  if (options.graphNodeId) {
    roots.push({ root: join(options.workspaceRoot, ".agentwheel", stateDir, ...options.graphNodeId.split("/")), kind: "node" });
  }
  if (options.packageName && options.packageVersion) {
    roots.push({ root: join(options.workspaceRoot, ".agentwheel", stateDir, ...`${options.packageName}@${options.packageVersion}`.split("/")), kind: "version" });
  }
  if (options.packageName) {
    roots.push({ root: join(options.workspaceRoot, ".agentwheel", stateDir, ...options.packageName.split("/")), kind: "package" });
  }
  return roots;
}

function artifactKey(artifact: Artifact): string {
  return `${artifact.type}:${artifact.name}`;
}

function installableArtifactTypes(): ArtifactType[] {
  return ["instructions", "rules", "skills", "commands", "subagents", "mcp", "hooks", "settings", "plugins"];
}

async function sortedDirEntries(path: string) {
  return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}
