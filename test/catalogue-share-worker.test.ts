import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = (await import(pathToFileURL(join(root, "cloudflare/catalogue-share-worker.js")).href)).default;
const { buildCatalogueAssets } = await import(pathToFileURL(join(root, "cloudflare/build-catalogue-assets.mjs")).href);
const { metadataAssetPath, MAX_SHARD_BYTES, MAX_TEMPLATE_BYTES, SHARD_COUNT, TEMPLATE_PATH } = await import(pathToFileURL(join(root, "cloudflare/catalogue-assets.js")).href);
const template = await readFile(join(root, "docs/catalogue.html"), "utf8");

function fixture(entries = [{ id: "example:tool", name: "Example tool", description: "A useful tool" }], vercel = [{ o: "example", r: "tools", s: "helper", d: "Helper skill" }]) {
  const assets: Map<string, string> = buildCatalogueAssets({ entries }, { entries: vercel }, template);
  const fetch = vi.fn(async (request: Request) => {
    const body = assets.get(new URL(request.url).pathname);
    return new Response(body ?? "missing", { status: body === undefined ? 404 : 200 });
  });
  return { assets, env: { ASSETS: { fetch } }, fetch };
}

function request(id: string, prefix = "catalogue") {
  return new Request(`https://www.example.com/agentwheel/${prefix}/${encodeURIComponent(id)}?ignored=1`);
}

afterEach(() => vi.unstubAllGlobals());

describe("catalogue preview Worker", () => {
  it("renders native and Vercel previews from bounded assets, even on the first request", async () => {
    const externalFetch = vi.fn(() => { throw new Error("No request-time origin fetch allowed"); });
    vi.stubGlobal("fetch", externalFetch);
    const { env, fetch } = fixture();
    for (const [id, name] of [["example:tool", "Example tool"], ["vercel:example/tools/helper", "helper"]]) {
      const response = await worker.fetch(request(id), env);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`<title>${name} - Catalogue - agentwheel</title>`);
      expect(html).toContain('property="og:description"');
      expect(html).toContain('href="/agentwheel/"');
      expect(html).toContain(`params.set("resource", ${JSON.stringify(id)})`);
      expect(html).toContain("agentwheelPrettyDetailUrl");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    }
    expect(externalFetch).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([req]) => new URL(req.url).pathname)).toEqual([
      metadataAssetPath("example:tool"), TEMPLATE_PATH,
      metadataAssetPath("vercel:example/tools/helper"), TEMPLATE_PATH,
    ]);
  });

  it("redirects share links without fetching or rewriting the HTML template", async () => {
    const { env, fetch } = fixture();
    const response = await worker.fetch(request("example:tool", "share"), env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://www.example.com/agentwheel/catalogue/example%3Atool");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for absent, malformed, oversized and prototype-property resource ids", async () => {
    const { env, fetch } = fixture();
    for (const id of ["missing", "__proto__", "constructor", "vercel:example/tools/helper/extra"]) {
      expect((await worker.fetch(request(id), env)).status).toBe(404);
    }
    fetch.mockClear();
    for (const url of ["https://www.example.com/other", "https://www.example.com/agentwheel/catalogue/%zz", request("x".repeat(2049)).url]) {
      expect((await worker.fetch(new Request(url), env)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on missing assets without falling back to full catalogue parsing", async () => {
    const externalFetch = vi.fn();
    vi.stubGlobal("fetch", externalFetch);
    const { env, assets } = fixture();
    assets.delete(TEMPLATE_PATH);
    expect((await worker.fetch(request("example:tool"), env)).status).toBe(503);
    assets.clear();
    expect((await worker.fetch(request("example:tool"), env)).status).toBe(503);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("escapes preview metadata and script bootstrap ids", async () => {
    const id = "example:</script><script>alert(1)</script>";
    const { env } = fixture([{ id, name: '<unsafe & "title">', description: "<unsafe description>" }], []);
    const html = await (await worker.fetch(request(id), env)).text();
    expect(html).toContain("&lt;unsafe &amp; &quot;title&quot;&gt;");
    expect(html).toContain("&lt;unsafe description&gt;");
    expect(html).not.toContain('params.set("resource", "example:</script>');
    expect(html).toContain('params.set("resource", "example:\\u003c/script>');
  });
});

describe("catalogue preview asset build", () => {
  it("strips full entries and keeps request payloads bounded as the catalogue grows", () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => ({
      id: `example:resource-${i}`, name: `Resource ${i}`, description: "Useful metadata",
      readmeExcerpt: "unused rich catalogue data".repeat(40),
    }));
    const { assets } = fixture(entries, []);
    expect(assets.size).toBe(SHARD_COUNT + 1);
    for (const [path, body] of assets) {
      if (path === TEMPLATE_PATH) continue;
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_SHARD_BYTES);
      expect(body).not.toContain("readmeExcerpt");
    }
    const id = entries.at(-1)!.id;
    expect(JSON.parse(assets.get(metadataAssetPath(id))!)[id]).toEqual({ id, name: "Resource 19999", description: "Useful metadata" });
  });

  it("rejects skewed oversized shards rather than shipping unbounded cold-start work", () => {
    const entries: { id: string; name: string; description: string }[] = [];
    for (let i = 0; entries.length < 180; i += 1) {
      const id = `example:collision-${i}`;
      if (metadataAssetPath(id).endsWith("/000.json")) entries.push({ id, name: "N".repeat(200), description: "D".repeat(512) });
    }
    expect(() => fixture(entries, [])).toThrow("exceeds 65536 bytes");
  });

  it("preserves first-match semantics and gives Vercel ids their dedicated index metadata", async () => {
    const { env } = fixture([
      { id: "example:tool", name: "First", description: "First match" },
      { id: "example:tool", name: "Second", description: "Second match" },
      { id: "vercel:example/tools/helper", name: "Full catalogue copy", description: "Wrong source" },
    ]);
    expect(await (await worker.fetch(request("example:tool"), env)).text()).toContain("First - Catalogue");
    const html = await (await worker.fetch(request("vercel:example/tools/helper"), env)).text();
    expect(html).toContain("Helper skill");
    expect(html).not.toContain("Wrong source");
  });

  it("rejects malformed sources and oversized templates", () => {
    expect(() => buildCatalogueAssets({}, { entries: [] }, template)).toThrow("entries array");
    expect(() => buildCatalogueAssets({ entries: [] }, { entries: [{ o: "x" }] }, template)).toThrow("Invalid Vercel");
    expect(() => buildCatalogueAssets({ entries: [] }, { entries: [] }, "x".repeat(MAX_TEMPLATE_BYTES + 1))).toThrow("template CPU budget");
  });
});
