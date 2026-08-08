import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SemanticSearchClient } from "../src/semantic/index.js";
import type { SearchEntry } from "../src/search/index.js";

const dimensions = 384;
const ids = ["official:memory", "vercel:example/tools/browser"];
const vectors = new Int8Array(dimensions * ids.length);
vectors[0] = 10;
vectors[dimensions] = 2;
const norms = new Float32Array([10, 3]);

const entries: SearchEntry[] = [
  entry("official:memory", "memory-helper", "package", "official"),
  entry("vercel:example/tools/browser", "browser-helper", "skill", "vercel"),
];

describe("semantic catalogue search", () => {
  it("verifies the published index contract and maps ranked IDs to catalogue entries", async () => {
    const client = new SemanticSearchClient({
      fetch: fixtureFetch(),
      embed: async () => Float32Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0),
    });
    const results = await client.search({
      query: "retain corrections",
      entries,
      catalogueDigests: { enriched: "a".repeat(64), vercel: "b".repeat(64) },
      limit: 2,
    });

    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results[0]).toMatchObject({ matchedFields: ["semantic"], semanticScore: 1 });
    expect(results[1]?.semanticScore).toBe(0.666667);
  });

  it("applies normal catalogue filters after semantic ranking", async () => {
    const client = new SemanticSearchClient({
      fetch: fixtureFetch(),
      embed: async () => Float32Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0),
    });
    const results = await client.search({
      query: "browser",
      entries,
      catalogueDigests: { enriched: "a".repeat(64), vercel: "b".repeat(64) },
      ecosystem: "vercel",
      limit: 2,
    });
    expect(results.map((result) => result.id)).toEqual(["vercel:example/tools/browser"]);
  });

  it("rejects an index that was built for different catalogue bytes", async () => {
    const client = new SemanticSearchClient({ fetch: fixtureFetch() });
    await expect(client.search({
      query: "memory",
      entries,
      catalogueDigests: { enriched: "c".repeat(64), vercel: "b".repeat(64) },
      limit: 1,
    })).rejects.toThrow(/catalogue checksum/i);
  });
});

function fixtureFetch(): typeof fetch {
  const idsBytes = new TextEncoder().encode(JSON.stringify(ids));
  const vectorBytes = new Uint8Array(vectors.buffer);
  const normBytes = new Uint8Array(norms.buffer);
  const metadata = {
    schemaVersion: 1,
    textSchemaVersion: 1,
    count: ids.length,
    dimensions,
    vectorFormat: "signed-int8-per-vector-scaled",
    normFormat: "float32-little-endian",
    model: {
      id: "Xenova/gte-small",
      revision: "5927d1727bb12db490052a1b33265ad78058de08",
      dimensions,
      dtype: "q8",
      pooling: "mean",
      normalize: true,
      queryPrefix: "",
      documentPrefix: "",
    },
    catalogue: { enriched: { sha256: "a".repeat(64) }, vercel: { sha256: "b".repeat(64) } },
    files: {
      ids: descriptor("ids.json", idsBytes),
      vectors: descriptor("vectors.int8.bin", vectorBytes),
      norms: descriptor("norms.f32.bin", normBytes),
    },
  };
  return (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("metadata.json")) return new Response(JSON.stringify(metadata));
    if (path.endsWith("ids.json")) return new Response(idsBytes);
    if (path.endsWith("vectors.int8.bin")) return new Response(vectorBytes);
    if (path.endsWith("norms.f32.bin")) return new Response(normBytes);
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

function descriptor(path: string, bytes: Uint8Array) {
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function entry(id: string, name: string, type: SearchEntry["type"], ecosystem: NonNullable<SearchEntry["ecosystem"]>): SearchEntry {
  return {
    id,
    name,
    description: `${name} description`,
    type,
    ecosystem,
    tags: [],
    provides: [],
    source: `github:example/${name}`,
    installability: "source",
    provenances: [ecosystem === "vercel" ? "vercel" : "enriched"],
    archived: false,
    featured: false,
    alternateDescriptions: [],
    descriptionRank: 1,
    hasRegistrySelectors: false,
  };
}
