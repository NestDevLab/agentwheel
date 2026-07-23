import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import type { WorkspacePackage } from "../model/workspace.js";
import { readPackageManifest } from "../model/package.js";
import { compareSemverStrings, parseSemver, satisfiesVersionRange } from "../resolve/semver.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_VERSION_REFRESH_TTL_SECONDS = 86_400;

const cachedVersionSchema = z.object({
  version: z.string().min(1),
  ref: z.string().min(1),
});

const versionCacheEntrySchema = z.object({
  checkedAt: z.string().datetime(),
  versions: z.array(cachedVersionSchema),
});

const versionCacheSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.record(z.string(), versionCacheEntrySchema),
});

type CachedVersion = z.infer<typeof cachedVersionSchema>;
type VersionCache = z.infer<typeof versionCacheSchema>;

export interface VersionAvailability {
  source: string;
  policy: string;
  checkedAt: string | null;
  stale: boolean;
  refreshed: boolean;
  latestAllowed: string | null;
  latestAllowedRef: string | null;
  latestOverall: string | null;
  latestOverallRef: string | null;
  versions: CachedVersion[];
  error?: string;
}

export interface VersionDiscoveryOptions {
  ttlSeconds?: number;
  forceRefresh?: boolean;
  offline?: boolean;
  now?: () => Date;
}

export async function discoverPackageVersions(
  pkg: WorkspacePackage,
  workspaceRoot: string,
  options: VersionDiscoveryOptions = {},
): Promise<VersionAvailability> {
  const now = (options.now ?? (() => new Date()))();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_VERSION_REFRESH_TTL_SECONDS;
  const cachePath = versionCachePath(workspaceRoot);
  const cache = await readVersionCache(cachePath);
  const cached = cache.sources[pkg.source];
  const cachedAgeMs = cached ? now.getTime() - new Date(cached.checkedAt).getTime() : Number.POSITIVE_INFINITY;
  const cachedFresh = cachedAgeMs <= ttlSeconds * 1000;

  if (options.offline || (cached && cachedFresh && !options.forceRefresh)) {
    return availabilityFromVersions(pkg, cached?.versions ?? [], {
      checkedAt: cached?.checkedAt ?? null,
      stale: !cachedFresh,
      refreshed: false,
      error: !cached && options.offline ? "No cached version index is available offline." : undefined,
    });
  }

  try {
    const versions = await discoverVersionsFromSource(pkg, workspaceRoot);
    const checkedAt = now.toISOString();
    await writeJsonAtomic(cachePath, {
      schemaVersion: 1,
      sources: {
        ...cache.sources,
        [pkg.source]: { checkedAt, versions },
      },
    });
    return availabilityFromVersions(pkg, versions, {
      checkedAt,
      stale: false,
      refreshed: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return availabilityFromVersions(pkg, cached?.versions ?? [], {
      checkedAt: cached?.checkedAt ?? null,
      stale: true,
      refreshed: false,
      error: message,
    });
  }
}

export async function effectiveTrackingRef(
  pkg: WorkspacePackage,
  workspaceRoot: string,
  options: VersionDiscoveryOptions = {},
): Promise<{ ref?: string; availability?: VersionAvailability }> {
  if (pkg.mode !== "tracking" || !pkg.version) return { ref: pkg.requestedRef };
  const availability = await discoverPackageVersions(pkg, workspaceRoot, options);
  const driverName = pkg.driver === "local" ? inferSourceDriverName(pkg.source) : pkg.driver;
  return {
    ref: driverName === "local" ? pkg.requestedRef : availability.latestAllowedRef ?? pkg.requestedRef,
    availability,
  };
}

function availabilityFromVersions(
  pkg: WorkspacePackage,
  versions: CachedVersion[],
  state: Pick<VersionAvailability, "checkedAt" | "stale" | "refreshed" | "error">,
): VersionAvailability {
  const sorted = [...versions].sort((a, b) => compareSemverStrings(b.version, a.version));
  const policy = pkg.version ?? "*";
  const latestOverall = sorted[0] ?? null;
  const latestAllowed = sorted.find((candidate) => satisfiesVersionRange(candidate.version, policy)) ?? null;
  return {
    source: pkg.source,
    policy,
    checkedAt: state.checkedAt,
    stale: state.stale,
    refreshed: state.refreshed,
    latestAllowed: latestAllowed?.version ?? null,
    latestAllowedRef: latestAllowed?.ref ?? null,
    latestOverall: latestOverall?.version ?? null,
    latestOverallRef: latestOverall?.ref ?? null,
    versions: sorted,
    ...(state.error ? { error: state.error } : {}),
  };
}

async function discoverVersionsFromSource(pkg: WorkspacePackage, workspaceRoot: string): Promise<CachedVersion[]> {
  const driverName = pkg.driver === "local" ? inferSourceDriverName(pkg.source) : pkg.driver;
  if (driverName === "git") {
    const tagged = await discoverGitTags(pkg.source, pkg.version);
    if (tagged.length > 0) return tagged;
  }

  if (driverName === "local") {
    const root = resolve(workspaceRoot, pkg.source);
    const manifest = await readPackageManifest(root);
    const current = manifest ? [{ version: manifest.version, ref: pkg.requestedRef ?? root }] : [];
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "remote", "get-url", "origin"]);
      return uniqueVersions([
        ...await discoverGitTagsFromUrl(stdout.trim(), pkg.version, root),
        ...current,
      ]);
    } catch {
      return current;
    }
  }

  const driver = getSourceDriver(driverName);
  const resolved = await driver.resolve(pkg.source, {
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: "tracking",
    ref: pkg.requestedRef,
  });
  const fetched = await driver.fetch(resolved);
  const manifest = await readPackageManifest(fetched.resolvedPath);
  const version = manifest?.version ?? fetched.packageVersion;
  return version ? [{ version, ref: fetched.requestedRef ?? pkg.requestedRef ?? "HEAD" }] : [];
}

async function discoverGitTags(source: string, policy: string | undefined): Promise<CachedVersion[]> {
  const url = gitUrlFromSource(source);
  const localRoot = url.startsWith("/") ? url : undefined;
  return discoverGitTagsFromUrl(url, policy, localRoot);
}

async function discoverGitTagsFromUrl(
  url: string,
  policy: string | undefined,
  localRoot?: string,
): Promise<CachedVersion[]> {
  const { stdout } = await execFileAsync("git", ["ls-remote", "--tags", "--refs", url], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const byVersion = new Map<string, CachedVersion>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[0-9a-f]+\s+refs\/tags\/(.+)$/.exec(line.trim());
    if (!match) continue;
    const tag = match[1]!;
    if (!parseSemver(tag)) continue;
    const version = tag.replace(/^v/, "");
    const incumbent = byVersion.get(version);
    if (!incumbent || tag.startsWith("v")) byVersion.set(version, { version, ref: tag });
  }
  const candidates = [...byVersion.values()].sort((a, b) => compareSemverStrings(b.version, a.version));
  const valid: CachedVersion[] = [];
  let foundOverall = false;
  let foundAllowed = false;
  for (const candidate of candidates) {
    const manifestVersion = await manifestVersionAtRef(url, candidate.ref, localRoot);
    if (manifestVersion !== candidate.version) continue;
    valid.push(candidate);
    foundOverall = true;
    if (satisfiesVersionRange(candidate.version, policy)) foundAllowed = true;
    if (foundOverall && foundAllowed) break;
  }
  return valid;
}

function uniqueVersions(versions: CachedVersion[]): CachedVersion[] {
  const byVersion = new Map<string, CachedVersion>();
  for (const version of versions) {
    if (!byVersion.has(version.version)) byVersion.set(version.version, version);
  }
  return [...byVersion.values()].sort((a, b) => compareSemverStrings(b.version, a.version));
}

async function manifestVersionAtRef(url: string, ref: string, localRoot?: string): Promise<string | null> {
  if (localRoot) {
    for (const name of ["openpack.json", "openpack.jsonc"]) {
      try {
        const { stdout } = await execFileAsync("git", ["-C", localRoot, "show", `${ref}:${name}`], {
          maxBuffer: 1024 * 1024,
        });
        const parsed = parseJsonc(stdout) as { version?: unknown } | undefined;
        if (typeof parsed?.version === "string") return parsed.version.replace(/^v/, "");
      } catch {
        // Try the next canonical manifest name.
      }
    }
    return null;
  }

  const repository = githubRepositoryFromUrl(url);
  if (!repository) return null;
  for (const name of ["openpack.json", "openpack.jsonc"]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(ref)}/${name}`,
      { headers: { "user-agent": "agentwheel-version-discovery" } },
    );
    if (!response.ok) continue;
    const parsed = parseJsonc(await response.text()) as { version?: unknown } | undefined;
    if (typeof parsed?.version === "string") return parsed.version.replace(/^v/, "");
  }
  return null;
}

function githubRepositoryFromUrl(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? null;
}

function gitUrlFromSource(source: string): string {
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length).split("#", 1)[0]!;
    if (!repo.includes("/")) throw new Error(`Invalid GitHub source: ${source}`);
    return `https://github.com/${repo}.git`;
  }
  if (source.startsWith("git:")) {
    const rest = source.slice("git:".length);
    const hashIndex = rest.lastIndexOf("#");
    return hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  }
  throw new Error(`Version discovery does not support Git source: ${source}`);
}

function versionCachePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".agentwheel", "cache", "version-index.json");
}

async function readVersionCache(path: string): Promise<VersionCache> {
  if (!(await pathExists(path))) return { schemaVersion: 1, sources: {} };
  try {
    return versionCacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { schemaVersion: 1, sources: {} };
  }
}
