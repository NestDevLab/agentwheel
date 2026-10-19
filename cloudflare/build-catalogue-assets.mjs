import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_SHARD_BYTES, MAX_TEMPLATE_BYTES, SHARD_COUNT, TEMPLATE_PATH, metadataAssetPath } from "./catalogue-assets.js";

export const CATALOGUE_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-data.json";
export const VERCEL_INDEX_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-vercel-index.json";
const root = dirname(fileURLToPath(import.meta.url));

export function buildCatalogueAssets(catalogue, vercelIndex, template) {
  if (!Array.isArray(catalogue.entries) || !Array.isArray(vercelIndex.entries)) {
    throw new Error("Both catalogue sources must contain an entries array");
  }
  if (Buffer.byteLength(template) > MAX_TEMPLATE_BYTES) throw new Error("Catalogue HTML exceeds the template CPU budget");
  const shards = Array.from({ length: SHARD_COUNT }, () => Object.create(null));
  function add(id, name, description) {
    if (typeof id !== "string" || !id || id.length > 2048 || typeof name !== "string") {
      throw new Error("Invalid catalogue preview metadata");
    }
    const index = Number.parseInt(metadataAssetPath(id).split("/").at(-1), 16);
    // Match the old Array.find behavior when a source repeats a resource.
    if (Object.hasOwn(shards[index], id)) return;
    shards[index][id] = {
      id,
      name: name.slice(0, 200),
      description: String(description || "Browse this agentwheel catalogue resource.").slice(0, 512),
    };
  }
  for (const entry of catalogue.entries) {
    // The full catalogue can also include Vercel records. The old Worker always
    // resolved these ids from the dedicated Vercel index instead.
    if (typeof entry.id === "string" && entry.id.startsWith("vercel:")) continue;
    add(entry.id, entry.name, entry.description);
  }
  for (const entry of vercelIndex.entries) {
    if (![entry.o, entry.r, entry.s].every((value) => typeof value === "string" && value)) {
      throw new Error("Invalid Vercel catalogue entry");
    }
    add(`vercel:${entry.o}/${entry.r}/${entry.s}`, entry.s, entry.d);
  }
  const assets = new Map([[TEMPLATE_PATH, template]]);
  for (let i = 0; i < SHARD_COUNT; i += 1) {
    const body = JSON.stringify(shards[i]);
    if (Buffer.byteLength(body) > MAX_SHARD_BYTES) {
      throw new Error(`Metadata shard ${i} exceeds ${MAX_SHARD_BYTES} bytes; increase SHARD_COUNT before deploying`);
    }
    assets.set(`/__catalogue/metadata/${i.toString(16).padStart(3, "0")}.json`, body);
  }
  return assets;
}

export async function readCatalogueSources(cataloguePath, vercelPath) {
  async function read(path, url) {
    if (path) return JSON.parse(await readFile(path, "utf8"));
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Catalogue build source returned ${response.status}: ${url}`);
    return response.json();
  }
  return Promise.all([read(cataloguePath, CATALOGUE_URL), read(vercelPath, VERCEL_INDEX_URL)]);
}

async function main() {
  // Optional fixture paths make the same build reproducible offline.
  const [catalogue, vercel] = await readCatalogueSources(...process.argv.slice(2));
  const assets = buildCatalogueAssets(catalogue, vercel, await readFile(join(root, "../docs/catalogue.html"), "utf8"));
  const output = join(root, ".catalogue-assets");
  // Validate all size budgets before replacing any generated assets.
  await rm(output, { recursive: true, force: true });
  for (const [path, body] of assets) {
    const file = join(output, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  console.log(`Built ${assets.size} catalogue assets; largest metadata shard: ${Math.max(...[...assets].filter(([path]) => path.endsWith(".json")).map(([, body]) => Buffer.byteLength(body)))} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
