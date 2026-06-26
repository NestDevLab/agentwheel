import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Artifact } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";
import { LocalSourceDriver } from "./local.js";
import type { ResolvedSource, ScanResult, SourceDriver, SourceResolveOptions } from "./types.js";

const clawHubBaseUrl = "https://clawhub.ai/api/v1";
const sourcePrefix = "clawhub:";
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

interface ClawHubPackageResponse {
  package?: ClawHubPackage;
  owner?: Record<string, unknown>;
}

interface ClawHubPackage {
  name?: string;
  displayName?: string;
  runtimeId?: string;
  latestVersion?: string;
  family?: string;
  summary?: string;
  description?: string;
  artifact?: {
    format?: string;
    kind?: string;
    sha256?: string;
  };
  verification?: Record<string, unknown>;
}

interface GeneratedClawHubPlugin {
  name: string;
  installSpec: string;
  pluginId: string;
  displayName?: string;
  runtimeId?: string;
  latestVersion?: string;
  family?: string;
  summary?: string;
  artifact?: ClawHubPackage["artifact"];
  verification?: Record<string, unknown>;
}

export class ClawHubSourceDriver implements SourceDriver {
  readonly name = "clawhub";
  private readonly local = new LocalSourceDriver();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async resolve(source: string, options: SourceResolveOptions = {}): Promise<ResolvedSource> {
    const packageName = parseClawHubSource(source);
    return {
      driver: this.name,
      source,
      resolvedPath: cachePathFor(packageName, options.cacheRoot),
      packageName: `clawhub/${packageName}`,
      mode: options.mode ?? "tracking",
      requestedRef: options.ref ?? "latest",
      frozenLock: options.frozenLock,
      cacheLockTimeoutMs: options.cacheLockTimeoutMs,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    if (resolved.frozenLock) {
      if (!(await pathExists(resolved.resolvedPath))) {
        throw new Error(`Frozen lock requires cached ClawHub source at ${resolved.resolvedPath}`);
      }
      return {
        ...resolved,
        sourceHash: await hashPath(resolved.resolvedPath),
      };
    }

    const requestedName = parseClawHubSource(resolved.source);
    const response = await fetchClawHubPackage(this.fetchImpl, requestedName);
    if (!response.ok) {
      throw new Error(`ClawHub lookup failed for ${requestedName}: HTTP ${response.status}`);
    }

    const payload = await response.json() as ClawHubPackageResponse;
    const packageInfo = payload.package;
    if (!packageInfo?.name) {
      throw new Error(`ClawHub response missing package metadata for ${requestedName}`);
    }
    if (!isInstallableOpenClawPackage(packageInfo.family)) {
      throw new Error(`ClawHub package is not an OpenClaw plugin or hook package: ${packageInfo.name}`);
    }

    await writeGeneratedPackage(resolved.resolvedPath, packageInfo);

    return {
      ...resolved,
      packageName: `clawhub/${packageInfo.name}`,
      packageVersion: packageInfo.latestVersion ?? "latest",
      sourceHash: await hashPath(resolved.resolvedPath),
    };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    return this.local.list({ ...resolved, driver: "local" });
  }

  async scan(resolved: ResolvedSource): Promise<ScanResult> {
    if (!(await pathExists(join(resolved.resolvedPath, "plugins")))) {
      return { ok: false, findings: [{ level: "error", message: "ClawHub source has no generated plugin artifact" }] };
    }
    return { ok: true, findings: [] };
  }

  async translate(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }

  async export(resolved: ResolvedSource): Promise<ResolvedSource> {
    return resolved;
  }
}

async function fetchClawHubPackage(fetchImpl: typeof fetch, packageName: string): Promise<Response> {
  const url = `${clawHubBaseUrl}/packages/${encodeURIComponent(packageName)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!transientStatuses.has(response.status) || attempt === 2) return response;
    await delay((attempt + 1) * 250);
  }
  throw new Error(`ClawHub lookup failed for ${packageName}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseClawHubSource(source: string): string {
  if (!source.startsWith(sourcePrefix)) {
    throw new Error(`Invalid ClawHub source: ${source}`);
  }
  const packageName = source.slice(sourcePrefix.length).trim();
  if (!packageName) throw new Error(`Invalid ClawHub source: ${source}`);
  return packageName;
}

function isInstallableOpenClawPackage(family: string | undefined): boolean {
  if (!family) return true;
  return family.endsWith("-plugin") || family === "hook-pack";
}

async function writeGeneratedPackage(root: string, packageInfo: ClawHubPackage): Promise<void> {
  const name = packageInfo.name?.trim();
  if (!name) throw new Error("ClawHub package metadata must include a name");

  const pluginId = installNameFor(packageInfo.runtimeId ?? name);
  const plugin: GeneratedClawHubPlugin = {
    name,
    installSpec: `${sourcePrefix}${name}`,
    pluginId,
    displayName: packageInfo.displayName,
    runtimeId: packageInfo.runtimeId,
    latestVersion: packageInfo.latestVersion,
    family: packageInfo.family,
    summary: packageInfo.summary ?? packageInfo.description,
    artifact: packageInfo.artifact,
    verification: packageInfo.verification,
  };

  const pluginPath = join(root, "plugins", pluginId, "clawhub.json");
  await rm(root, { recursive: true, force: true });
  await mkdir(dirname(pluginPath), { recursive: true });
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: `clawhub/${name}`,
    version: packageInfo.latestVersion ?? "latest",
    runtimes: ["openclaw"],
    provides: [
      {
        type: "plugins",
        path: "plugins",
        format: "openclaw-clawhub-plugin",
        runtimes: ["openclaw"],
        required: true,
      },
    ],
  }, null, 2)}\n`, "utf8");
  await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
}

function installNameFor(value: string): string {
  return basename(value)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || "clawhub-plugin";
}

function cachePathFor(packageName: string, cacheRoot?: string): string {
  const root = cacheRoot ? resolve(cacheRoot) : join(process.env.HOME ?? ".", ".agentwheel", "cache");
  const slug = `clawhub-${packageName}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return join(root, slug || "clawhub-package");
}
