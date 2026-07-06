import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const expectedHeaders = [
  "Adapter",
  "Instructions",
  "Rules",
  "Skills",
  "Commands",
  "Subagents",
  "MCP",
  "Hooks",
  "Settings",
  "Plugins",
  "Fragments",
];

const expectedMatrix = {
  OpenClaw: {
    Instructions: "md user",
    Rules: "no",
    Skills: "dir",
    Commands: "runtime",
    Subagents: "dir + json",
    MCP: "json",
    Hooks: "runtime",
    Settings: "json",
    Plugins: "dir",
    Fragments: "compose",
  },
  "Claude Code": {
    Instructions: "md",
    Rules: "md",
    Skills: "dir",
    Commands: "md",
    Subagents: "md",
    MCP: "json",
    Hooks: "json",
    Settings: "json",
    Plugins: "dir",
    Fragments: "compose",
  },
  "Codex CLI": {
    Instructions: "md",
    Rules: "no",
    Skills: "dir",
    Commands: "no",
    Subagents: "toml",
    MCP: "toml",
    Hooks: "json",
    Settings: "todo",
    Plugins: "dir",
    Fragments: "compose",
  },
  Hermes: {
    Instructions: "md",
    Rules: "no",
    Skills: "dir user",
    Commands: "runtime",
    Subagents: "yaml knobs",
    MCP: "yaml",
    Hooks: "runtime",
    Settings: "yaml",
    Plugins: "dir",
    Fragments: "compose",
  },
  "GitHub Copilot CLI": {
    Instructions: "md",
    Rules: "md",
    Skills: "dir",
    Commands: "md",
    Subagents: "md",
    MCP: "json",
    Hooks: "json",
    Settings: "json",
    Plugins: "dir",
    Fragments: "compose",
  },
} as const;

describe("site runtime matrix contract", () => {
  it("keeps the visible site matrix aligned with the approved contract", async () => {
    const html = await siteHtml();
    const { headers, rows } = parseRuntimeMatrix(html);

    expect(headers).toEqual(expectedHeaders);
    expect(rows).toEqual(expectedMatrix);
  });

  it("explains every matrix badge in the collapsible glossary", async () => {
    const html = await siteHtml();
    const tableHtml = extractRuntimeMatrixTable(html);
    const glossaryHtml = extractRequired(html, /<div class="glossary-items">([\s\S]*?)<\/div>/, "matrix glossary");
    const matrixBadges = extractBadgeLabels(tableHtml);
    const glossaryBadges = extractBadgeLabels(glossaryHtml);

    for (const badge of matrixBadges) {
      expect(glossaryBadges, `missing glossary entry for matrix badge '${badge}'`).toContain(badge);
    }

    const explanations = [...glossaryHtml.matchAll(/<small>([\s\S]*?)<\/small>/g)]
      .map((match) => normalizeText(match[1] ?? ""))
      .filter(Boolean);
    expect(explanations.length).toBeGreaterThanOrEqual(glossaryBadges.length);
    for (const explanation of explanations) {
      expect(explanation.length).toBeGreaterThan(24);
    }
  });
});

async function siteHtml(): Promise<string> {
  return readFile(new URL("../docs/index.html", import.meta.url), "utf8");
}

function parseRuntimeMatrix(html: string): {
  headers: string[];
  rows: Record<string, Record<string, string>>;
} {
  const tableHtml = extractRuntimeMatrixTable(html);
  const rowHtml = [...tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1] ?? "");
  if (rowHtml.length < 2) throw new Error("runtime matrix table has no body rows");

  const headers = extractCells(rowHtml[0]!);
  const rows: Record<string, Record<string, string>> = {};
  for (const row of rowHtml.slice(1)) {
    const cells = extractCells(row);
    const [adapter, ...values] = cells;
    if (!adapter) throw new Error(`runtime matrix row has no adapter cell: ${row}`);
    rows[adapter] = Object.fromEntries(headers.slice(1).map((header, index) => [header, values[index] ?? ""]));
  }

  return { headers, rows };
}

function extractRuntimeMatrixTable(html: string): string {
  const section = extractRequired(html, /<section id="adapters">([\s\S]*?)<\/section>/, "runtime matrix section");
  return extractRequired(section, /<table class="matrix">([\s\S]*?)<\/table>/, "runtime matrix table");
}

function extractCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
    .map((match) => normalizeText(match[1] ?? ""));
}

function extractBadgeLabels(html: string): string[] {
  return [...new Set([...html.matchAll(/<span class="badge [^"]+">([^<]+)<\/span>/g)]
    .map((match) => normalizeText(match[1] ?? "")))]
    .sort();
}

function extractRequired(html: string, pattern: RegExp, label: string): string {
  const match = html.match(pattern);
  if (!match?.[1]) throw new Error(`missing ${label}`);
  return match[1];
}

function normalizeText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
