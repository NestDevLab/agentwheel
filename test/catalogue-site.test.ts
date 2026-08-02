import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("catalogue site", () => {
  it("exposes pretty, shareable detail pages and source links", async () => {
    const html = await readFile(join(repoRoot, "docs", "catalogue.html"), "utf8");
    const worker = await readFile(join(repoRoot, "cloudflare", "catalogue-share-worker.js"), "utf8");

    expect(html).toContain('id="resource-detail"');
    expect(html).toContain('params.get("resource")');
    expect(html).toContain('url.pathname = `/agentwheel/catalogue/${encodeURIComponent(entry.id)}`');
    expect(html).toContain("Skill source");
    expect(html).toContain("Details");
    expect(html).toContain("Selected artifacts");
    expect(html).toContain("Suggested skills");
    expect(html).toContain("Dependencies");
    expect(html).toContain("artifactMetadata");
    expect(html).toContain("suggestedSkills");
    expect(html).toContain("readmeExcerpt");
    expect(html).toContain("renderReadme");
    expect(html).toContain('document.body.classList.toggle("detail-mode"');
    expect(html).toContain("Back to catalogue");
    expect(html).toContain("Related skills");
    expect(html).toContain("relatedSkillEntries");
    expect(html).toContain("relatedOnly");
    expect(html).toContain("titleLink.href = cardHref(entry)");
    expect(html).toContain('params.get("q")');
    expect(html).toContain('property="og:title"');
    expect(html).toContain("updateDocumentMetadata");
    expect(html).toContain("entry.provides.filter(Boolean).map((type) => `${type}/`)");
    expect(html).toContain("function shareUrl(entry)");
    expect(html).toContain("function detailResourceIdFromLocation()");
    expect(html).toContain('const prefix = "/agentwheel/catalogue/"');
    expect(html).toContain('url.pathname = `/agentwheel/catalogue/${encodeURIComponent(entry.id)}`');
    expect(html).toContain("function shareResource(entry, button)");
    expect(html).toContain("Share or copy a social-preview link");
    expect(worker).toContain("catalogue-vercel-index.json");
    expect(worker).toContain('resourceId.startsWith("vercel:")');
    expect(worker).toContain("agentwheelPrettyDetailUrl");
  });

  it("offers an on-demand, browser-local semantic search demo", async () => {
    const [html, home, homeLoader, demo, semanticWorker, styles] = await Promise.all([
      readFile(join(repoRoot, "docs", "catalogue.html"), "utf8"),
      readFile(join(repoRoot, "docs", "index.html"), "utf8"),
      readFile(join(repoRoot, "docs", "semantic-catalogue-home.js"), "utf8"),
      readFile(join(repoRoot, "docs", "semantic-search-demo.js"), "utf8"),
      readFile(join(repoRoot, "docs", "semantic-search-worker.js"), "utf8"),
      readFile(join(repoRoot, "docs", "semantic-search-demo.css"), "utf8"),
    ]);

    expect(html).toContain('id="semantic-demo"');
    expect(html).toContain('id="semantic-progress"');
    expect(html).toContain("Runs locally · first search downloads about 50 MB");
    expect(html).toContain('src="./semantic-search-demo.js"');
    expect(html).toContain('href="./semantic-search-demo.css"');
    expect(html).toContain("window.agentwheelCatalogue = { ready: catalogueReady }");
    expect(home).toContain('id="semantic-demo"');
    expect(home).toContain('data-detail-page="./catalogue.html"');
    expect(home).toContain('src="./semantic-catalogue-home.js"');
    expect(home).toContain('href="./semantic-search-demo.css"');
    expect(homeLoader).toContain("cataloguePromise ??= loadCatalogue()");
    expect(homeLoader).toContain('await import("./semantic-search-demo.js")');
    expect(styles).toContain(".semantic-demo-home");
    expect(demo).toContain('new Worker(new URL("./semantic-search-worker.js"');
    expect(demo).toContain("classifyDiscoveryIntent(query)");
    expect(demo).toContain("rerankSemanticCandidates(response.candidates, catalogue.entries, preparedQuery.intent)");
    expect(demo).toContain("groupSemanticResults(candidates, catalogue.entries, MAX_RESULT_COUNT)");
    expect(demo).toContain("const MAX_RESULT_COUNT = 12");
    expect(demo).toContain("Show more matches");
    expect(styles).toContain(".semantic-more-button");
    expect(demo).toContain('pitch.textContent = "Like this search? Add it to your CLI and agent."');
    expect(demo).toContain('summary.textContent = "Show me how"');
    expect(demo).not.toContain('title.textContent = "Your agent with Agentwheel"');
    expect(demo).toContain("companionSkillSetupCommand(button.dataset.adapter)");
    expect(styles).toContain(".semantic-agent-bridge");
    expect(styles).toContain(".semantic-agent-pitch");
    expect(styles).toContain(".semantic-runtime-tabs");
    expect(demo).toContain('progressLabel.textContent = "Loading catalogue metadata"');
    expect(demo).toContain("const detailPage = demo?.dataset.detailPage");
    expect(semanticWorker).toContain("@huggingface/transformers@4.2.0");
    expect(semanticWorker).toContain('device: "wasm"');
    expect(semanticWorker).toContain("progress_callback");
    expect(semanticWorker).toContain("validateSemanticIndexMetadata");
  });
});
