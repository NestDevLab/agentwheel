import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { codexAdapter } from "../src/adapters/codex.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";

const repoRoot = process.cwd();

async function readSkill(name: string): Promise<{
  content: string;
  frontmatter: Record<string, unknown>;
}> {
  const content = await readFile(join(repoRoot, "skills", name, "SKILL.md"), "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return { content, frontmatter: YAML.parse(match![1]!) };
}

describe("Agentwheel companion skills", () => {
  it("keeps lifecycle management separate from proactive discovery", async () => {
    const core = await readSkill("agentwheel");
    const discovery = await readSkill("agentwheel-discovery");

    expect(core.frontmatter.name).toBe("agentwheel");
    expect(String(core.frontmatter.description)).toContain("Manage reusable agent artifacts");
    expect(String(core.frontmatter.description)).not.toContain("Trigger proactively");
    expect(core.content).not.toContain("## Discovery And Recommendations");

    expect(discovery.frontmatter.name).toBe("agentwheel-discovery");
    expect(String(discovery.frontmatter.description)).toContain("proactively");
    expect(String(discovery.frontmatter.description)).toContain("missing capability");
    expect(String(discovery.frontmatter.description)).toContain("repeated manual workflow");
    expect(String(discovery.frontmatter.description)).toContain("read-only trials");
  });

  it("uses trialable skill-only search for read-only intent", async () => {
    const { content } = await readSkill("agentwheel-discovery");

    expect(content).toContain('agentwheel search "<query>" --semantic --type skill --json --limit 10');
    expect(content).toContain("one specific installed artifact covers the requested workflow end to end");
    expect(content).toContain("A generic planning, developer, reviewer, or operator role is not sufficient");
    expect(content).toContain("up to three short lexical variants");
    expect(content).toContain("Stop after four total searches");
    expect(content).toContain("Merge results by stable `id`");
    expect(content).toContain("Suggest zero to three distinct");
  });

  it("documents verified semantic search and read-only trials", async () => {
    const { content } = await readSkill("agentwheel-discovery");

    expect(content).toContain("same published catalogue vector index as the website");
    expect(content).toContain("validates its checksums against the loaded catalogue");
    expect(content).toContain("agentwheel try <source> --skill <name> --json");
    expect(content).toContain("does not add a package, change configuration, write runtime files, or execute code");
    expect(content).toContain("Never add, install, enable, execute, or change configuration until the user explicitly approves");
    expect(content).toContain("they do not select OpenPack `suggests` or mutate desired state");
  });

  it("couples opt-in discovery to its always-loaded preflight", async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, "openpack.json"), "utf8"));
    const instruction = await readFile(join(repoRoot, "instructions", "agentwheel-discovery.md"), "utf8");
    const skills = manifest.provides.find((entry: { type: string }) => entry.type === "skills");

    expect(manifest.provides).toContainEqual({
      type: "instructions",
      path: "instructions/agentwheel-discovery.md",
    });
    expect(skills.items["agentwheel-discovery"].requires).toEqual(["instructions/agentwheel-discovery.md"]);
    expect(skills.items.agentwheel).toBeUndefined();
    expect(instruction).toContain("A generic role or partial workflow does not count");
    expect(instruction).toContain("--semantic --type skill --json --limit 10");
    expect(instruction).toContain("Use the `agentwheel-discovery` skill for reranking and fallback rules");
  });

  it("selects the discovery preflight without coupling it to the core skill", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-skill-workspace-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-skill-target-"));

    try {
      const discovery = await createGraphSourcePlan({
        roots: [{ rootId: "agentwheel", source: repoRoot, select: ["skills/agentwheel-discovery"] }],
        workspaceRoot,
        targetRoot,
        adapter: codexAdapter,
        targetKey: "agentwheel-discovery-test",
        yes: true,
      });
      const core = await createGraphSourcePlan({
        roots: [{ rootId: "agentwheel", source: repoRoot, select: ["skills/agentwheel"] }],
        workspaceRoot,
        targetRoot,
        adapter: codexAdapter,
        targetKey: "agentwheel-core-test",
        yes: true,
      });

      expect(discovery.bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`).sort()).toEqual([
        "instructions/agentwheel-discovery.md",
        "skills/agentwheel-discovery",
      ]);
      expect(core.bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual([
        "skills/agentwheel",
      ]);
    } finally {
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
