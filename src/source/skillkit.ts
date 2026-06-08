import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as defaultSkillKit from "@skillkit/core";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";
import { artifactsFromSkillPaths, type SkillPath } from "./skill-artifacts.js";
import type { ResolvedSource, ScanFinding, ScanResult, SourceDriver, SourceResolveOptions } from "./types.js";

interface SkillKitSkill {
  name?: string;
  path?: string;
}

interface SkillKitScanFinding {
  severity?: string;
  title?: string;
  description?: string;
  filePath?: string;
}

interface SkillKitScanResult {
  verdict?: string;
  findings?: SkillKitScanFinding[];
}

interface SkillKitCloneResult {
  success: boolean;
  path?: string;
  tempRoot?: string;
  error?: string;
}

interface SkillKitProvider {
  clone(source: string, targetDir: string, options?: Record<string, unknown>): Promise<SkillKitCloneResult>;
}

interface SkillKitCore {
  discoverSkills?: (rootDir: string) => SkillKitSkill[];
  translateSkill?: (content: string, targetAgent: string, options?: Record<string, unknown>) => unknown;
  SkillScanner?: new () => { scan(skillPath: string): Promise<SkillKitScanResult> };
  detectProvider?: (source: string) => SkillKitProvider | undefined;
}

export class SkillKitSourceDriver implements SourceDriver {
  readonly name = "skillkit";

  constructor(private readonly core: SkillKitCore = defaultSkillKit as SkillKitCore) {}

  async resolve(source: string, options: SourceResolveOptions = {}): Promise<ResolvedSource> {
    const spec = parseSkillKitSource(source);
    if (await pathExists(spec)) {
      const resolvedPath = resolve(spec);
      return {
        driver: this.name,
        source,
        resolvedPath,
        packageName: `skillkit/${basename(resolvedPath)}`,
        mode: options.mode ?? "pinned",
        sourceHash: await hashPath(resolvedPath),
      };
    }

    return {
      driver: this.name,
      source,
      resolvedPath: cachePathFor(spec, options.cacheRoot),
      packageName: `skillkit/${packageSlug(spec)}`,
      mode: options.mode ?? "tracking",
      requestedRef: options.ref,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    const spec = parseSkillKitSource(resolved.source);
    if (await pathExists(spec)) {
      return resolved;
    }

    const providerSpec = normalizeProviderSource(spec);
    const provider = this.core.detectProvider?.(providerSpec);
    if (!provider?.clone) {
      throw new Error("SkillKit provider API unavailable or cannot resolve source. Expected @skillkit/core detectProvider().clone().");
    }

    await mkdir(dirname(resolved.resolvedPath), { recursive: true });
    const result = await provider.clone(providerSpec, resolved.resolvedPath, {});
    if (!result.success || !result.path) {
      throw new Error(`SkillKit provider failed to fetch ${spec}: ${result.error ?? "unknown error"}`);
    }
    if (resolve(result.path) !== resolve(resolved.resolvedPath)) {
      await rm(resolved.resolvedPath, { recursive: true, force: true });
      await cp(result.path, resolved.resolvedPath, { recursive: true, dereference: true });
    }
    if (result.tempRoot) {
      await rm(result.tempRoot, { recursive: true, force: true });
    }
    return {
      ...resolved,
      sourceHash: await hashPath(resolved.resolvedPath),
    };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    const skills = this.discover(resolved.resolvedPath);
    return artifactsFromSkillPaths(skills, resolved.packageName);
  }

  async scan(resolved: ResolvedSource): Promise<ScanResult> {
    if (!this.core.SkillScanner) {
      return { ok: false, findings: [{ level: "error", message: "SkillKit SkillScanner API unavailable" }] };
    }
    const scanner = new this.core.SkillScanner();
    const findings: ScanFinding[] = [];
    for (const skill of this.discover(resolved.resolvedPath)) {
      const scan = await scanner.scan(skill.path);
      for (const finding of scan.findings ?? []) {
        findings.push({
          level: mapSeverity(finding.severity),
          message: finding.title ?? finding.description ?? "SkillKit scanner finding",
          path: finding.filePath,
        });
      }
    }
    return { ok: !findings.some((finding) => finding.level === "error"), findings };
  }

  async translate(resolved: ResolvedSource): Promise<ResolvedSource> {
    if (!this.core.translateSkill) {
      throw new Error("SkillKit translateSkill API unavailable");
    }
    for (const skill of this.discover(resolved.resolvedPath)) {
      const skillMd = join(skill.path, "SKILL.md");
      if (await pathExists(skillMd)) {
        this.core.translateSkill(await readFile(skillMd, "utf8"), "openclaw", { sourceFilename: "SKILL.md" });
      }
    }
    return resolved;
  }

  async export(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  private discover(root: string): SkillPath[] {
    if (!this.core.discoverSkills) {
      throw new Error("SkillKit discoverSkills API unavailable");
    }
    return this.core.discoverSkills(root)
      .filter((skill): skill is Required<Pick<SkillKitSkill, "path">> & SkillKitSkill => typeof skill.path === "string")
      .map((skill) => ({ name: skill.name, path: skill.path }));
  }
}

function parseSkillKitSource(source: string): string {
  if (!source.startsWith("skillkit:")) {
    throw new Error(`Invalid SkillKit source: ${source}`);
  }
  const spec = source.slice("skillkit:".length);
  if (!spec) throw new Error(`Invalid SkillKit source: ${source}`);
  return spec;
}

function normalizeProviderSource(spec: string): string {
  if (spec.startsWith("github:")) return spec.slice("github:".length);
  if (spec.startsWith("git:https://github.com/")) return spec.slice("git:".length);
  return spec;
}

function cachePathFor(spec: string, cacheRoot?: string): string {
  const root = cacheRoot ? resolve(cacheRoot) : join(homedir(), ".agentwheel", "cache");
  return join(root, "skillkit", packageSlug(spec));
}

function packageSlug(spec: string): string {
  return spec
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "source";
}

function mapSeverity(severity: string | undefined): ScanFinding["level"] {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "low") return "warning";
  return "info";
}
