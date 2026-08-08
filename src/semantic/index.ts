import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import type { SearchResult, SearchType, SearchEcosystem } from "../model/catalogue.js";
import type { SearchEntry } from "../search/index.js";

export const DEFAULT_SEMANTIC_INDEX_URL =
  "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-semantic-index/gte-v1/";

const CONTRACT = {
  schemaVersion: 1,
  textSchemaVersion: 1,
  model: {
    id: "Xenova/gte-small",
    revision: "5927d1727bb12db490052a1b33265ad78058de08",
    dimensions: 384,
    dtype: "q8",
    pooling: "mean",
    normalize: true,
    queryPrefix: "",
    documentPrefix: "",
  },
  vectorFormat: "signed-int8-per-vector-scaled",
  normFormat: "float32-little-endian",
} as const;

interface SemanticFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface SemanticMetadata {
  schemaVersion: number;
  textSchemaVersion: number;
  count: number;
  dimensions: number;
  vectorFormat: string;
  normFormat: string;
  model: Record<string, unknown>;
  catalogue: { enriched?: { sha256?: string }; vercel?: { sha256?: string } };
  files: { ids?: SemanticFile; vectors?: SemanticFile; norms?: SemanticFile };
}

export interface SemanticSearchOptions {
  indexUrl?: string;
  fetch?: typeof fetch;
  embed?: (query: string) => Promise<Float32Array>;
  warn?: (message: string) => void;
}

export interface SemanticSearchRequest {
  query: string;
  entries: SearchEntry[];
  catalogueDigests?: { enriched: string; vercel: string };
  type?: SearchType;
  ecosystem?: SearchEcosystem;
  includeArchived?: boolean;
  limit: number;
}

export class SemanticSearchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly indexUrl: string;

  constructor(private readonly options: SemanticSearchOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.indexUrl = ensureTrailingSlash(options.indexUrl ?? DEFAULT_SEMANTIC_INDEX_URL);
  }

  async search(request: SemanticSearchRequest): Promise<SearchResult[]> {
    if (!request.catalogueDigests) {
      throw new Error("Semantic search needs a catalogue cache with source checksums. Run again online with --refresh.");
    }
    const metadata = await this.fetchMetadata();
    validateMetadata(metadata, request.catalogueDigests);
    const [ids, vectors, norms] = await Promise.all([
      this.fetchIds(metadata.files.ids!),
      this.fetchBinary(metadata.files.vectors!),
      this.fetchBinary(metadata.files.norms!),
    ]);
    const decodedNorms = decodeFloat32LittleEndian(norms);
    validateIndexFiles(metadata, ids, vectors, decodedNorms);
    const query = await (this.options.embed ?? embedQuery)(request.query);
    if (query.length !== metadata.dimensions) {
      throw new Error(`Semantic model returned ${query.length} dimensions; expected ${metadata.dimensions}.`);
    }
    const ranked = searchInt8Index(vectors, decodedNorms, metadata.dimensions, query, Math.max(100, request.limit * 10));
    const entries = new Map(request.entries.map((entry) => [entry.id, entry]));
    const results: SearchResult[] = [];
    for (const candidate of ranked) {
      const entry = entries.get(ids[candidate.row]!);
      if (!entry || (!request.includeArchived && entry.archived)) continue;
      if (request.type && entry.type !== request.type) continue;
      if (request.ecosystem && entry.ecosystem !== request.ecosystem) continue;
      results.push(toSearchResult(entry, candidate.score, results.length));
      if (results.length === request.limit) break;
    }
    if (results.length === 0) this.options.warn?.("Semantic index had no candidates matching the selected filters.");
    return results;
  }

  private async fetchMetadata(): Promise<SemanticMetadata> {
    const response = await this.fetchImpl(new URL("metadata.json", this.indexUrl));
    if (!response.ok) throw new Error(`Semantic index metadata failed (${response.status}).`);
    let metadata: unknown;
    try {
      metadata = JSON.parse(await response.text());
    } catch {
      throw new Error("Semantic index metadata is not valid JSON.");
    }
    return metadata as SemanticMetadata;
  }

  private async fetchIds(descriptor: SemanticFile): Promise<string[]> {
    const bytes = await this.fetchBinary(descriptor);
    let ids: unknown;
    try {
      ids = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Semantic index IDs are not valid JSON.");
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Semantic index IDs are invalid.");
    }
    return ids;
  }

  private async fetchBinary(descriptor: SemanticFile): Promise<Uint8Array> {
    const response = await this.fetchImpl(new URL(descriptor.path, this.indexUrl));
    if (!response.ok) throw new Error(`Semantic index file failed (${response.status}): ${descriptor.path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== descriptor.bytes) throw new Error(`Semantic index file size does not match: ${descriptor.path}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== descriptor.sha256) throw new Error(`Semantic index checksum does not match: ${descriptor.path}`);
    return bytes;
  }
}

async function embedQuery(query: string): Promise<Float32Array> {
  env.cacheDir = join(homedir(), ".agentwheel", "semantic-models");
  const extractor = await pipeline("feature-extraction", CONTRACT.model.id, {
    revision: CONTRACT.model.revision,
    dtype: CONTRACT.model.dtype,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  const output = await extractor(query, { pooling: CONTRACT.model.pooling, normalize: CONTRACT.model.normalize });
  return Float32Array.from(output.data as Float32Array);
}

function validateMetadata(metadata: SemanticMetadata, digests: { enriched: string; vercel: string }): void {
  if (metadata.schemaVersion !== CONTRACT.schemaVersion || metadata.textSchemaVersion !== CONTRACT.textSchemaVersion) {
    throw new Error("Unsupported semantic index schema.");
  }
  if (!Number.isInteger(metadata.count) || metadata.count < 1 || metadata.dimensions !== CONTRACT.model.dimensions) {
    throw new Error("Semantic index dimensions or count are invalid.");
  }
  if (metadata.vectorFormat !== CONTRACT.vectorFormat || metadata.normFormat !== CONTRACT.normFormat) {
    throw new Error("Semantic index binary format is unsupported.");
  }
  for (const [field, value] of Object.entries(CONTRACT.model)) {
    if (metadata.model?.[field] !== value) throw new Error(`Semantic model ${field} does not match.`);
  }
  for (const source of ["enriched", "vercel"] as const) {
    if (metadata.catalogue?.[source]?.sha256 !== digests[source]) {
      throw new Error(`Semantic index catalogue checksum does not match ${source}.`);
    }
  }
  for (const key of ["ids", "vectors", "norms"] as const) {
    const descriptor = metadata.files?.[key];
    if (!descriptor || typeof descriptor.path !== "string" || !Number.isInteger(descriptor.bytes)
      || descriptor.bytes < 1 || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)) {
      throw new Error(`Semantic index ${key} descriptor is invalid.`);
    }
  }
}

function validateIndexFiles(metadata: SemanticMetadata, ids: string[], vectors: Uint8Array, norms: Float32Array): void {
  if (ids.length !== metadata.count || vectors.length !== metadata.count * metadata.dimensions || norms.length !== metadata.count) {
    throw new Error("Semantic index files do not match metadata.");
  }
}

function decodeFloat32LittleEndian(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("Semantic norm file has an invalid length.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < result.length; index += 1) result[index] = view.getFloat32(index * 4, true);
  return result;
}

function searchInt8Index(vectors: Uint8Array, norms: Float32Array, dimensions: number, query: Float32Array, limit: number): Array<{ row: number; score: number }> {
  const results: Array<{ row: number; score: number }> = [];
  const signed = new Int8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  for (let row = 0; row < norms.length; row += 1) {
    let dot = 0;
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column += 1) dot += signed[offset + column]! * query[column]!;
    const candidate = { row, score: norms[row]! > 0 ? dot / norms[row]! : 0 };
    const index = results.findIndex((item) => candidate.score > item.score);
    results.splice(index === -1 ? results.length : index, 0, candidate);
    if (results.length > limit) results.pop();
  }
  return results;
}

function toSearchResult(entry: SearchEntry, semanticScore: number, rank: number): SearchResult {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    ...(entry.ecosystem ? { ecosystem: entry.ecosystem } : {}),
    tags: entry.tags,
    provides: entry.provides,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.repoUrl ? { repoUrl: entry.repoUrl } : {}),
    ...(entry.installCommand ? { installCommand: entry.installCommand } : {}),
    installability: entry.installability,
    provenances: entry.provenances,
    score: 100_000 - rank,
    matchedFields: ["semantic"],
    semanticScore: Number(semanticScore.toFixed(6)),
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
