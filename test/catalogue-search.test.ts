import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatalogueClient,
  MAX_CATALOGUE_PAYLOAD_BYTES,
} from "../src/catalogue/client.js";
import {
  catalogueCacheSchema,
  enrichedCatalogueSchema,
  searchResponseSchema,
  vercelCatalogueSchema,
  type EnrichedCatalogue,
  type VercelCatalogue,
} from "../src/model/catalogue.js";
import type { RegistryEntry } from "../src/model/registry.js";
import {
  buildSearchEntries,
  normalizeSearchText,
  searchEntries,
  tokenizeSearchText,
} from "../src/search/index.js";

const tempRoots: string[] = [];
const fixtureRoot = new URL("./fixtures/catalogue/", import.meta.url);

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-catalogue-"));
  tempRoots.push(root);
  return root;
}

async function fixtures(): Promise<{ enriched: EnrichedCatalogue; vercel: VercelCatalogue }> {
  const [enriched, vercel] = await Promise.all([
    readFile(new URL("enriched.json", fixtureRoot), "utf8"),
    readFile(new URL("vercel.json", fixtureRoot), "utf8"),
  ]);
  return {
    enriched: enrichedCatalogueSchema.parse(JSON.parse(enriched)),
    vercel: vercelCatalogueSchema.parse(JSON.parse(vercel)),
  };
}

describe("catalogue schemas", () => {
  it("accepts nullable real catalogue fields and enforces the compact count", async () => {
    const { enriched, vercel } = await fixtures();
    expect(enriched.entries.find((entry) => entry.name === "informational")?.source).toBeNull();
    expect(vercel.entries).toHaveLength(2);
    expect(() => vercelCatalogueSchema.parse({ ...vercel, count: 1 })).toThrow(/count must equal entries length/);
    expect(() => enrichedCatalogueSchema.parse({
      ...enriched,
      entries: [...enriched.entries, enriched.entries[0]],
    })).toThrow(/duplicate catalogue id/);
    expect(() => vercelCatalogueSchema.parse({
      ...vercel,
      count: 3,
      entries: [...vercel.entries, vercel.entries[0]],
    })).toThrow(/duplicate Vercel catalogue id/);
  });

  it("validates the public response and atomic cache contracts", async () => {
    const { enriched, vercel } = await fixtures();
    expect(catalogueCacheSchema.parse({
      version: 1,
      fetchedAt: "2026-07-23T01:00:00.000Z",
      sources: ["https://example.test/enriched", "https://example.test/vercel"],
      enriched,
      vercel,
    }).version).toBe(1);
    expect(searchResponseSchema.parse({
      schemaVersion: 1,
      query: "browser",
      scope: "all",
      fromCache: true,
      results: [],
    }).scope).toBe("all");
  });
});

describe("catalogue client", () => {
  it("caches both payloads together and refreshes only after the TTL", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "catalogue-cache.json");
    const data = await fixtures();
    const calls: string[] = [];
    let now = new Date("2026-07-23T01:00:00.000Z");
    const client = new CatalogueClient({
      cachePath,
      ttlMs: 1000,
      now: () => now,
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
      fetch: mockFetch(data, calls),
    });

    const initial = await client.getIndex();
    expect(initial.fromCache).toBe(false);
    expect(initial.stale).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(await readFile(cachePath, "utf8")).contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await client.getIndex()).fromCache).toBe(true);
    expect(calls).toHaveLength(2);

    now = new Date("2026-07-23T01:00:02.000Z");
    expect((await client.getIndex()).fromCache).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it("keeps the previous all-or-nothing cache when either refresh fails", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "catalogue-cache.json");
    const data = await fixtures();
    let now = new Date("2026-07-23T01:00:00.000Z");
    const initial = new CatalogueClient({
      cachePath,
      ttlMs: 1000,
      now: () => now,
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
      fetch: mockFetch(data),
    });
    await initial.getIndex();
    const priorCache = await readFile(cachePath, "utf8");

    now = new Date("2026-07-23T01:00:02.000Z");
    const warnings: string[] = [];
    const failing = new CatalogueClient({
      cachePath,
      ttlMs: 1000,
      now: () => now,
      warn: (message) => warnings.push(message),
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/vercel")) return new Response("nope", { status: 503 });
        return jsonResponse({ ...data.enriched, generatedAt: "2026-07-23T02:00:00.000Z" });
      }) as typeof fetch,
    });

    const fallback = await failing.getIndex();
    expect(fallback.fromCache).toBe(true);
    expect(fallback.stale).toBe(true);
    expect(warnings.join("\n")).toMatch(/using stale catalogue cache/i);
    expect(await readFile(cachePath, "utf8")).toBe(priorCache);
  });

  it("rejects a cache whose validated catalogue payload was modified", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "catalogue-cache.json");
    const data = await fixtures();
    const online = new CatalogueClient({
      cachePath,
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
      fetch: mockFetch(data),
    });
    await online.getIndex();

    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    cache.enriched.entries[0].name = "tampered";
    await writeFile(cachePath, JSON.stringify(cache), "utf8");

    const warnings: string[] = [];
    const offline = new CatalogueClient({
      cachePath,
      offline: true,
      warn: (message) => warnings.push(message),
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
    });
    await expect(offline.getIndex()).rejects.toThrow(/cache is missing/i);
    expect(warnings.join("\n")).toMatch(/integrity check failed/i);
  });

  it("warns for offline fallback and rejects missing or oversized payloads", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "catalogue-cache.json");
    const data = await fixtures();
    const warnings: string[] = [];
    const online = new CatalogueClient({
      cachePath,
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
      fetch: mockFetch(data),
    });
    await online.getIndex();

    const offline = new CatalogueClient({
      cachePath,
      offline: true,
      warn: (message) => warnings.push(message),
      enrichedUrl: "https://example.test/enriched",
      vercelUrl: "https://example.test/vercel",
    });
    expect((await offline.getIndex()).fromCache).toBe(true);
    expect(warnings.join("\n")).toMatch(/offline/i);

    const missing = new CatalogueClient({ cachePath: join(root, "missing.json"), offline: true });
    await expect(missing.getIndex()).rejects.toThrow(/cache is missing/i);

    const oversized = new CatalogueClient({
      cachePath: join(root, "oversized.json"),
      fetch: (async () => new Response("{}", {
        headers: { "content-length": String(MAX_CATALOGUE_PAYLOAD_BYTES + 1) },
      })) as typeof fetch,
    });
    await expect(oversized.getIndex()).rejects.toThrow(/32 MiB/);
  });
});

describe("catalogue normalization and ranking", () => {
  it("merges exact IDs and only safe selector-free registry identities", async () => {
    const { enriched, vercel } = await fixtures();
    const registry: RegistryEntry[] = [
      {
        name: "shared-tool",
        source: "https://github.com/nestdevlab/shared-tool.git",
        type: "package",
        description: "Registry description.",
        tags: ["curated"],
      },
      {
        name: "archived-helper",
        source: "skillkit:archived-helper",
        type: "skill",
        description: "Selector-specific registry entry.",
        tags: [],
        select: ["skills:archived-helper"],
      },
    ];
    const entries = buildSearchEntries({ registry, enriched, vercel });
    const shared = entries.find((entry) => entry.id === "official:shared-tool");
    expect(shared?.provenances).toEqual(["registry", "enriched"]);
    expect(shared?.installability).toBe("registry");
    expect(shared?.installCommand).toBe("npx agentwheel install 'shared-tool'");
    expect(shared?.description).toBe("Primary toolkit for release automation.");
    expect(shared?.alternateDescriptions).toContain("Registry description.");
    expect(entries.filter((entry) => entry.name === "archived-helper")).toHaveLength(2);

    const browser = entries.find((entry) => entry.id === "vercel:acme/browser-tools/browser-runner");
    expect(browser?.provenances).toEqual(["enriched", "vercel"]);
    expect(browser?.description).toBe("Browser automation for deterministic UI checks.");
    expect(browser?.alternateDescriptions).toContain("Navigate websites with a chromium page pilot.");
  });

  it("uses explicit sources without an active registry route", async () => {
    const { enriched } = await fixtures();
    const entries = buildSearchEntries({ enriched });
    const shared = entries.find((entry) => entry.id === "official:shared-tool");

    expect(shared?.installability).toBe("source");
    expect(shared?.installCommand).toBe("npx agentwheel install 'github:NestDevLab/shared-tool'");
  });

  it("canonicalizes supported GitHub spellings without folding case-sensitive refs", () => {
    const catalogueEntry = {
      id: "official:release-tool",
      name: "release-tool",
      ecosystem: "official" as const,
      type: "package" as const,
      description: "Release automation.",
      tags: [],
      source: "github:NestDevLab/release-tool#Release",
      installCommand: "npx agentwheel install release-tool",
      repoUrl: "https://github.com/NestDevLab/release-tool",
      archived: false,
      provides: [],
      version: null,
    };
    const matching = buildSearchEntries({
      registry: [{
        name: "release-tool",
        source: "git:https://github.com/nestdevlab/release-tool.git#Release",
        type: "package",
        description: "Registry route.",
        tags: [],
      }],
      enriched: [catalogueEntry],
    });
    expect(matching).toHaveLength(1);
    expect(matching[0]?.provenances).toEqual(["registry", "enriched"]);

    const distinctRef = buildSearchEntries({
      registry: [{
        name: "release-tool",
        source: "git:https://github.com/nestdevlab/release-tool.git#release",
        type: "package",
        description: "Different ref.",
        tags: [],
      }],
      enriched: [catalogueEntry],
    });
    expect(distinctRef).toHaveLength(2);
  });

  it("uses stable registry IDs and sorts merged metadata", async () => {
    const entries = buildSearchEntries({
      registry: [{
        name: "standalone",
        source: "skillkit:example/standalone",
        type: "skill",
        description: "Standalone registry artifact.",
        tags: ["zeta", "alpha"],
      }],
    });

    expect(entries[0]?.id).toBe("registry:standalone");
    expect(entries[0]?.tags).toEqual(["alpha", "zeta"]);
  });

  it("searches alternate Vercel descriptions and ranks exact names deterministically", async () => {
    const entries = buildSearchEntries(await fixtures());
    expect(searchEntries(entries, "chromium page pilot")[0]?.id)
      .toBe("vercel:acme/browser-tools/browser-runner");
    expect(searchEntries(entries, "browser-runner")[0]?.name).toBe("browser-runner");

    const repeated = searchEntries(entries, "release automation").map((result) => result.id);
    expect(searchEntries(entries, "release automation").map((result) => result.id)).toEqual(repeated);
  });

  it("normalizes Unicode punctuation and applies type, ecosystem, archived, and limit filters", async () => {
    const entries = buildSearchEntries(await fixtures());
    expect(normalizeSearchText("ＣＡＦÉ—Writer")).toBe("café writer");
    expect(tokenizeSearchText("Release...release NOTES")).toEqual(["release", "notes"]);

    expect(searchEntries(entries, "café writer", { type: "skill", ecosystem: "vercel" })[0]?.name)
      .toBe("café-writer");
    expect(searchEntries(entries, "database")).toEqual([]);
    expect(searchEntries(entries, "database", { includeArchived: true })[0]?.name).toBe("archived-helper");
    expect(searchEntries(entries, "skill", { limit: 1 })).toHaveLength(1);
  });

  it("applies each declared scoring signal once and keeps all-terms additive", () => {
    const entries = buildSearchEntries({
      enriched: {
        schemaVersion: 1,
        generatedAt: "2026-07-23T00:00:00.000Z",
        entries: [{
          id: "skillkit:weights",
          name: "weights",
          ecosystem: "skillkit",
          type: "skill",
          description: "",
          tags: ["shared"],
          source: null,
          installCommand: null,
          repoUrl: null,
          archived: false,
          provides: ["shared"],
          version: null,
        }],
      },
    });

    expect(searchEntries(entries, "weights")[0]?.score).toBe(10_800);
    expect(searchEntries(entries, "shared")[0]?.score).toBe(2_680);
    expect(searchEntries(entries, "skill")[0]?.score).toBe(1_360);
  });

  it("uses featured, stars, and last push as stable score tie-breaks", () => {
    const base = {
      ecosystem: "openpack" as const,
      type: "package" as const,
      description: "",
      tags: ["shared"],
      source: null,
      installCommand: null,
      repoUrl: null,
      archived: false,
      provides: [],
      version: null,
    };
    const entries = buildSearchEntries({
      enriched: {
        schemaVersion: 1,
        generatedAt: "2026-07-23T00:00:00.000Z",
        entries: [
          { ...base, id: "openpack:last-old", name: "last-old", featured: false, stars: 5, lastPush: "2026-01-01T00:00:00Z" },
          { ...base, id: "openpack:featured", name: "featured", featured: true, stars: 0, lastPush: null },
          { ...base, id: "openpack:stars", name: "stars", featured: false, stars: 10, lastPush: null },
          { ...base, id: "openpack:last-new", name: "last-new", featured: false, stars: 5, lastPush: "2026-02-01T00:00:00Z" },
        ],
      },
    });

    expect(searchEntries(entries, "shared").map((entry) => entry.id)).toEqual([
      "openpack:featured",
      "openpack:stars",
      "openpack:last-new",
      "openpack:last-old",
    ]);
  });
});

function mockFetch(
  data: { enriched: EnrichedCatalogue; vercel: VercelCatalogue },
  calls: string[] = [],
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const source = String(url);
    calls.push(source);
    return jsonResponse(source.endsWith("/vercel") ? data.vercel : data.enriched);
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
