import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Artifact, ArtifactType } from "../model/artifact.js";
import { readPackageManifest } from "../model/package.js";
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
    const manifest = await readPackageManifest(resolvedPath);
    return {
      driver: this.name,
      source,
      resolvedPath,
      packageName: manifest?.name,
      packageVersion: manifest?.version,
      mode: "pinned",
      sourceHash: await hashPath(resolvedPath),
    };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    const manifest = await readPackageManifest(resolved.resolvedPath);
    if (manifest) {
      return listFromManifest(resolved.resolvedPath, manifest.name);
    }

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
        packageName: resolved.packageName,
        channel: "managed",
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
            packageName: resolved.packageName,
            channel: "managed",
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
            packageName: resolved.packageName,
            channel: "managed",
          });
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          artifacts.push({
            type: "skills",
            name: entry.name.replace(/\.md$/, ""),
            sourcePath: full,
            relativePath: join("skills", entry.name),
            kind: "file",
            hash: await hashPath(full),
            packageName: resolved.packageName,
            channel: "managed",
          });
        }
      }
    }

    for (const type of ["commands", "mcp", "hooks", "plugins"] as ArtifactType[]) {
      const dir = join(root, type);
      if (!(await pathExists(dir))) continue;
      artifacts.push(...await listGenericArtifacts(type, dir, type, resolved.packageName));
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

async function listFromManifest(root: string, packageName: string): Promise<Artifact[]> {
  const manifest = await readPackageManifest(root);
  if (!manifest) return [];

  const artifacts: Artifact[] = [];
  for (const provide of manifest.provides) {
    const full = join(root, provide.path);
    if (!(await pathExists(full))) continue;
    const stats = await stat(full);
    if (provide.type === "instructions") {
      if (stats.isFile()) {
        artifacts.push(await artifactForFile(provide.type, basename(full), full, provide.path, packageName));
      }
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of await sortedDirEntries(full)) {
        const child = join(full, entry.name);
        if (provide.type === "skills" && entry.isDirectory()) {
          artifacts.push(await artifactForDir(provide.type, entry.name, child, join(provide.path, entry.name), packageName));
        } else if (provide.type === "plugins" && entry.isDirectory()) {
          artifacts.push(await artifactForDir(provide.type, entry.name, child, join(provide.path, entry.name), packageName));
        } else if (entry.isFile()) {
          const name = provide.type === "rules" && entry.name.endsWith(".md") ? entry.name : entry.name;
          artifacts.push(await artifactForFile(provide.type, name, child, join(provide.path, entry.name), packageName));
        }
      }
    } else if (stats.isFile()) {
      artifacts.push(await artifactForFile(provide.type, basename(full), full, provide.path, packageName));
    }
  }
  return artifacts;
}

async function listGenericArtifacts(type: ArtifactType, dir: string, relativeRoot: string, packageName?: string): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (const entry of await sortedDirEntries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(await artifactForDir(type, entry.name, full, join(relativeRoot, entry.name), packageName));
    } else if (entry.isFile()) {
      artifacts.push(await artifactForFile(type, entry.name, full, join(relativeRoot, entry.name), packageName));
    }
  }
  return artifacts;
}

async function artifactForFile(type: ArtifactType, name: string, sourcePath: string, relativePath: string, packageName?: string): Promise<Artifact> {
  return {
    type,
    name,
    sourcePath,
    relativePath,
    kind: "file",
    hash: await hashPath(sourcePath),
    packageName,
    channel: "managed",
  };
}

async function artifactForDir(type: ArtifactType, name: string, sourcePath: string, relativePath: string, packageName?: string): Promise<Artifact> {
  return {
    type,
    name,
    sourcePath,
    relativePath,
    kind: "dir",
    hash: await hashPath(sourcePath),
    packageName,
    channel: "managed",
  };
}
