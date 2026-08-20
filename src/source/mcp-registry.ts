import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Artifact } from "../model/artifact.js";
import { CURRENT_OPENPACK_SCHEMA_VERSION } from "../model/package.js";
import { hashPath, pathExists } from "../utils/fs.js";
import { LocalSourceDriver } from "./local.js";
import type { ResolvedSource, ScanResult, SourceDriver, SourceResolveOptions } from "./types.js";

const registryBaseUrl = "https://registry.modelcontextprotocol.io/v0.1";
const sourcePrefix = "mcp-registry:";

interface McpRegistryResponse {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    remotes?: Array<{
      type?: string;
      url?: string;
      headers?: Array<{
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
  };
}

export class McpRegistrySourceDriver implements SourceDriver {
  readonly name = "mcp-registry";
  private readonly local = new LocalSourceDriver();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async resolve(source: string, options: SourceResolveOptions = {}): Promise<ResolvedSource> {
    const serverName = parseMcpRegistrySource(source);
    return {
      driver: this.name,
      source,
      resolvedPath: cachePathFor(serverName, options.cacheRoot),
      packageName: `mcp-registry/${serverName}`,
      mode: options.mode ?? "tracking",
      requestedRef: options.ref ?? "latest",
      frozenLock: options.frozenLock,
    };
  }

  async fetch(resolved: ResolvedSource): Promise<ResolvedSource> {
    if (resolved.frozenLock) {
      if (!(await pathExists(resolved.resolvedPath))) {
        throw new Error(`Frozen lock requires cached MCP registry source at ${resolved.resolvedPath}`);
      }
      return {
        ...resolved,
        sourceHash: await hashPath(resolved.resolvedPath),
      };
    }

    const serverName = parseMcpRegistrySource(resolved.source);
    const response = await this.fetchImpl(`${registryBaseUrl}/servers/${encodeURIComponent(serverName)}/versions/latest`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`MCP registry lookup failed for ${serverName}: HTTP ${response.status}`);
    }
    const payload = await response.json() as McpRegistryResponse;
    const server = payload.server;
    if (!server?.name) {
      throw new Error(`MCP registry response missing server metadata for ${serverName}`);
    }
    const remote = supportedRemote(server.remotes ?? []);
    if (!remote) {
      throw new Error(`MCP registry server is discovery-only for Agentwheel: ${serverName}`);
    }

    await writeGeneratedPackage(resolved.resolvedPath, {
      serverName: server.name,
      title: server.title,
      description: server.description,
      version: server.version,
      url: remote.url,
    });

    return {
      ...resolved,
      packageName: `mcp-registry/${server.name}`,
      packageVersion: server.version,
      sourceHash: await hashPath(resolved.resolvedPath),
    };
  }

  async list(resolved: ResolvedSource): Promise<Artifact[]> {
    return this.local.list({ ...resolved, driver: "local" });
  }

  async scan(resolved: ResolvedSource): Promise<ScanResult> {
    if (!(await pathExists(join(resolved.resolvedPath, "mcp")))) {
      return { ok: false, findings: [{ level: "error", message: "MCP registry source has no generated mcp artifact" }] };
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

function parseMcpRegistrySource(source: string): string {
  if (!source.startsWith(sourcePrefix)) {
    throw new Error(`Invalid MCP registry source: ${source}`);
  }
  const serverName = source.slice(sourcePrefix.length).trim();
  if (!serverName) throw new Error(`Invalid MCP registry source: ${source}`);
  return serverName;
}

function supportedRemote(remotes: NonNullable<McpRegistryResponse["server"]>["remotes"]): { url: string } | undefined {
  for (const remote of remotes ?? []) {
    if (remote?.type !== "streamable-http") continue;
    if (!isSafeHttpUrl(remote.url)) continue;
    if ((remote.headers ?? []).some((header) => header.isRequired && header.isSecret)) continue;
    return { url: remote.url };
  }
  return undefined;
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function writeGeneratedPackage(root: string, server: { serverName: string; title?: string; description?: string; version?: string; url: string }): Promise<void> {
  const serverId = installNameFor(server.serverName);
  const mcpPath = join(root, "mcp", `${serverId}.json`);
  await mkdir(dirname(mcpPath), { recursive: true });
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: CURRENT_OPENPACK_SCHEMA_VERSION,
    name: `mcp-registry/${server.serverName}`,
    version: server.version ?? "latest",
    provides: [{ type: "mcp", path: "mcp" }],
  }, null, 2)}\n`, "utf8");
  await writeFile(mcpPath, `${JSON.stringify({
    mcpServers: {
      [serverId]: {
        type: "streamable-http",
        url: server.url,
      },
    },
  }, null, 2)}\n`, "utf8");
}

function installNameFor(serverName: string): string {
  return basename(serverName)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || "mcp-server";
}

function cachePathFor(serverName: string, cacheRoot?: string): string {
  const root = cacheRoot ? resolve(cacheRoot) : join(process.env.HOME ?? ".", ".agentwheel", "cache");
  const slug = `mcp-registry-${serverName}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return join(root, slug || "mcp-registry-server");
}
