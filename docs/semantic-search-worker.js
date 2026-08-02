import {
  SEMANTIC_INDEX_CONTRACT,
  computeInt8Centroid,
  decodeFloat32LittleEndian,
  describeConfidence,
  searchInt8Index,
  validateSemanticIndexFiles,
  validateSemanticIndexMetadata,
} from "./semantic-search-core.js";

const TRANSFORMERS_MODULE_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

let extractor = null;
let metadata = null;
let ids = null;
let vectors = null;
let norms = null;
let centroid = null;
let transformersPromise = null;

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    if (type === "load") {
      await loadEngine(id, payload);
      respond(id, "ready", {
        count: metadata.count,
        modelBytes: metadata.model.q8ModelBytes,
        indexBytes: Object.values(metadata.files).reduce((sum, file) => sum + file.bytes, 0),
      });
      return;
    }
    if (type === "search") {
      const result = await search(payload?.query);
      respond(id, "result", result);
      return;
    }
    throw new Error(`Unsupported semantic worker message: ${type}`);
  } catch (error) {
    respond(id, "error", { message: error instanceof Error ? error.message : String(error) });
  }
});

async function loadEngine(requestId, payload) {
  if (extractor && metadata && ids && vectors && norms && centroid) return;
  progress(requestId, "runtime", 0, "Loading the private browser runtime");
  const { pipeline, env } = await loadTransformers();
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  progress(requestId, "runtime", 1, "Browser runtime ready");

  const baseUrl = normalizeBaseUrl(payload?.indexBaseUrl);
  metadata = validateSemanticIndexMetadata(
    await fetchJson(new URL("metadata.json", baseUrl)),
    payload?.catalogueDigests,
  );

  progress(requestId, "model", 0, "Downloading the English search model");
  extractor = await pipeline("feature-extraction", metadata.model.id, {
    revision: metadata.model.revision,
    dtype: metadata.model.dtype,
    device: "wasm",
    progress_callback: (event) => {
      if (event.status === "progress_total") {
        progress(requestId, "model", clamp(event.progress / 100), "Downloading the English search model", {
          loaded: event.loaded,
          total: event.total,
        });
      }
    },
  });
  progress(requestId, "model", 1, "Search model ready");

  const fileProgress = new Map();
  const totalIndexBytes = Object.values(metadata.files).reduce((sum, file) => sum + file.bytes, 0);
  const onFileProgress = (name, loaded) => {
    fileProgress.set(name, loaded);
    const totalLoaded = [...fileProgress.values()].reduce((sum, value) => sum + value, 0);
    progress(requestId, "index", clamp(totalLoaded / totalIndexBytes), "Downloading the catalogue index", {
      loaded: totalLoaded,
      total: totalIndexBytes,
    });
  };

  const [idsBuffer, vectorBuffer, normBuffer] = await Promise.all([
    fetchIndexFile(baseUrl, "ids", requestId, onFileProgress),
    fetchIndexFile(baseUrl, "vectors", requestId, onFileProgress),
    fetchIndexFile(baseUrl, "norms", requestId, onFileProgress),
  ]);
  ids = JSON.parse(new TextDecoder().decode(idsBuffer));
  vectors = new Int8Array(vectorBuffer);
  norms = decodeFloat32LittleEndian(normBuffer);
  validateSemanticIndexFiles(metadata, ids, vectors, norms);
  centroid = computeInt8Centroid(vectors, norms, metadata.dimensions);
  progress(requestId, "index", 1, "Catalogue index ready", { loaded: totalIndexBytes, total: totalIndexBytes });
}

async function search(queryInput) {
  if (!extractor || !metadata || !ids || !vectors || !norms || !centroid) {
    throw new Error("Semantic search is not loaded.");
  }
  const query = String(queryInput ?? "").trim();
  if (!query) throw new Error("Enter an English capability request.");
  const startedAt = performance.now();
  const tensor = await extractor(`${metadata.model.queryPrefix ?? ""}${query}`, {
    pooling: metadata.model.pooling,
    normalize: metadata.model.normalize,
  });
  const queryVector = Float32Array.from(tensor.data);
  const ranked = searchInt8Index(vectors, norms, metadata.dimensions, queryVector, 100);
  const confidence = describeConfidence(ranked, queryVector, centroid);
  return {
    decision: { action: confidence.action, reason: confidence.reason },
    confidence,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    candidates: confidence.action === "search"
      ? ranked.map((candidate) => ({ id: ids[candidate.row], score: candidate.score }))
      : [],
  };
}

async function loadTransformers() {
  transformersPromise ??= import(TRANSFORMERS_MODULE_URL);
  return transformersPromise;
}

async function fetchIndexFile(baseUrl, name, requestId, onProgress) {
  const descriptor = metadata.files[name];
  const buffer = await fetchArrayBuffer(new URL(descriptor.path, baseUrl), (loaded) => onProgress(name, loaded));
  if (buffer.byteLength !== descriptor.bytes) throw new Error(`Semantic index ${name} size does not match metadata.`);
  const digest = await sha256Hex(buffer);
  if (digest !== descriptor.sha256) throw new Error(`Semantic index ${name} checksum does not match metadata.`);
  progress(requestId, "index-file", 1, `${name} verified`);
  return buffer;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load semantic index metadata (HTTP ${response.status}).`);
  return response.json();
}

async function fetchArrayBuffer(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url.pathname.split("/").pop()} (HTTP ${response.status}).`);
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }
  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function progress(id, stage, fraction, message, bytes = {}) {
  self.postMessage({ id, type: "progress", payload: { stage, fraction: clamp(fraction), message, ...bytes } });
}

function respond(id, type, payload) {
  self.postMessage({ id, type, payload });
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
