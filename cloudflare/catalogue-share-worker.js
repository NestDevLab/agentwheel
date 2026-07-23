const CATALOGUE_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-data.json";
const CATALOGUE_PAGE_URL = "https://www.nestdev.it/agentwheel/catalogue.html";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character]);
}

function detailUrl(resourceId) {
  const url = new URL(CATALOGUE_PAGE_URL);
  url.searchParams.set("resource", resourceId);
  return url.href;
}

async function catalogueEntry(resourceId) {
  const response = await fetch(CATALOGUE_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new Error(`Catalogue data returned ${response.status}`);
  const data = await response.json();
  return (data.entries || []).find((entry) => entry.id === resourceId) || null;
}

function sharePage(entry, resourceId, shareUrl) {
  const destination = detailUrl(resourceId);
  const title = `${entry.name} - Catalogue - agentwheel`;
  const description = entry.description || "Browse this agentwheel catalogue resource.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(shareUrl)}"><meta name="twitter:card" content="summary"><link rel="canonical" href="${escapeHtml(shareUrl)}"><script>location.replace(${JSON.stringify(destination)})</script></head><body><p>Opening <a href="${escapeHtml(destination)}">${escapeHtml(entry.name)}</a>…</p></body></html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const resourceId = decodeURIComponent(url.pathname.slice("/agentwheel/share/".length));
    if (!resourceId || url.pathname === "/agentwheel/share/") return new Response("Not found", { status: 404 });

    try {
      const entry = await catalogueEntry(resourceId);
      if (!entry) return Response.redirect(detailUrl(resourceId), 302);
      return new Response(sharePage(entry, resourceId, url.href), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    } catch (error) {
      return new Response("Catalogue share preview is temporarily unavailable.", { status: 503 });
    }
  },
};
