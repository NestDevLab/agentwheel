const DEFAULT_DATA_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-data.json";
const DEFAULT_VERCEL_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-vercel-index.json";

let cataloguePromise;
window.agentwheelCatalogue = {
  load() {
    cataloguePromise ??= loadCatalogue();
    return cataloguePromise;
  },
};

await import("./semantic-search-demo.js");

async function loadCatalogue() {
  try {
    const [enriched, vercel] = await Promise.all([
      fetchCatalogue(sourceUrl("data", DEFAULT_DATA_URL)),
      fetchCatalogue(sourceUrl("vercel-data", DEFAULT_VERCEL_URL)),
    ]);
    return {
      entries: mergeEntries(enriched.data.entries, vercel.data.entries),
      digests: {
        enriched: await sha256Hex(enriched.bytes),
        vercel: await sha256Hex(vercel.bytes),
      },
    };
  } catch (error) {
    return {
      entries: [],
      digests: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchCatalogue(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load catalogue data (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  return {
    bytes,
    data: JSON.parse(new TextDecoder().decode(bytes)),
  };
}

function mergeEntries(enrichedEntries = [], vercelEntries = []) {
  const entries = new Map();
  for (const entry of enrichedEntries) {
    entries.set(entry.id, {
      id: entry.id,
      name: entry.name ?? "",
      description: entry.description ?? "",
      ecosystem: entry.ecosystem ?? "unknown",
    });
  }
  for (const entry of vercelEntries) {
    const id = `vercel:${entry.o}/${entry.r}/${entry.s}`;
    const existing = entries.get(id);
    if (existing) {
      if (!existing.description && entry.d) existing.description = entry.d;
      continue;
    }
    entries.set(id, {
      id,
      name: entry.s ?? "",
      description: entry.d ?? "",
      ecosystem: "vercel",
    });
  }
  return [...entries.values()];
}

function sourceUrl(parameter, fallback) {
  const value = new URLSearchParams(location.search).get(parameter);
  if (!value || /^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(value) || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin ? url.href : fallback;
  } catch {
    return fallback;
  }
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
