import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const skillPath = join(process.cwd(), "skills", "agentwheel", "SKILL.md");

async function readSkill(): Promise<{
  content: string;
  frontmatter: Record<string, unknown>;
}> {
  const content = await readFile(skillPath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);

  expect(match).not.toBeNull();

  return {
    content,
    frontmatter: YAML.parse(match![1]!),
  };
}

describe("Agentwheel companion skill", () => {
  it("triggers for reusable capability discovery", async () => {
    const { frontmatter } = await readSkill();
    const description = String(frontmatter.description);

    expect(frontmatter.name).toBe("agentwheel");
    expect(description).toContain("Discover or manage reusable agent artifacts");
    expect(description).toContain("capability");
    expect(description).toContain("integration");
    expect(description).toContain("workflow");
    expect(description).toContain("repeated manual workflow");
  });

  it("uses the unified search command only", async () => {
    const { content } = await readSkill();

    expect(content).toContain('agentwheel search "<query>"');
    expect(content).toContain('agentwheel search "<query>" --json --limit 10');
    expect(content).toContain('agentwheel search "<query>" --scope registry');
    expect(content).not.toContain("agentwheel registry search");
  });

  it("bounds semantic query expansion", async () => {
    const { content } = await readSkill();

    expect(content).toContain("one to four short lexical queries");
    expect(content).toContain("Stop after four calls");
    expect(content).toContain("do not recursively refine without new user requirements");
    expect(content).toContain("Merge results by stable `id`");
    expect(content).toContain("Treat CLI scores as retrieval signals, not semantic confidence");
  });

  it("requires evidence-based reranking and bounded suggestions", async () => {
    const { content } = await readSkill();

    expect(content).toContain("Rerank against the original request");
    expect(content).toContain("Do not infer capabilities absent from result metadata");
    expect(content).toContain("Suggest zero to three distinct artifacts");
    expect(content).toContain("candidates are only weak lexical matches");
    expect(content).toContain("search once per distinct capability gap");
    expect(content).toContain("the same suggestion was declined or shown without new evidence");
    expect(content).toContain("delegated agents follow the same trigger");
  });

  it("keeps search separate from mutations and OpenPack suggestions", async () => {
    const { content } = await readSkill();

    expect(content).toContain("Search results are proposals, not approval");
    expect(content).toContain("Never add, install, enable, or change configuration until the user confirms the artifact and target scope");
    expect(content).toContain("Wait for explicit approval before `add`, `install`, plugin execution, or configuration changes");
    expect(content).toContain("they do not select OpenPack `suggests`, mutate desired state, or imply installation approval");
  });
});
