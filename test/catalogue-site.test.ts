import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("catalogue site", () => {
  it("exposes pretty, shareable detail pages and source links", async () => {
    const html = await readFile(join(repoRoot, "docs", "catalogue.html"), "utf8");

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
  });
});
