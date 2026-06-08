import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

export interface SkillPath {
  name?: string;
  path: string;
}

export async function artifactsFromSkillPaths(paths: SkillPath[], packageName?: string): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    const artifact = await artifactFromSkillPath(item, packageName);
    if (!artifact) continue;
    const key = `${artifact.name}:${artifact.sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push(artifact);
  }
  return artifacts.sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverSkillPaths(root: string): Promise<SkillPath[]> {
  const paths: SkillPath[] = [];
  await walk(root, paths);
  return paths;
}

async function artifactFromSkillPath(item: SkillPath, packageName?: string): Promise<Artifact | undefined> {
  const stats = await stat(item.path);
  if (stats.isDirectory()) {
    const skillMd = join(item.path, "SKILL.md");
    if (!(await pathExists(skillMd))) return undefined;
    const name = sanitizeSkillName(item.name ?? basename(item.path));
    return {
      type: "skills",
      name,
      sourcePath: item.path,
      relativePath: join("skills", name),
      kind: "dir",
      hash: await hashPath(item.path),
      packageName,
      channel: "managed",
    };
  }

  if (stats.isFile() && basename(item.path).toLowerCase() === "skill.md") {
    const dir = dirname(item.path);
    const name = sanitizeSkillName(item.name ?? basename(dir));
    return {
      type: "skills",
      name,
      sourcePath: dir,
      relativePath: join("skills", name),
      kind: "dir",
      hash: await hashPath(dir),
      packageName,
      channel: "managed",
    };
  }

  if (stats.isFile() && extname(item.path).toLowerCase() === ".md") {
    const name = sanitizeSkillName(item.name ?? basename(item.path, ".md"));
    return {
      type: "skills",
      name,
      sourcePath: item.path,
      relativePath: join("skills", `${name}.md`),
      kind: "file",
      hash: await hashPath(item.path),
      packageName,
      channel: "managed",
    };
  }

  return undefined;
}

async function walk(dir: string, paths: SkillPath[]): Promise<void> {
  if (!(await pathExists(dir))) return;
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    paths.push({ path: dir });
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    await walk(join(dir, entry.name), paths);
  }
}

function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "skill";
}
