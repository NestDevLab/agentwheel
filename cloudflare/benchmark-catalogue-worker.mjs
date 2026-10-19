import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import worker from "./catalogue-share-worker.js";
import { buildCatalogueAssets, readCatalogueSources, CATALOGUE_URL, VERCEL_INDEX_URL } from "./build-catalogue-assets.mjs";
import { TEMPLATE_PATH } from "./catalogue-assets.js";

const { values } = parseArgs({ options: {
  "baseline-ref": { type: "string", default: "432bbbb2c612641c2b7517a3e439c1c7bf07d704" },
  catalogue: { type: "string" }, "vercel-index": { type: "string" },
} });
const root = dirname(fileURLToPath(import.meta.url));
const [catalogue, vercel] = await readCatalogueSources(values.catalogue, values["vercel-index"]);
const template = await readFile(join(root, "../docs/catalogue.html"), "utf8");
// A fresh import of the baseline source; no deployment or remote development session.
const source = execFileSync("git", ["show", `${values["baseline-ref"]}:cloudflare/catalogue-share-worker.js`], { cwd: root, encoding: "utf8" });
const baseline = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
const bodies = new Map([
  [CATALOGUE_URL, Buffer.from(JSON.stringify(catalogue))],
  [VERCEL_INDEX_URL, Buffer.from(JSON.stringify(vercel))],
  ["https://raw.githubusercontent.com/NestDevLab/agentwheel/main/docs/catalogue.html", Buffer.from(template)],
]);
const assets = new Map([...buildCatalogueAssets(catalogue, vercel, template)].map(([path, body]) => [path, Buffer.from(body)]));
const env = { ASSETS: { fetch: async (request) => {
  const body = assets.get(new URL(request.url).pathname);
  if (!body) throw new Error("Unexpected asset request");
  return new Response(body);
} } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const body = bodies.get(String(url));
  if (!body) throw new Error(`Unexpected benchmark origin: ${url}`);
  return new Response(body);
};

async function measure(handler, id, route) {
  const times = [];
  let first;
  for (let i = 0; i < 40; i += 1) {
    const request = new Request(`https://www.example.com/agentwheel/${route}/${encodeURIComponent(id)}`);
    const start = process.cpuUsage();
    const response = await handler.fetch(request, env);
    await response.arrayBuffer();
    if (response.status !== (route === "share" ? 302 : 200)) throw new Error(`Unexpected response: ${response.status}`);
    const used = process.cpuUsage(start);
    const ms = (used.user + used.system) / 1000;
    if (i === 0) first = ms;
    if (i >= 10) times.push(ms);
  }
  times.sort((a, b) => a - b);
  return { first_ms: first, median_ms: times[15], p95_ms: times[28] };
}

try {
  console.log(JSON.stringify({ runtime: process.version, baseline: values["baseline-ref"], entries: catalogue.entries.length, vercel_entries: vercel.entries.length,
    catalogue_bytes: bodies.get(CATALOGUE_URL).length, vercel_bytes: bodies.get(VERCEL_INDEX_URL).length,
    max_shard_bytes: Math.max(...[...assets].filter(([path]) => path !== TEMPLATE_PATH).map(([, body]) => body.length)) }));
  // Last entries exercise the baseline's longest linear lookup; the new lookup is bounded.
  const last = vercel.entries.at(-1);
  for (const [kind, id] of [["catalogue", catalogue.entries.at(-1).id], ["vercel", `vercel:${last.o}/${last.r}/${last.s}`]]) {
    for (const route of ["catalogue", "share"]) {
      console.log(JSON.stringify({ kind, route, before: await measure(baseline, id, route), after: await measure(worker, id, route) }));
    }
  }
  console.log("CPU is local Node process CPU with in-memory responses and no network latency. Each new invocation parses its asset again; no warm-isolate cache is required. Cloudflare CPU must be verified separately after an approved deployment.");
} finally { globalThis.fetch = originalFetch; }
