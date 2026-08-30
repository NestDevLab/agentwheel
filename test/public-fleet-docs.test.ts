import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("public named-fleet documentation", () => {
  it("uses parseable generic schema-v3 fleet examples", async () => {
    for (const file of ["README.md", "docs/fleet-config.md", "skills/agentwheel/SKILL.md"]) {
      const content = await readFile(join(root, file), "utf8");
      const blocks = [...content.matchAll(/```jsonc?\n([\s\S]*?)\n```/g)]
        .map((match) => match[1]!)
        .filter((block) => block.includes('"fleetId": "example-fleet"'));
      expect(blocks, `${file} schema-v3 fleet example`).toHaveLength(1);
      expect(() => JSON.parse(blocks[0]!)).not.toThrow();
      expect(JSON.parse(blocks[0]!)).toMatchObject({
        schemaVersion: 3,
        fleetId: "example-fleet",
        packages: [{ name: "core-agent-pack" }],
      });
    }
  });

  it("documents registration, inspection, digested apply, and exact recovery syntax", async () => {
    const files = await Promise.all([
      "README.md",
      "AGENT.md",
      "docs/fleet-config.md",
      "docs/index.html",
      "skills/agentwheel/SKILL.md",
    ].map(async (file) => [file, await readFile(join(root, file), "utf8")] as const));

    for (const [file, content] of files) {
      expect(content, file).toContain("agentwheel fleet register example-fleet");
      expect(content, file).toContain("--required-package core-agent-pack");
      expect(content, file).toContain("agentwheel fleet list");
      expect(content, file).toContain("agentwheel fleet show example-fleet");
      expect(content, file).toContain("agentwheel fleet normalize example-fleet --from user --package core-agent-pack");
      expect(content, file).toContain("--plan-digest");
      expect(content, file).toContain("--apply");
      expect(content, file).toContain("agentwheel fleet normalize example-fleet --from user --recover");
      expect(content, file).not.toContain("agentwheel fleet normalize recover");
    }
  });

  it("keeps upgrade-before-schema and explicit scope guidance", async () => {
    const content = await readFile(join(root, "docs/fleet-config.md"), "utf8");
    expect(content.indexOf("Upgrade")).toBeLessThan(content.indexOf("## Create and register a fleet"));
    expect(content).toContain("agentwheel fleet --help");
    expect(content).toContain("`fleetId`");
    expect(content).toContain("`--required-package`");
    expect(content).toContain("`--user`, `--local`, or `--fleet <fleet-id>`");
    expect(content).toContain("no named fleet has global priority");
    expect(content).not.toContain("agentwheel init --fleet-example");
  });

  it("describes named fleets as schema v3 or newer without pinning register help to v3", async () => {
    for (const file of [
      "README.md",
      "AGENT.md",
      "install.md",
      "llms.txt",
      "docs/fleet-config.md",
      "skills/agentwheel/SKILL.md",
    ]) {
      const content = await readFile(join(root, file), "utf8");
      expect(content, file).toMatch(/schema v3 or newer/i);
      expect(content, file).not.toContain("schema-v3-capable");
      expect(content, file).not.toContain("schema-v3-or-newer");
      expect(content, file).not.toMatch(/schema-v3 fleet/i);
    }
  });
});
