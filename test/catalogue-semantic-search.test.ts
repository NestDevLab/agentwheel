import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const core = await import(pathToFileURL(join(repoRoot, "docs", "semantic-search-core.js")).href);

describe("catalogue semantic search core", () => {
  it("suppresses narrow conversation before loading search assets", () => {
    expect(core.classifyDiscoveryIntent("yes").action).toBe("abstain");
    expect(core.classifyDiscoveryIntent("what is two plus two").action).toBe("abstain");
    expect(core.classifyDiscoveryIntent("find a skill that reviews a proposed diff").action).toBe("search");
  });

  it("recognizes autonomous learning intent without treating generic agent chat as self-improvement", () => {
    expect(core.prepareSemanticQuery("I need that my agent learns stuff on its own").intent).toBe("self-learning-agent");
    expect(core.prepareSemanticQuery("agent that learns while chatting").intent).toBe("self-learning-agent");
    expect(core.prepareSemanticQuery("an assistant that adapts automatically from feedback").intent).toBe("self-learning-agent");
    expect(core.prepareSemanticQuery("build a chat agent").intent).toBeNull();
    expect(core.prepareSemanticQuery("teach my agent Spanish").intent).toBeNull();
  });

  it("promotes self-learning capabilities above generic agent matches", () => {
    const reranked = core.rerankSemanticCandidates([
      { id: "generic", score: 0.91 },
      { id: "learning", score: 0.89 },
      { id: "official", score: 0.88 },
    ], [
      { id: "generic", name: "ai-agent", description: "Build a conversational agent", ecosystem: "vercel" },
      { id: "learning", name: "self-improving-agent", description: "Continuously evolve from experience", ecosystem: "vercel" },
      { id: "official", name: "self-improve", description: "Capture corrections for future sessions", ecosystem: "official" },
    ], "self-learning-agent");
    expect(reranked.map((candidate: { id: string }) => candidate.id)).toEqual(["learning", "official", "generic"]);
  });

  it("rejects index metadata that does not match the exact catalogue", () => {
    const contract = core.SEMANTIC_INDEX_CONTRACT;
    const metadata = {
      schemaVersion: contract.schemaVersion,
      textSchemaVersion: contract.textSchemaVersion,
      count: 2,
      dimensions: contract.model.dimensions,
      vectorFormat: contract.vectorFormat,
      normFormat: contract.normFormat,
      model: { ...contract.model },
      catalogue: {
        enriched: { sha256: "a".repeat(64) },
        vercel: { sha256: "b".repeat(64) },
      },
      files: {
        ids: { path: "ids.json", bytes: 10, sha256: "c".repeat(64) },
        vectors: { path: "vectors.int8.bin", bytes: 768, sha256: "d".repeat(64) },
        norms: { path: "norms.f32.bin", bytes: 8, sha256: "e".repeat(64) },
      },
    };

    expect(() => core.validateSemanticIndexMetadata(metadata, {
      enriched: "a".repeat(64),
      vercel: "b".repeat(64),
    })).not.toThrow();
    expect(() => core.validateSemanticIndexMetadata(metadata, {
      enriched: "f".repeat(64),
      vercel: "b".repeat(64),
    })).toThrow(/checksum does not match enriched/u);
  });

  it("searches int8 vectors and groups same-name sources", () => {
    const vectors = Int8Array.from([127, 0, 0, 127, 90, 90]);
    const norms = Float32Array.from([127, 127, Math.sqrt((90 ** 2) * 2)]);
    const query = Float32Array.from([1, 0]);
    const ranked = core.searchInt8Index(vectors, norms, 2, query, 3);
    expect(ranked.map((candidate: { row: number }) => candidate.row)).toEqual([0, 2, 1]);

    const groups = core.groupSemanticResults([
      { id: "one", score: 1 },
      { id: "two", score: 0.9 },
      { id: "three", score: 0.8 },
    ], [
      { id: "one", name: "code-review", description: "A" },
      { id: "two", name: "code review", description: "B" },
      { id: "three", name: "inbox", description: "C" },
    ], 3);
    expect(groups).toHaveLength(2);
    expect(groups[0].alternates).toHaveLength(1);
    expect(groups[1].entry.id).toBe("three");
  });

  it("builds a user-level companion skill setup for supported runtimes", () => {
    expect(core.companionSkillSetupCommand("codex")).toBe([
      "npm i -g agentwheel",
      "agentwheel install github:NestDevLab/agentwheel --adapter codex --user --skill agentwheel",
    ].join("\n"));
    expect(core.companionSkillSetupCommand("OpenClaw")).toContain("--adapter openclaw --user");
    expect(() => core.companionSkillSetupCommand("unknown")).toThrow(/Unsupported Agentwheel adapter/u);
  });
});
