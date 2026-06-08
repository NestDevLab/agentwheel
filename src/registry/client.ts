import { readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryCacheSchema, registryIndexSchema, type RegistryCache, type RegistryEntry } from "../model/registry.js";
import { readMergedWorkspaceConfig } from "../model/workspace.js";
import { GitSourceDriver } from "../source/git.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

export const DEFAULT_REGISTRY_SOURCE = "github:NestDevLab/agentwheel-registry";
export const DEFAULT_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export interface RegistryClientOptions {
  workspaceRoot?: string;
  sources?: string[];
  cachePath?: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface RegistryIndex {
  entries: RegistryEntry[];
  sources: string[];
  fetchedAt: string;
  fromCache: boolean;
}

export class RegistryClient {
  private readonly git = new GitSourceDriver();
  private readonly now: () => Date;
  private readonly cachePath: string;

  constructor(private readonly options: RegistryClientOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.cachePath = options.cachePath ?? defaultRegistryCachePath();
  }

  async getIndex(options: { refresh?: boolean } = {}): Promise<RegistryIndex> {
    const sources = await this.getSources();
    const ttlMs = await this.getTtlMs();
    const cached = await this.readCache();
    if (!options.refresh && cached && sameSources(cached.sources, sources) && !this.isExpired(cached, ttlMs)) {
      return { entries: cached.entries, sources: cached.sources, fetchedAt: cached.fetchedAt, fromCache: true };
    }

    const entries = mergeIndexes(await Promise.all(sources.map((source) => this.fetchSource(source))));
    const fetchedAt = this.now().toISOString();
    await writeJsonAtomic(this.cachePath, { version: 1, fetchedAt, sources, entries } satisfies RegistryCache);
    return { entries, sources, fetchedAt, fromCache: false };
  }

  async resolve(name: string, options: { refresh?: boolean } = {}): Promise<RegistryEntry | undefined> {
    const index = await this.getIndex(options);
    return index.entries.find((entry) => entry.name === name);
  }

  async search(query: string, options: { refresh?: boolean } = {}): Promise<RegistryEntry[]> {
    const q = query.toLowerCase();
    const index = await this.getIndex(options);
    return index.entries.filter((entry) =>
      entry.name.toLowerCase().includes(q)
      || entry.description.toLowerCase().includes(q)
      || entry.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  async clearCache(): Promise<void> {
    await rm(this.cachePath, { force: true });
  }

  private async getSources(): Promise<string[]> {
    if (this.options.sources?.length) return this.options.sources;
    if (process.env.AGENTWHEEL_REGISTRY) {
      return process.env.AGENTWHEEL_REGISTRY.split(",").map((source) => source.trim()).filter(Boolean);
    }
    if (this.options.workspaceRoot) {
      const config = await readMergedWorkspaceConfig(this.options.workspaceRoot);
      if (config.registry.sources?.length) return config.registry.sources;
    }
    return [DEFAULT_REGISTRY_SOURCE];
  }

  private async getTtlMs(): Promise<number> {
    if (this.options.ttlMs !== undefined) return this.options.ttlMs;
    if (this.options.workspaceRoot) {
      const config = await readMergedWorkspaceConfig(this.options.workspaceRoot);
      if (config.registry.ttlSeconds !== undefined) return config.registry.ttlSeconds * 1000;
    }
    return DEFAULT_REGISTRY_TTL_MS;
  }

  private async readCache(): Promise<RegistryCache | undefined> {
    if (!(await pathExists(this.cachePath))) return undefined;
    return registryCacheSchema.parse(JSON.parse(await readFile(this.cachePath, "utf8")));
  }

  private isExpired(cache: RegistryCache, ttlMs: number): boolean {
    return this.now().getTime() - new Date(cache.fetchedAt).getTime() > ttlMs;
  }

  private async fetchSource(source: string): Promise<RegistryEntry[]> {
    const raw = await this.readSourceIndex(source);
    return registryIndexSchema.parse(JSON.parse(raw));
  }

  private async readSourceIndex(source: string): Promise<string> {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Registry source failed (${response.status}): ${source}`);
      return response.text();
    }

    const filePath = source.startsWith("file:") ? fileURLToPath(source) : source;
    if (await pathExists(filePath)) {
      const fullPath = resolve(filePath);
      const stats = await stat(fullPath);
      return readFile(stats.isDirectory() ? join(fullPath, "index.json") : fullPath, "utf8");
    }

    const resolved = await this.git.fetch(await this.git.resolve(source, { cacheRoot: join(dirname(this.cachePath), "registry-repos") }));
    return readFile(join(resolved.resolvedPath, "index.json"), "utf8");
  }
}

export async function resolvePackageSource(source: string, workspaceRoot: string): Promise<{ source: string; registryEntry?: RegistryEntry }> {
  const { isExplicitSource } = await import("../source/identify.js");
  if (await isExplicitSource(source)) return { source };

  const entry = await new RegistryClient({ workspaceRoot }).resolve(source);
  if (!entry) {
    throw new Error(`Registry entry not found: ${source}. Use an explicit path/git/skillkit/vercel source to bypass the registry.`);
  }
  return { source: entry.source, registryEntry: entry };
}

export function mergeIndexes(indexes: RegistryEntry[][]): RegistryEntry[] {
  const merged = new Map<string, RegistryEntry>();
  for (const index of indexes) {
    for (const entry of index) {
      if (!merged.has(entry.name)) merged.set(entry.name, entry);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function defaultRegistryCachePath(): string {
  return join(homedir(), ".agentwheel", "registry-cache.json");
}

function sameSources(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((source, index) => source === b[index]);
}
