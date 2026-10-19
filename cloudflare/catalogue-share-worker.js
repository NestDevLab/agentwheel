import { TEMPLATE_PATH, metadataAssetPath } from "./catalogue-assets.js";
const PRETTY_PATH_PREFIX = "/agentwheel/catalogue/";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character]);
}

async function catalogueEntry(resourceId, env) {
  const response = await env.ASSETS.fetch(new Request(`https://catalogue-assets.invalid${metadataAssetPath(resourceId)}`));
  if (!response.ok) throw new Error(`Catalogue metadata asset returned ${response.status}`);
  const entries = await response.json();
  return Object.hasOwn(entries, resourceId) ? entries[resourceId] : null;
}

function prettyUrl(requestUrl, resourceId) {
  const url = new URL(requestUrl);
  url.pathname = `${PRETTY_PATH_PREFIX}${encodeURIComponent(resourceId)}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function prettyPage(entry, requestUrl, env) {
  const response = await env.ASSETS.fetch(new Request(`https://catalogue-assets.invalid${TEMPLATE_PATH}`));
  if (!response.ok) throw new Error(`Catalogue page returned ${response.status}`);

  const canonicalUrl = prettyUrl(requestUrl, entry.id);
  const title = `${entry.name} - Catalogue - agentwheel`;
  const description = entry.description || "Browse this agentwheel catalogue resource.";
  const metadata = `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonicalUrl)}"><meta name="twitter:card" content="summary"><link rel="canonical" href="${escapeHtml(canonicalUrl)}">`;
  const pathBootstrap = `const params = new URLSearchParams(location.search);\n    if (location.pathname.startsWith(${JSON.stringify(PRETTY_PATH_PREFIX)})) params.set("resource", ${JSON.stringify(entry.id).replace(/</g, "\\u003c")});`;
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const prettyResourceId = resourceIdFromPath(url.pathname, PRETTY_PATH_PREFIX);
    const sharedResourceId = resourceIdFromPath(url.pathname, "/agentwheel/share/");
    const resourceId = prettyResourceId || sharedResourceId;
    if (!resourceId || resourceId.length > 2048) return new Response("Not found", { status: 404 });

    try {
      const entry = await catalogueEntry(resourceId, env);
      if (!entry) return new Response("Not found", { status: 404 });
      if (sharedResourceId) return Response.redirect(prettyUrl(url.href, resourceId), 302);
      return await prettyPage(entry, url.href, env);
    } catch (error) {
      return new Response("Catalogue share preview is temporarily unavailable.", { status: 503 });
    }
  },
};
