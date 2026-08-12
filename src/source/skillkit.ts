import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import * as defaultSkillKit from "@skillkit/core";
import type { Artifact } from "../model/artifact.js";
import { hashPath, isAlreadyExists, pathExists, withFilesystemLock } from "../utils/fs.js";
import { artifactsFromSkillPaths, type SkillPath } from "./skill-artifacts.js";
import type { ResolvedSource, ScanFinding, ScanResult, SourceDriver, SourceResolveOptions } from "./types.js";

const execFileAsync = promisify(execFile);

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
  resolvedCommit?: string;
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
  private readonly inflightFetches = new Map<string, Promise<ResolvedSource>>();

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
      resolvedPath: cachePathFor(spec, options.cacheRoot, immutableCommit(options.ref)),
      packageName: `skillkit/${packageSlug(spec)}`,
      mode: options.mode ?? "tracking",
      requestedRef: options.ref,
      frozenLock: options.frozenLock,
      cacheLockTimeoutMs: options.cacheLockTimeoutMs,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    const spec = parseSkillKitSource(resolved.source);
    if (await pathExists(spec)) {
      return resolved;
    }
    const requestedCommit = immutableCommit(resolved.requestedRef);
    if (resolved.frozenLock) {
      if (!requestedCommit) {
        throw new Error("Frozen lock requires cached SkillKit source identified by an immutable commit ref.");
      }
      if (!(await pathExists(resolved.resolvedPath))) {
        throw new Error(`Frozen lock requires cached SkillKit source at ${resolved.resolvedPath}`);
      }
      return {
        ...resolved,
        resolvedCommit: requestedCommit,
        sourceHash: await hashPath(resolved.resolvedPath),
      };
    }

    if (requestedCommit && await pathExists(resolved.resolvedPath)) {
      return {
        ...resolved,
        resolvedCommit: requestedCommit,
        sourceHash: await hashPath(resolved.resolvedPath),
      };
    }

    const specCachePath = cachePathFor(spec, dirname(dirname(resolved.resolvedPath)));
    const refIdentity = resolved.requestedRef ?? "default";
    const lockPath = `${specCachePath}.ref-${createHash("sha256").update(refIdentity).digest("hex")}.lock`;
    const inflightKey = `${lockPath}\0${requestedCommit ?? "movable"}`;
    const inflight = this.inflightFetches.get(inflightKey);
    if (inflight) return inflight;

    const fetchPromise = this.materializeRemote(resolved, spec, specCachePath, lockPath, requestedCommit);
    this.inflightFetches.set(inflightKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      if (this.inflightFetches.get(inflightKey) === fetchPromise) this.inflightFetches.delete(inflightKey);
    }
  }

  private async materializeRemote(
    resolved: ResolvedSource,
    spec: string,
    specCachePath: string,
    lockPath: string,
    requestedCommit: string | undefined,
  ): Promise<ResolvedSource> {
    const providerSpec = normalizeProviderSource(spec);
    const provider = this.core.detectProvider?.(providerSpec);
    if (!provider?.clone) {
      throw new Error("SkillKit provider API unavailable or cannot resolve source. Expected @skillkit/core detectProvider().clone().");
    }

    const materialized = await withFilesystemLock(lockPath, resolved.cacheLockTimeoutMs ?? 30_000, async () => {
      const immutablePath = requestedCommit ? cachePathFor(spec, dirname(dirname(specCachePath)), requestedCommit) : undefined;
      if (immutablePath && await pathExists(immutablePath)) {
        return { path: immutablePath, commit: requestedCommit };
      }

      await mkdir(dirname(specCachePath), { recursive: true });
      const candidatePath = `${specCachePath}.agentwheel-tmp-${process.pid}-${randomUUID()}`;
      const publishPath = `${candidatePath}.publish`;
      let result: SkillKitCloneResult | undefined;
      try {
        const requestedRef = resolved.requestedRef;
        result = await provider.clone(providerSpec, candidatePath, requestedCommit || !requestedRef ? {} : { branch: requestedRef });
        if (!result.success || !result.path) {
          throw new Error(`SkillKit provider failed to fetch ${spec}: ${result.error ?? "unknown error"}`);
        }
        if (requestedCommit && requestedRef) {
          if (!result.tempRoot) {
            throw new Error(`SkillKit provider cannot materialize commit ${requestedRef}: clone result has no git checkout root`);
          }
          await checkoutCommit(result.tempRoot, requestedRef);
        }
        const resolvedIdentity = await resolveCloneIdentity(result);
        if (requestedCommit && !resolvedIdentity.commit?.startsWith(requestedCommit)) {
          throw new Error(
            `SkillKit provider resolved ${resolvedIdentity.commit ?? "non-Git content"} instead of requested commit ${requestedCommit}`,
          );
        }
        const cachePath = cachePathFor(spec, dirname(dirname(specCachePath)), resolvedIdentity.cacheKey);
        if (await pathExists(cachePath)) return { path: cachePath, commit: resolvedIdentity.commit };

        const publishCandidate = resolve(result.path) === resolve(candidatePath) ? candidatePath : publishPath;
        if (publishCandidate === publishPath) await cp(result.path, publishPath, { recursive: true, dereference: true });
        try {
          await rename(publishCandidate, cachePath);
        } catch (error) {
          if (!isAlreadyExists(error) && !isDirectoryNotEmpty(error)) throw error;
          await rm(publishCandidate, { recursive: true, force: true });
        }
        return { path: cachePath, commit: resolvedIdentity.commit };
      } finally {
        await rm(candidatePath, { recursive: true, force: true });
        await rm(publishPath, { recursive: true, force: true });
        if (result?.tempRoot) {
          await rm(result.tempRoot, { recursive: true, force: true });
        }
      }
    });
    return {
      ...resolved,
      resolvedPath: materialized.path,
      resolvedCommit: materialized.commit,
      sourceHash: await hashPath(materialized.path),
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

function cachePathFor(spec: string, cacheRoot?: string, immutableIdentity?: string): string {
  const root = cacheRoot ? resolve(cacheRoot) : join(homedir(), ".agentwheel", "cache");
  const sourceIdentity = createHash("sha256").update(spec).digest("hex");
  const snapshotIdentity = immutableIdentity ? `-${immutableIdentity.toLowerCase()}` : "";
  return join(root, "skillkit", `${packageSlug(spec)}-${sourceIdentity}${snapshotIdentity}`);
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

function isDirectoryNotEmpty(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOTEMPTY";
}

function immutableCommit(ref: string | undefined): string | undefined {
  return ref && /^[0-9a-f]{7,40}$/i.test(ref) ? ref.toLowerCase() : undefined;
}

async function resolveCloneIdentity(result: SkillKitCloneResult): Promise<{ cacheKey: string; commit?: string }> {
  if (result.resolvedCommit && /^[0-9a-f]{40}$/i.test(result.resolvedCommit)) {
    const commit = result.resolvedCommit.toLowerCase();
    return { cacheKey: commit, commit };
  }
  const checkoutRoot = result.tempRoot ?? result.path;
  if (!checkoutRoot) throw new Error("SkillKit provider clone has no checkout path");
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkoutRoot, "rev-parse", "HEAD"]);
    const commit = stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid commit '${commit}'`);
    return { cacheKey: commit, commit };
  } catch {
    // Well-known HTTP providers are not Git-backed; content addressing keeps
    // their refreshed snapshots immutable without inventing a Git commit.
    return { cacheKey: `content-${await hashPath(result.path!)}` };
  }
}

async function checkoutCommit(root: string, commit: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", root, "checkout", "--detach", commit]);
  } catch {
    await execFileAsync("git", ["-C", root, "fetch", "origin", commit]);
    await execFileAsync("git", ["-C", root, "checkout", "--detach", commit]);
  }
}
