import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  catalogueCacheSchema,
  catalogueCacheEnvelopeSchema,
  enrichedCatalogueSchema,
  vercelCatalogueSchema,
  type CatalogueCache,
  type EnrichedCatalogue,
  type VercelCatalogue,
} from "../model/catalogue.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

export const DEFAULT_ENRICHED_CATALOGUE_URL =
  "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-data.json";
export const DEFAULT_VERCEL_CATALOGUE_URL =
  "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-vercel-index.json";
export const DEFAULT_CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CATALOGUE_PAYLOAD_BYTES = 32 * 1024 * 1024;

export interface CatalogueClientOptions {
  cachePath?: string;
  ttlMs?: number;
  now?: () => Date;
  offline?: boolean;
  warn?: (message: string) => void;
  fetch?: typeof fetch;
  enrichedUrl?: string;
  vercelUrl?: string;
}

export interface CatalogueIndex {
  enriched: EnrichedCatalogue;
  vercel: VercelCatalogue;
  sources: [string, string];
  fetchedAt: string;
  fromCache: boolean;
  stale: boolean;
  sourceDigests?: { enriched: string; vercel: string };
}

type CatalogueCacheFile = CatalogueCache;

export class CatalogueClient {
  private readonly cachePath: string;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly sources: [string, string];

  constructor(private readonly options: CatalogueClientOptions = {}) {
    this.cachePath = options.cachePath ?? defaultCatalogueCachePath();
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? fetch;
    this.sources = [
      options.enrichedUrl ?? DEFAULT_ENRICHED_CATALOGUE_URL,
      options.vercelUrl ?? DEFAULT_VERCEL_CATALOGUE_URL,
    ];
  }

  async getIndex(options: { refresh?: boolean } = {}): Promise<CatalogueIndex> {
    const cached = await this.readCache();
    const usableCache = cached && sameSources(cached.sources, this.sources) ? cached : undefined;
    const expired = usableCache ? this.isExpired(usableCache) : false;

    if (this.options.offline) {
      if (!usableCache) {
        throw new Error("Offline catalogue cache is missing. Run without --offline first.");
      }
      const stale = expired;
      this.options.warn?.(
        stale
          ? "Offline: using stale catalogue cache because refresh is disabled."
          : "Offline: using cached catalogue data.",
      );
      return this.fromCache(usableCache, stale);
    }

    if (!options.refresh && usableCache && !expired) {
      return this.fromCache(usableCache, false);
    }

    try {
      const [enrichedPayload, vercelPayload] = await Promise.all([
        this.fetchJson(this.sources[0], enrichedCatalogueSchema),
        this.fetchJson(this.sources[1], vercelCatalogueSchema),
      ]);
      const { value: enriched, digest: enrichedDigest } = enrichedPayload;
      const { value: vercel, digest: vercelDigest } = vercelPayload;
      const fetchedAt = this.now().toISOString();
      const cache = {
        version: 1,
        fetchedAt,
        sources: this.sources,
        enriched,
        vercel,
        sourceDigests: { enriched: enrichedDigest, vercel: vercelDigest },
      } satisfies CatalogueCache;
      const cacheFile = {
        ...cache,
        contentHash: catalogueContentHash(enriched, vercel),
      };
      await writeJsonAtomic(this.cachePath, cacheFile);
      return {
        enriched,
        vercel,
        sources: this.sources,
        fetchedAt,
        fromCache: false,
        stale: false,
        sourceDigests: cache.sourceDigests,
      };
    } catch (error) {
      if (!usableCache) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.options.warn?.(`Catalogue refresh failed; using stale catalogue cache: ${reason}`);
      return this.fromCache(usableCache, true);
    }
  }

  async clearCache(): Promise<void> {
    await rm(this.cachePath, { force: true });
  }

  private async readCache(): Promise<CatalogueCacheFile | undefined> {
    if (!(await pathExists(this.cachePath))) return undefined;
    try {
      const value: unknown = JSON.parse(await readFile(this.cachePath, "utf8"));
      const envelope = catalogueCacheEnvelopeSchema.parse(value);
      if (envelope.contentHash) {
        const contentHash = catalogueContentHash(envelope.enriched, envelope.vercel);
        if (contentHash !== envelope.contentHash) {
          throw new Error("catalogue cache integrity check failed");
        }
        return envelope as CatalogueCacheFile;
      }
      return catalogueCacheSchema.parse(value);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.warn?.(`Ignoring invalid catalogue cache: ${reason}`);
      return undefined;
    }
  }

  private isExpired(cache: CatalogueCacheFile): boolean {
    const ttlMs = this.options.ttlMs ?? DEFAULT_CATALOGUE_TTL_MS;
    return this.now().getTime() - new Date(cache.fetchedAt).getTime() > ttlMs;
  }

  private fromCache(cache: CatalogueCacheFile, stale: boolean): CatalogueIndex {
    return {
      enriched: cache.enriched,
      vercel: cache.vercel,
      sources: cache.sources,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      stale,
      sourceDigests: cache.sourceDigests,
    };
  }

  private async fetchJson<T>(
    source: string,
    schema: { parse(value: unknown): T },
  ): Promise<{ value: T; digest: string }> {
    const response = await this.fetchImpl(source);
    if (!response.ok) {
      throw new Error(`Catalogue source failed (${response.status}): ${source}`);
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const bytes = Number(declaredLength);
      if (Number.isFinite(bytes) && bytes > MAX_CATALOGUE_PAYLOAD_BYTES) {
        throw new Error(`Catalogue payload exceeds 32 MiB limit: ${source}`);
      }
    }

    const payload = await response.arrayBuffer();
    if (payload.byteLength > MAX_CATALOGUE_PAYLOAD_BYTES) {
      throw new Error(`Catalogue payload exceeds 32 MiB limit: ${source}`);
    }

    const bytes = new Uint8Array(payload);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      throw new Error(`Catalogue source returned invalid JSON: ${source}`);
    }
    return {
      value: schema.parse(value),
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}

export function defaultCatalogueCachePath(): string {
  return join(homedir(), ".agentwheel", "catalogue-cache.json");
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((source, index) => source === b[index]);
}

function catalogueContentHash(enriched: unknown, vercel: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ enriched, vercel }))
    .digest("hex");
}
