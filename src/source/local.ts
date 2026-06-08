import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";
import type { ResolvedSource, ScanFinding, ScanResult, SourceDriver } from "./types.js";

export class LocalSourceDriver implements SourceDriver {
  readonly name = "local";

  async resolve(source: string): Promise<ResolvedSource> {
    const resolvedPath = resolve(source);
    if (!(await pathExists(resolvedPath))) {
      throw new Error(`Local source not found: ${resolvedPath}`);
    }
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Local source must be a directory: ${resolvedPath}`);
    }
    return { driver: this.name, source, resolvedPath };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    const root = resolved.resolvedPath;
    const instructions = await firstExisting([join(root, "instructions.md"), join(root, "AGENTS.md")]);
    if (instructions) {
      artifacts.push({
        type: "instructions",
        name: basename(instructions),
        sourcePath: instructions,
        relativePath: basename(instructions),
        kind: "file",
        hash: await hashPath(instructions),
      });
    }

    const rulesDir = join(root, "rules");
    if (await pathExists(rulesDir)) {
      for (const entry of await sortedDirEntries(rulesDir)) {
        const full = join(rulesDir, entry.name);
        if (entry.isFile()) {
          artifacts.push({
            type: "rules",
            name: entry.name,
            sourcePath: full,
            relativePath: join("rules", entry.name),
            kind: "file",
            hash: await hashPath(full),
          });
        }
      }
    }

    const skillsDir = join(root, "skills");
    if (await pathExists(skillsDir)) {
      for (const entry of await sortedDirEntries(skillsDir)) {
        const full = join(skillsDir, entry.name);
        if (entry.isDirectory()) {
          artifacts.push({
            type: "skills",
            name: entry.name,
            sourcePath: full,
            relativePath: join("skills", entry.name),
            kind: "dir",
            hash: await hashPath(full),
          });
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          artifacts.push({
            type: "skills",
            name: entry.name.replace(/\.md$/, ""),
            sourcePath: full,
            relativePath: join("skills", entry.name),
            kind: "file",
            hash: await hashPath(full),
          });
        }
      }
    }

    return artifacts;
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  async scan(resolved: ResolvedSource): Promise<ScanResult> {
    const artifacts = await this.list(resolved);
    const findings: ScanFinding[] = [];
    if (!artifacts.some((artifact) => artifact.type === "instructions")) {
      findings.push({ level: "warning" as const, message: "No instructions.md or AGENTS.md found", path: resolved.resolvedPath });
    }
    for (const artifact of artifacts.filter((item) => item.type === "skills" && item.kind === "dir")) {
      if (!(await pathExists(join(artifact.sourcePath, "SKILL.md")))) {
        findings.push({ level: "warning" as const, message: `Skill directory has no SKILL.md: ${artifact.name}`, path: artifact.sourcePath });
      }
    }
    return { ok: !findings.some((finding) => finding.level === "error"), findings };
  }

  async translate(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  async export(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

async function sortedDirEntries(path: string) {
  return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}
