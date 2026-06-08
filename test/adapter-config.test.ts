import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdapterConfig } from "../src/model/adapter.js";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("adapter config loader", () => {
  it("loads strict JSON adapter config", async () => {
    const adapter = await loadAdapterConfig(join(testDir, "fixtures", "adapters", "plain.json"));
    expect(adapter.name).toBe("plain-json");
    expect(adapter.targets.instructions?.dest).toBe(".plain/AGENTS.md");
    expect(adapter.targets.rules?.dest).toBe(".plain/rules");
  });

  it("loads JSONC adapter config with comments and trailing commas", async () => {
    const adapter = await loadAdapterConfig(join(testDir, "fixtures", "adapters", "commented.jsonc"));
    expect(adapter.name).toBe("commented-jsonc");
    expect(adapter.targets.instructions?.dest).toBe(".commented/AGENTS.md");
    expect(adapter.targets.skills?.dest).toBe(".commented/skills");
  });
});

