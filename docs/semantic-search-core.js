export const SEMANTIC_INDEX_CONTRACT = Object.freeze({
  schemaVersion: 1,
  textSchemaVersion: 1,
  model: Object.freeze({
    id: "Xenova/gte-small",
    revision: "5927d1727bb12db490052a1b33265ad78058de08",
    dimensions: 384,
    dtype: "q8",
    pooling: "mean",
    normalize: true,
    queryPrefix: "",
    documentPrefix: "",
  }),
  vectorFormat: "signed-int8-per-vector-scaled",
  normFormat: "float32-little-endian",
  confidenceThreshold: 0.0725,
});

const EXACT_NON_DISCOVERY = new Set([
  "yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure",
  "continue", "go ahead", "proceed", "stop", "cancel", "wait", "please wait", "hold on",
  "hello", "hi", "hey", "good morning", "good afternoon", "good evening", "good night",
  "bye", "goodbye", "thanks", "thank you", "tell me something interesting",
]);

const NON_DISCOVERY_PATTERNS = [
  /^(?:thanks|thank you)(?: (?:that|this|it) (?:helped|worked|solved it|fixed it))?$/u,
  /^(?:i agree(?: with (?:that|this)(?: plan)?)?|sounds good|that works for me)$/u,
  /^(?:what did i ask before|what were we (?:talking|speaking) about|repeat my last (?:question|message))$/u,
  /^(?:what is|calculate|compute) (?:-?\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten) (?:plus|minus|times|multiplied by|divided by) (?:-?\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)$/u,
];

const SELF_LEARNING_CONTEXT = "Self-improving agent that automatically learns from experience, feedback, corrections, conversations, and completed work. Capture learnings as memory, rules, or reusable skills.";
const SELF_LEARNING_NAME = /\bself (?:improve|improving|improvement|learn|learning)\b/u;
const SELF_LEARNING_DESCRIPTION = /\b(?:self improving|self improvement|self learning|learns? from|learning from|extract a learned skill|continuously evolve|automatic skill evolution)\b/u;
const COMPANION_SKILL_ADAPTERS = new Set(["codex", "claude", "openclaw", "hermes", "copilot"]);

export function classifyDiscoveryIntent(queryInput) {
  const query = normalizeEnglish(queryInput);
  if (EXACT_NON_DISCOVERY.has(query) || NON_DISCOVERY_PATTERNS.some((pattern) => pattern.test(query))) {
    return { action: "abstain", reason: "clearly-conversational" };
  }
  return { action: "search", reason: "discovery-candidate" };
}

export function prepareSemanticQuery(queryInput) {
  const query = String(queryInput ?? "").trim();
  const normalized = normalizeEnglish(query);
  const explicitIntent = SELF_LEARNING_NAME.test(normalized);
  const agentSubject = /\b(?:agent|assistant|ai)\b/u.test(normalized);
  const learningAction = /\b(?:learn|learns|learning|improve|improves|improving|evolve|evolves|evolving|adapt|adapts|adapting)\b/u.test(normalized);
  const autonomousContext = /\b(?:self|itself|own|automatic|automatically|autonomous|continuously|continuous|while|chat|chatting|conversation|feedback|correction|corrections|experience|experiences)\b/u.test(normalized);
  if (!explicitIntent && !(agentSubject && learningAction && autonomousContext)) {
    return { intent: null, embeddingText: query };
  }
  return {
    intent: "self-learning-agent",
    embeddingText: `${query}. ${SELF_LEARNING_CONTEXT}`,
  };
}

export function rerankSemanticCandidates(candidates, entries, intent) {
  if (intent !== "self-learning-agent") return candidates;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      rankingScore: candidate.score + selfLearningBoost(byId.get(candidate.id)),
    }))
    .sort((first, second) => second.rankingScore - first.rankingScore || first.index - second.index)
    .map(({ candidate }) => candidate);
}

export function validateSemanticIndexMetadata(metadata, catalogueDigests, contract = SEMANTIC_INDEX_CONTRACT) {
  if (metadata?.schemaVersion !== contract.schemaVersion) throw new Error("Unsupported semantic index schema.");
  if (metadata.textSchemaVersion !== contract.textSchemaVersion) throw new Error("Unsupported semantic text schema.");
  if (!Number.isInteger(metadata.count) || metadata.count < 1) throw new Error("Semantic index count is invalid.");
  if (metadata.dimensions !== contract.model.dimensions) throw new Error("Semantic index dimensions do not match the model.");
  if (metadata.vectorFormat !== contract.vectorFormat || metadata.normFormat !== contract.normFormat) {
    throw new Error("Semantic index binary format is unsupported.");
  }

  for (const field of ["id", "revision", "dimensions", "dtype", "pooling", "normalize"]) {
    if (metadata.model?.[field] !== contract.model[field]) throw new Error(`Semantic model ${field} does not match.`);
  }
  for (const field of ["queryPrefix", "documentPrefix"]) {
    if ((metadata.model?.[field] ?? "") !== contract.model[field]) {
      throw new Error(`Semantic model ${field} does not match.`);
    }
  }

  for (const source of ["enriched", "vercel"]) {
    const expected = catalogueDigests?.[source];
    if (!expected || metadata.catalogue?.[source]?.sha256 !== expected) {
      throw new Error(`Semantic index catalogue checksum does not match ${source}.`);
    }
  }

  for (const file of ["ids", "vectors", "norms"]) {
    const descriptor = metadata.files?.[file];
    if (!descriptor || typeof descriptor.path !== "string" || !Number.isInteger(descriptor.bytes)
      || descriptor.bytes < 1 || !/^[a-f\d]{64}$/u.test(descriptor.sha256)) {
      throw new Error(`Semantic index ${file} descriptor is invalid.`);
    }
  }
  return metadata;
}

export function decodeFloat32LittleEndian(buffer) {
  if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Semantic norm file has an invalid length.");
  }
  const view = new DataView(buffer);
  const result = new Float32Array(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return result;
}

export function validateSemanticIndexFiles(metadata, ids, vectors, norms) {
  if (!Array.isArray(ids) || ids.length !== metadata.count || ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Semantic index IDs do not match metadata.");
  }
  if (!(vectors instanceof Int8Array) || vectors.length !== metadata.count * metadata.dimensions) {
    throw new Error("Semantic vector file does not match metadata.");
  }
  if (!(norms instanceof Float32Array) || norms.length !== metadata.count) {
    throw new Error("Semantic norm file does not match metadata.");
  }
}

export function computeInt8Centroid(vectors, norms, dimensions) {
  const count = norms.length;
  const centroid = new Float32Array(dimensions);
  for (let row = 0; row < count; row += 1) {
    const norm = norms[row];
    if (!(norm > 0)) continue;
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column += 1) {
      centroid[column] += vectors[offset + column] / norm;
    }
  }
  if (count > 0) {
    for (let column = 0; column < dimensions; column += 1) centroid[column] /= count;
  }
  return centroid;
}

export function searchInt8Index(vectors, norms, dimensions, query, limit = 100) {
  if (query.length !== dimensions) throw new Error("Query vector dimensions do not match the index.");
  const results = [];
  for (let row = 0; row < norms.length; row += 1) {
    const offset = row * dimensions;
    let dot = 0;
    for (let column = 0; column < dimensions; column += 1) dot += vectors[offset + column] * query[column];
    const score = norms[row] > 0 ? dot / norms[row] : 0;
    insertTop(results, { row, score }, limit);
  }
  return results;
}

export function describeConfidence(results, query, centroid, threshold = SEMANTIC_INDEX_CONTRACT.confidenceThreshold) {
  if (!results.length) return { action: "abstain", reason: "empty-index", topCenteredScore: null, threshold };
  let backgroundSimilarity = 0;
  for (let index = 0; index < query.length; index += 1) backgroundSimilarity += query[index] * centroid[index];
  const topCenteredScore = results[0].score - backgroundSimilarity;
  return {
    action: topCenteredScore >= threshold ? "search" : "abstain",
    reason: topCenteredScore >= threshold ? "confidence-passed" : "low-centered-confidence",
    backgroundSimilarity: round(backgroundSimilarity, 6),
    topSemanticScore: round(results[0].score, 6),
    topCenteredScore: round(topCenteredScore, 6),
    threshold,
  };
}

export function groupSemanticResults(candidates, entries, limit = 3) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const groups = [];
  const groupByName = new Map();
  for (const candidate of candidates) {
    const entry = byId.get(candidate.id);
    if (!entry) continue;
    const key = normalizeEnglish(entry.name);
    let group = groupByName.get(key);
    if (!group) {
      group = { entry, score: candidate.score, alternates: [] };
      groupByName.set(key, group);
      groups.push(group);
    } else {
      group.alternates.push(entry);
    }
  }
  return groups.slice(0, limit);
}

export function companionSkillSetupCommand(adapterInput) {
  const adapter = String(adapterInput ?? "").trim().toLowerCase();
  if (!COMPANION_SKILL_ADAPTERS.has(adapter)) throw new Error("Unsupported Agentwheel adapter.");
  return [
    "npm i -g agentwheel",
    `agentwheel install github:NestDevLab/agentwheel --adapter ${adapter} --user --skill agentwheel`,
  ].join("\n");
}

export function normalizeEnglish(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function insertTop(results, candidate, limit) {
  let index = results.findIndex((item) => candidate.score > item.score);
  if (index === -1) index = results.length;
  results.splice(index, 0, candidate);
  if (results.length > limit) results.pop();
}

function selfLearningBoost(entry) {
  if (!entry) return 0;
  const name = normalizeEnglish(entry.name);
  const description = normalizeEnglish(entry.description);
  let boost = 0;
  if (SELF_LEARNING_NAME.test(name)) boost += 0.06;
  else if (/\b(?:learner|reflection)\b/u.test(name)) boost += 0.025;
  if (SELF_LEARNING_DESCRIPTION.test(description)) boost += 0.025;
  if (boost > 0 && entry.ecosystem === "official") boost += 0.01;
  return boost;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
