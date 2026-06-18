import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { validateArtifactsForInstall } from "../src/validation/artifacts.js";
import type { Artifact } from "../src/model/artifact.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function skillArtifact(skillMd: string): Promise<Artifact> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-frontmatter-"));
  tempRoots.push(root);
  const dir = join(root, "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");
  return {
    type: "skills",
    name: "demo",
    sourcePath: dir,
    relativePath: "skills/demo",
    kind: "dir",
    hash: "0".repeat(64),
    channel: "managed",
  };
}

const validFrontmatter = "---\nname: demo\ndescription: A demo skill.\n---\n\n# Demo\n";

describe("SKILL.md frontmatter validation", () => {
  it("accepts a SKILL.md with frontmatter at the first line", async () => {
    const artifact = await skillArtifact(validFrontmatter);
    await expect(validateArtifactsForInstall([artifact], codexAdapter, "user")).resolves.toBeUndefined();
  });

  it("rejects content before the frontmatter delimiter", async () => {
    const artifact = await skillArtifact(`> note before frontmatter\n\n${validFrontmatter}`);
    await expect(validateArtifactsForInstall([artifact], codexAdapter, "user"))
      .rejects.toThrow(/frontmatter delimited by '---' on the first line/);
  });

  it("rejects a leading UTF-8 BOM", async () => {
    const artifact = await skillArtifact(`﻿${validFrontmatter}`);
    await expect(validateArtifactsForInstall([artifact], codexAdapter, "user"))
      .rejects.toThrow(/UTF-8 BOM/);
  });

  it("rejects an unterminated frontmatter block", async () => {
    const artifact = await skillArtifact("---\nname: demo\ndescription: x\n\n# Demo\n");
    await expect(validateArtifactsForInstall([artifact], codexAdapter, "user"))
      .rejects.toThrow(/not closed with a '---' delimiter/);
  });

  it("rejects frontmatter missing name or description", async () => {
    const artifact = await skillArtifact("---\ndescription: x\n---\n");
    await expect(validateArtifactsForInstall([artifact], codexAdapter, "user"))
      .rejects.toThrow(/must define 'name'/);
  });
});
