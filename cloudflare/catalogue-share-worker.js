const CATALOGUE_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-data.json";
const VERCEL_INDEX_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-vercel-index.json";
const CATALOGUE_ORIGIN_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel/main/docs/catalogue.html";
const PRETTY_PATH_PREFIX = "/agentwheel/catalogue/";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character]);
}

async function catalogueEntry(resourceId) {
  if (resourceId.startsWith("vercel:")) {
    const [owner, repo, skill] = resourceId.slice("vercel:".length).split("/");
    if (!owner || !repo || !skill) return null;
    const response = await fetch(VERCEL_INDEX_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!response.ok) throw new Error(`Vercel index returned ${response.status}`);
    const data = await response.json();
    const record = (data.entries || []).find((candidate) => candidate.o === owner && candidate.r === repo && candidate.s === skill);
    return record ? { id: resourceId, name: record.s, description: record.d || "Browse this agentwheel catalogue resource." } : null;
  }

  const response = await fetch(CATALOGUE_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new Error(`Catalogue data returned ${response.status}`);
  const data = await response.json();
  return (data.entries || []).find((entry) => entry.id === resourceId) || null;
}

function prettyUrl(requestUrl, resourceId) {
  const url = new URL(requestUrl);
  url.pathname = `${PRETTY_PATH_PREFIX}${encodeURIComponent(resourceId)}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function prettyPage(entry, requestUrl) {
  const response = await fetch(CATALOGUE_ORIGIN_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`Catalogue page returned ${response.status}`);

  const canonicalUrl = prettyUrl(requestUrl, entry.id);
  const title = `${entry.name} - Catalogue - agentwheel`;
  const description = entry.description || "Browse this agentwheel catalogue resource.";
  const metadata = `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonicalUrl)}"><meta name="twitter:card" content="summary"><link rel="canonical" href="${escapeHtml(canonicalUrl)}">`;
  const pathBootstrap = `const params = new URLSearchParams(location.search);\n    if (location.pathname.startsWith(${JSON.stringify(PRETTY_PATH_PREFIX)})) params.set("resource", ${JSON.stringify(entry.id)});`;
  const clientPatch = `<script>\n    const agentwheelPrettyDetailUrl = (entry) => new URL(${JSON.stringify(PRETTY_PATH_PREFIX)} + encodeURIComponent(entry.id), location.origin).href;\n    window.detailUrl = agentwheelPrettyDetailUrl;\n    window.shareUrl = agentwheelPrettyDetailUrl;\n    window.catalogueUrl = () => new URL("/agentwheel/catalogue.html", location.origin).href;\n  </script>`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  const html = (await response.text())
    .replace(/<meta property="og:(title|description|url)"[^>]*>/gi, "")
    .replace(/<meta name="twitter:card"[^>]*>/gi, "")
    .replace(/<link rel="canonical"[^>]*>/gi, "")
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${escapeHtml(description)}">`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>${metadata}`)
    .replace("<head>", '<head><base href="/agentwheel/">')
    .replace(/const params = new URLSearchParams\(location\.search\);/, pathBootstrap)
    .replace("</body>", `${clientPatch}</body>`);

  return new Response(html, { status: response.status, headers });
}

function resourceIdFromPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return "";
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const prettyResourceId = resourceIdFromPath(url.pathname, PRETTY_PATH_PREFIX);
    const sharedResourceId = resourceIdFromPath(url.pathname, "/agentwheel/share/");
    const resourceId = prettyResourceId || sharedResourceId;
    if (!resourceId) return new Response("Not found", { status: 404 });

    try {
      const entry = await catalogueEntry(resourceId);
      if (!entry) return new Response("Not found", { status: 404 });
      if (sharedResourceId) return Response.redirect(prettyUrl(url.href, resourceId), 302);
      return await prettyPage(entry, url.href);
    } catch (error) {
      return new Response("Catalogue share preview is temporarily unavailable.", { status: 503 });
    }
  },
};
