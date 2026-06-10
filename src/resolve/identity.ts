import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RegistryEntry } from "../model/registry.js";
import { RegistryClient } from "../registry/client.js";
import { inferSourceDriverName, type SourceDriverName } from "../source/identify.js";

export interface NormalizedDependencySource {
  source: string;
  normalizedSource: string;
  driver: SourceDriverName;
  requestedRef?: string;
  registryEntry?: RegistryEntry;
}

export interface NormalizeDependencySourceOptions {
  declaringPackageRoot: string;
  workspaceRoot: string;
  ref?: string;
  registryClient?: Pick<RegistryClient, "resolve">;
}

export async function normalizeDependencySource(
  source: string,
  options: NormalizeDependencySourceOptions,
): Promise<NormalizedDependencySource> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Dependency source must not be empty.");

  if (trimmed.startsWith("registry:")) {
    const name = trimmed.slice("registry:".length).trim();
    if (!name) throw new Error(`Invalid registry dependency source: ${source}`);
    return normalizeRegistrySource(name, options);
  }

  if (isBareRegistryName(trimmed)) {
    return normalizeRegistrySource(trimmed, options);
  }

  if (isLocalSource(trimmed)) {
    const path = localSourcePath(trimmed);
    const resolvedPath = resolveLocalPath(path, options.declaringPackageRoot);
    return {
      source: resolvedPath,
      normalizedSource: `local:${resolvedPath}`,
      driver: "local",
    };
  }

  if (trimmed.startsWith("github:") || trimmed.startsWith("git:")) {
    const parsed = parseGitSource(trimmed);
    const requestedRef = options.ref ?? parsed.ref ?? "HEAD";
    const url = normalizeGitRemoteUrl(parsed.url, options.declaringPackageRoot);
    const normalizedSource = `git:${url}#${requestedRef}`;
    return {
      source: normalizedSource,
      normalizedSource,
      driver: "git",
      requestedRef,
    };
  }

  if (trimmed.startsWith("skillkit:")) {
    const spec = normalizeProviderSpec(trimmed.slice("skillkit:".length), options.declaringPackageRoot);
    const normalizedSource = `skillkit:${spec}`;
    return {
      source: normalizedSource,
      normalizedSource,
      driver: "skillkit",
    };
  }

  if (trimmed.startsWith("vercel:")) {
    const spec = normalizeProviderSpec(trimmed.slice("vercel:".length), options.declaringPackageRoot);
    const normalizedSource = `vercel:${spec}`;
    return {
      source: normalizedSource,
      normalizedSource,
      driver: "vercel-skills",
    };
  }

  throw new Error(`Unsupported dependency source: ${source}. Use registry:<name>, ./, ../, local:, github:, git:, skillkit:, or vercel:.`);
}

function isBareRegistryName(source: string): boolean {
  return !source.includes(":") && !isLocalSource(source);
}

function isLocalSource(source: string): boolean {
  return source === "~"
    || source.startsWith("~/")
    || source.startsWith("./")
    || source.startsWith("../")
    || source.startsWith("/")
    || source.startsWith("local:");
}

function localSourcePath(source: string): string {
  return source.startsWith("local:") ? source.slice("local:".length) : source;
}

function resolveLocalPath(path: string, declaringPackageRoot: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path.startsWith("/")) return resolve(path);
  return resolve(declaringPackageRoot, path);
}

async function normalizeRegistrySource(
  name: string,
  options: NormalizeDependencySourceOptions,
): Promise<NormalizedDependencySource> {
  const client = options.registryClient ?? new RegistryClient({ workspaceRoot: options.workspaceRoot });
  const entry = await client.resolve(name);
  if (!entry) {
    throw new Error(
      `Registry entry not found: ${name}. Bare dependency names are registry-only inside package manifests; `
      + "use ./, ../, local:, github:, git:, skillkit:, or vercel: for explicit sources.",
    );
  }

  const resolved = await normalizeDependencySource(entry.source, {
    ...options,
    ref: options.ref,
  });
  return {
    ...resolved,
    registryEntry: entry,
    normalizedSource: `registry:${name}:${resolved.normalizedSource}`,
  };
}

function parseGitSource(source: string): { url: string; ref?: string } {
  if (source.startsWith("github:")) {
    const rest = source.slice("github:".length);
    const [repo, ref] = rest.split("#", 2);
    if (!repo.includes("/")) throw new Error(`Invalid GitHub dependency source: ${source}`);
    return { url: `https://github.com/${repo.replace(/\.git$/i, "")}.git`, ref };
  }

  const rest = source.slice("git:".length);
  const hashIndex = rest.lastIndexOf("#");
  if (hashIndex >= 0) {
    return { url: rest.slice(0, hashIndex), ref: rest.slice(hashIndex + 1) };
  }
  return { url: rest };
}

function normalizeGitRemoteUrl(url: string, declaringPackageRoot: string): string {
  if (url.startsWith("./") || url.startsWith("../") || url.startsWith("/") || url === "~" || url.startsWith("~/")) {
    return resolveLocalPath(url, declaringPackageRoot);
  }

  const sshGitHub = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url);
  if (sshGitHub) {
    return `https://github.com/${sshGitHub[1].toLowerCase()}.git`;
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    if (parsed.hostname === "github.com") {
      parsed.protocol = "https:";
      parsed.pathname = `/${parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").toLowerCase()}.git`;
    }
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.replace(/\/+$/g, "");
  }
}

function normalizeProviderSpec(spec: string, declaringPackageRoot: string): string {
  if (!spec) throw new Error("Provider dependency source must include a spec.");
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec === "~" || spec.startsWith("~/")) {
    return resolveLocalPath(spec, declaringPackageRoot);
  }
  return spec.trim();
}

export function driverForNormalizedSource(source: string): SourceDriverName {
  return inferSourceDriverName(source);
}
