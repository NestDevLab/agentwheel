import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CatalogueClient,
  DEFAULT_ENRICHED_CATALOGUE_URL,
  DEFAULT_VERCEL_CATALOGUE_URL,
} from "../src/catalogue/client.js";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "dist", "index.js");
const tempRoots: string[] = [];

beforeAll(async () => {
  await ensureCliBuild(cli);
});

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("search CLI", () => {
  it("documents top-level search and removes nested registry search", async () => {
    const home = await tempRoot("agentwheel-search-home-");
    const topHelp = await runCli(["--help"], home);
    const searchHelp = await runCli(["search", "--help"], home);
    const registryHelp = await runCli(["registry", "--help"], home);

    expect(topHelp.stdout).toContain("search [options] <query>");
    expect(searchHelp.stdout).toContain("--scope <scope>");
    expect(searchHelp.stdout).toContain("--include-archived");
    expect(searchHelp.stdout).toContain("-t, --target-root <path>");
    expect(registryHelp.stdout).not.toContain("search <query>");
    await expect(runCli(["registry", "search", "browser"], home)).rejects.toMatchObject({ code: 1 });
  });

  it("searches a configured registry scope without contacting the public catalogue", async () => {
    const fixture = await registryFixture();
    const result = await runCli([
      "search",
      "terminal",
      "--scope",
      "registry",
      "--json",
      "--target-root",
      fixture.workspace,
    ], fixture.home);
    const response = JSON.parse(result.stdout);

    expect(result.stderr).toBe("");
    expect(response).toMatchObject({
      schemaVersion: 1,
      query: "terminal",
      scope: "registry",
      fromCache: false,
    });
    expect(response.results.map((entry: { name: string }) => entry.name)).toEqual(["registry-terminal"]);
  });

  it("searches cached enriched, Vercel, and combined scopes offline", async () => {
    const fixture = await registryFixture();
    await seedCatalogueCache(fixture.home);
    await runCli([
      "search",
      "terminal",
      "--scope",
      "registry",
      "--target-root",
      fixture.workspace,
    ], fixture.home);

    const enriched = JSON.parse((await runCli([
      "search",
      "browser",
      "--scope",
      "enriched",
      "--offline",
      "--json",
    ], fixture.home)).stdout);
    const vercel = JSON.parse((await runCli([
      "search",
      "browser",
      "--scope",
      "vercel",
      "--offline",
      "--json",
    ], fixture.home)).stdout);
    const all = JSON.parse((await runCli([
      "search",
      "browser",
      "--scope",
      "all",
      "--offline",
      "--json",
      "--target-root",
      fixture.workspace,
    ], fixture.home)).stdout);

    expect(enriched.fromCache).toBe(true);
    expect(enriched.results.map((entry: { id: string }) => entry.id)).toContain("official:demo-pack");
    expect(vercel.fromCache).toBe(true);
    expect(vercel.results.every((entry: { provenances: string[] }) => entry.provenances.includes("vercel"))).toBe(true);
    expect(all.fromCache).toBe(true);
    expect(all.results.some((entry: { installability: string }) => entry.installability === "registry")).toBe(true);
    expect(all.results.some((entry: { provenances: string[] }) => entry.provenances.includes("enriched"))).toBe(true);
    expect(all.results.some((entry: { provenances: string[] }) => entry.provenances.includes("vercel"))).toBe(true);
  });

  it("prints stable human results and treats no matches as success", async () => {
    const fixture = await registryFixture();
    const human = await runCli([
      "search",
      "terminal",
      "--scope",
      "registry",
      "--target-root",
      fixture.workspace,
    ], fixture.home);
    const empty = await runCli([
      "search",
      "definitely-no-match",
      "--scope",
      "registry",
      "--target-root",
      fixture.workspace,
    ], fixture.home);

    expect(human.stdout).toBe([
      "1. registry-terminal [type=skill; ecosystem=skillkit; installability=registry; provenance=registry]",
      "   Terminal workflow helper.",
      "   Install: npx agentwheel install 'registry-terminal'",
      "",
    ].join("\n"));
    expect(empty.stdout).toBe('No artifacts found for "definitely-no-match".\n');
    expect(empty.stderr).toBe("");
  });

  it("trims queries and rejects whitespace-only input", async () => {
    const fixture = await registryFixture();
    const trimmed = await runCli([
      "search",
      "  terminal  ",
      "--scope",
      "registry",
      "--json",
      "--target-root",
      fixture.workspace,
    ], fixture.home);
    expect(JSON.parse(trimmed.stdout).query).toBe("terminal");

    await expect(runCli([
      "search",
      "   ",
      "--scope",
      "registry",
      "--target-root",
      fixture.workspace,
    ], fixture.home)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Search query must not be empty"),
    });
  });

  it("applies type, ecosystem, limit, and archived filters", async () => {
    const home = await tempRoot("agentwheel-search-home-");
    await seedCatalogueCache(home);

    const filtered = JSON.parse((await runCli([
      "search",
      "browser",
      "--scope",
      "enriched",
      "--type",
      "package",
      "--ecosystem",
      "official",
      "--limit",
      "1",
      "--offline",
      "--json",
    ], home)).stdout);
    expect(filtered.results.map((entry: { name: string }) => entry.name)).toEqual(["demo-pack"]);

    const excluded = JSON.parse((await runCli([
      "search",
      "retired",
      "--scope",
      "enriched",
      "--offline",
      "--json",
    ], home)).stdout);
    const included = JSON.parse((await runCli([
      "search",
      "retired",
      "--scope",
      "enriched",
      "--include-archived",
      "--offline",
      "--json",
    ], home)).stdout);
    expect(excluded.results).toEqual([]);
    expect(included.results.map((entry: { name: string }) => entry.name)).toEqual(["retired-browser"]);
  });

  it.each([
    [["search", "x", "--scope", "bogus"], "Invalid search scope"],
    [["search", "x", "--type", "bogus"], "Invalid artifact type"],
    [["search", "x", "--ecosystem", "bogus"], "Invalid ecosystem"],
    [["search", "x", "--limit", "0"], "Invalid search limit"],
    [["search", "x", "--limit", "101"], "Invalid search limit"],
    [["search", "x", "--limit", "1.5"], "Invalid search limit"],
    [["search", "x", "--refresh", "--offline"], "--refresh cannot be used with --offline"],
  ])("rejects invalid search options: %j", async (args, message) => {
    const home = await tempRoot("agentwheel-search-home-");
    await expect(runCli(args, home)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(message),
    });
  });

  it("fails offline without a catalogue cache and succeeds with a compatible cache", async () => {
    const home = await tempRoot("agentwheel-search-home-");
    await expect(runCli([
      "search",
      "browser",
      "--scope",
      "enriched",
      "--offline",
      "--json",
    ], home)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Offline"),
    });

    await seedCatalogueCache(home);
    const cached = await runCli([
      "search",
      "browser",
      "--scope",
      "enriched",
      "--offline",
      "--json",
    ], home);
    expect(JSON.parse(cached.stdout).fromCache).toBe(true);
  });
});

async function runCli(args: string[], home: string) {
  try {
    return await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw error as { stdout: string; stderr: string; code: number };
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function registryFixture(): Promise<{ home: string; workspace: string }> {
  const root = await tempRoot("agentwheel-search-registry-");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const indexPath = join(root, "index.json");
  await mkdir(join(workspace, ".agentwheel"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    entries: [
      {
        name: "registry-terminal",
        source: "skillkit:example/terminal",
        type: "skill",
        description: "Terminal workflow helper.",
        tags: ["terminal", "workflow"],
      },
      {
        name: "demo-pack",
        source: "github:example/demo-pack",
        type: "package",
        description: "Registry route for the browser package.",
        tags: ["browser"],
      },
    ],
  }, null, 2)}\n`, "utf8");
  await writeFile(join(workspace, ".agentwheel", "config.json"), `${JSON.stringify({
    schemaVersion: 1,
    packages: [],
    registry: { sources: [indexPath] },
  }, null, 2)}\n`, "utf8");
  return { home, workspace };
}

async function seedCatalogueCache(home: string): Promise<void> {
  const enriched = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-23T00:00:00.000Z",
    entries: [
      {
        id: "official:demo-pack",
        name: "demo-pack",
        ecosystem: "official",
        type: "package",
        description: "Reusable browser automation package.",
        tags: ["browser", "automation"],
        source: "github:example/demo-pack",
        installCommand: "npx agentwheel install demo-pack",
        repoUrl: "https://github.com/example/demo-pack",
        homepageUrl: null,
        stars: 10,
        lastPush: "2026-07-20T00:00:00Z",
        archived: false,
        provides: ["skills"],
        version: "1.0.0",
      },
      {
        id: "vercel:example/skills/browser-tool",
        name: "browser-tool",
        ecosystem: "vercel",
        type: "skill",
        description: "Short curated browser description.",
        tags: ["browser"],
        source: "vercel:skills.sh/example/skills/browser-tool",
        installCommand: 'npx agentwheel install "vercel:skills.sh/example/skills/browser-tool"',
        repoUrl: "https://github.com/example/skills",
        homepageUrl: "https://skills.sh/example/skills/browser-tool",
        stars: null,
        lastPush: null,
        archived: false,
        provides: null,
        version: null,
        featured: true,
      },
      {
        id: "official:retired-browser",
        name: "retired-browser",
        ecosystem: "official",
        type: "skill",
        description: "Retired browser helper.",
        tags: ["retired"],
        source: "github:example/retired-browser",
        installCommand: "npx agentwheel install github:example/retired-browser",
        repoUrl: "https://github.com/example/retired-browser",
        homepageUrl: null,
        stars: 1,
        lastPush: "2020-01-01T00:00:00Z",
        archived: true,
        provides: ["skills"],
        version: null,
      },
    ],
  });
  const vercel = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-23T00:00:00.000Z",
    count: 2,
    entries: [
      {
        o: "example",
        r: "skills",
        s: "browser-tool",
        d: "Long capability-oriented browser automation description.",
      },
      {
        o: "other",
        r: "different",
        s: "browser-tool",
        d: "Same display name, different browser artifact.",
      },
    ],
  });
  const client = new CatalogueClient({
    cachePath: join(home, ".agentwheel", "catalogue-cache.json"),
    fetch: async (input) => {
      const source = String(input);
      if (source === DEFAULT_ENRICHED_CATALOGUE_URL) return new Response(enriched);
      if (source === DEFAULT_VERCEL_CATALOGUE_URL) return new Response(vercel);
      return new Response(`Unexpected catalogue source: ${source}`, { status: 404 });
    },
  });
  await client.getIndex();
}
