import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";
import { discoverSkillPaths, artifactsFromSkillPaths } from "./skill-artifacts.js";
import { GitSourceDriver } from "./git.js";
import type { ResolvedSource, SourceDriver, SourceResolveOptions } from "./types.js";

export class VercelSkillsSourceDriver implements SourceDriver {
  readonly name = "vercel-skills";
  private readonly git = new GitSourceDriver();

  async resolve(source: string, options: SourceResolveOptions = {}): Promise<ResolvedSource> {
    const parsed = parseVercelSource(source);
    if (parsed.kind === "local") {
      const resolvedPath = resolve(parsed.path);
      if (!(await pathExists(resolvedPath)) || !(await stat(resolvedPath)).isDirectory()) {
        throw new Error(`Vercel skills local source not found: ${resolvedPath}`);
      }
      return {
        driver: this.name,
        source,
        resolvedPath,
        packageName: `vercel/${basename(resolvedPath)}`,
        mode: options.mode ?? "pinned",
        sourceHash: await hashPath(resolvedPath),
      };
    }

    const gitResolved = await this.git.resolve(parsed.gitSource, options);
    return {
      ...gitResolved,
      driver: this.name,
      source,
      packageName: parsed.packageName,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    const parsed = parseVercelSource(resolved.source);
    if (parsed.kind === "local") return resolved;

    const fetched = await this.git.fetch({
      ...resolved,
      driver: "git",
      source: parsed.gitSource,
    });
    const resolvedPath = parsed.subpath ? join(fetched.resolvedPath, parsed.subpath) : fetched.resolvedPath;
    if (!(await pathExists(resolvedPath))) {
      throw new Error(`Vercel skills subpath not found: ${parsed.subpath}`);
    }
    return {
      ...resolved,
      resolvedPath,
      resolvedCommit: fetched.resolvedCommit,
      sourceHash: await hashPath(resolvedPath),
    };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    return artifactsFromSkillPaths(await discoverSkillPaths(resolved.resolvedPath), resolved.packageName);
  }

  async scan(resolved: ResolvedSource) {
    const artifacts = await this.list(resolved);
    return {
      ok: artifacts.length > 0,
      findings: artifacts.length > 0 ? [] : [{ level: "warning" as const, message: "No SKILL.md files found", path: resolved.resolvedPath }],
    };
  }

  async translate(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  async export(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }
}

type ParsedVercelSource =
  | { kind: "local"; path: string }
  | { kind: "git"; gitSource: string; packageName: string; subpath?: string };

function parseVercelSource(source: string): ParsedVercelSource {
  if (!source.startsWith("vercel:")) {
    throw new Error(`Invalid Vercel skills source: ${source}`);
  }
  const spec = source.slice("vercel:".length);
  if (!spec) throw new Error(`Invalid Vercel skills source: ${source}`);
  if (spec.startsWith(".") || spec.startsWith("/")) return { kind: "local", path: spec };
  if (spec.startsWith("git:")) {
    return { kind: "git", gitSource: spec, packageName: `vercel/${slug(spec)}` };
  }
  if (spec.startsWith("github:")) {
    const name = spec.slice("github:".length).split("#", 1)[0];
    return { kind: "git", gitSource: spec, packageName: `vercel/${name}` };
  }
  if (spec.startsWith("skills.sh/") || spec.startsWith("https://skills.sh/")) {
    const parsed = parseSkillsSh(spec);
    return {
      kind: "git",
      gitSource: `github:${parsed.owner}/${parsed.repo}${parsed.ref ? `#${parsed.ref}` : ""}`,
      packageName: `vercel/${parsed.owner}/${parsed.repo}`,
      subpath: parsed.skillName,
    };
  }
  if (/^[^/]+\/[^/]+/.test(spec)) {
    const [repo, ref] = spec.split("#", 2);
    const [owner, name] = repo.split("/", 2);
    return {
      kind: "git",
      gitSource: `github:${owner}/${name}${ref ? `#${ref}` : ""}`,
      packageName: `vercel/${owner}/${name}`,
    };
  }
  throw new Error(`Invalid Vercel skills source: ${source}`);
}

function parseSkillsSh(spec: string): { owner: string; repo: string; skillName?: string; ref?: string } {
  const clean = spec.replace(/^https?:\/\//, "").replace(/^skills\.sh\//, "");
  const [path, ref] = clean.split("#", 2);
  const [owner, repo, ...rest] = path.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`Invalid skills.sh source: ${spec}`);
  return { owner, repo, skillName: rest.length > 0 ? rest.join("/") : undefined, ref };
}

function slug(value: string): string {
  return value
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "source";
}
