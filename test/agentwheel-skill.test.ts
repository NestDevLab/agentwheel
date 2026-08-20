import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

async function readSkill(name: string): Promise<{
  content: string;
  frontmatter: Record<string, unknown>;
}> {
  const content = await readFile(join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);

  expect(match).not.toBeNull();

  return {
    content,
    frontmatter: YAML.parse(match![1]!),
  };
}

describe("Agentwheel companion skills", () => {
  it("keeps management explicit and points to optional proactive discovery", async () => {
    const { content, frontmatter } = await readSkill("agentwheel");
    const description = String(frontmatter.description);

    expect(frontmatter.name).toBe("agentwheel");
    expect(description).toContain("Manage and explicitly inspect");
    expect(description).toContain("when the user asks");
    expect(description).toContain("separate agentwheel-discovery skill");
    expect(description).not.toContain("Trigger proactively");
    expect(content).toContain("## Explicit Discovery");
    expect(content).toContain("Install `skills/agentwheel-discovery` separately");
  });

  it("triggers the optional skill for reusable capability discovery", async () => {
    const { frontmatter } = await readSkill("agentwheel-discovery");
    const description = String(frontmatter.description);

    expect(frontmatter.name).toBe("agentwheel-discovery");
    expect(description).toContain("MUST use proactively");
    expect(description).toContain("operational intent");
    expect(description).toContain("could plausibly fulfill");
    expect(description).toContain("even if the user did not ask for a skill or describe a capability gap");
    expect(description).toContain("Inspect installed artifacts");
    expect(description).toContain("when none already covers the intent");
    expect(description).toContain("semantic search");
    expect(description).toContain("up to three");
    expect(description).toContain("read-only trial");
    expect(description).toContain("without installing or changing anything");
  });

  it("evolves source artifacts without hard dependencies on authoring skills", async () => {
    const { content, frontmatter } = await readSkill("agentwheel-artifact-evolution");
    const description = String(frontmatter.description);

    expect(frontmatter.name).toBe("agentwheel-artifact-evolution");
    expect(description).toContain("Generate or evolve OpenPack artifacts");
    expect(description).toContain("capability gap, correction, or rollout request");
    expect(content).toContain("`self-improve` and `skill-creator` are optional inspirations");
    expect(content).toContain("do not require, install, or link to them");
    expect(content).toContain("Run `agentwheel init package` only when no package exists");
    expect(content).toContain("Prove the source merge");
    expect(content).toContain("Never use force, plugin execution, or runtime reload");
  });

  it("does not let generic advice suppress operational discovery", async () => {
    const { content } = await readSkill("agentwheel-discovery");
    const prose = content.replace(/\s+/g, " ");

    expect(prose).toContain("Use this skill whenever a request expresses an operational outcome");
    expect(prose).toContain("an existing reusable skill or integration could plausibly deliver");
    expect(prose).toContain("The user does not need to mention Agentwheel, skills, discovery, search, a catalogue, or a capability gap");
    expect(prose).toContain("Search before generic brainstorming, planning, manual workflow advice, or an unsolicited custom solution");
    expect(prose).toContain("Run the first semantic search in the same turn");
    expect(prose).toContain("provides the requested operational capability end to end");
    expect(prose).toContain("Generic brainstorming, planning, writing, or advisory skills do not count");
  });

  it("uses unified semantic search and read-only trial commands", async () => {
    const { content } = await readSkill("agentwheel-discovery");
    const prose = content.replace(/\s+/g, " ");

    expect(content).toContain('agentwheel search "<query>" --semantic --json --limit 10');
    expect(content).toContain("agentwheel try <source> --skill <name> --json");
    expect(content).not.toContain("agentwheel registry search");
    expect(prose).toContain("same published catalogue vector index used by the website");
    expect(prose).toContain("validates its checksums against the loaded catalogue");
    expect(prose).toContain("does not add a package, change configuration, write runtime files, or execute code");
  });

  it("bounds search expansion and recommendations", async () => {
    const { content } = await readSkill("agentwheel-discovery");
    const prose = content.replace(/\s+/g, " ");

    expect(content).toContain("up to three short lexical variants");
    expect(content).toContain("Stop after four total searches");
    expect(content).toContain("do not recursively refine without new user requirements");
    expect(content).toContain("Merge results by stable `id`");
    expect(content).toContain("Treat CLI scores as retrieval signals, not semantic confidence");
    expect(content).toContain("Rerank against the original request");
    expect(prose).toContain("Do not infer capabilities absent from result metadata");
    expect(prose).toContain("Suggest zero to three distinct artifacts");
    expect(content).toContain("Search once per distinct capability gap");
  });

  it("suppresses noisy suggestions and keeps every mutation gated", async () => {
    const { content } = await readSkill("agentwheel-discovery");
    const prose = content.replace(/\s+/g, " ");

    expect(prose).toContain("candidates are only weak lexical matches");
    expect(prose).toContain("the same suggestion was declined or shown without new evidence");
    expect(content).toContain("Delegated agents");
    expect(content).toContain("Search recommendations are conversational only");
    expect(prose).toContain("they do not select OpenPack `suggests`, mutate");
    expect(prose).toContain("Wait for explicit approval before `add`, `install`");
  });
});
