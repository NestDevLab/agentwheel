import { describe, expect, it } from "vitest";
import {
  createRegistryPublishDraft,
  inferRegistryEntryType,
  installCommandForEntry,
  normalizeCatalogueSource,
} from "../src/registry/publish.js";

describe("registry publish draft", () => {
  it("normalizes GitHub URLs into catalogue sources", () => {
    expect(normalizeCatalogueSource("https://github.com/Owner/Agent-Pack/tree/main")).toBe("github:Owner/Agent-Pack#main");
    expect(normalizeCatalogueSource("git+https://github.com/Owner/Agent-Pack.git#v1")).toBe("github:Owner/Agent-Pack#v1");
    expect(normalizeCatalogueSource("Owner/Agent-Pack#beta")).toBe("github:Owner/Agent-Pack#beta");
  });

  it("infers entry metadata and creates a prefilled issue URL", () => {
    const draft = createRegistryPublishDraft("https://github.com/Owner/Agent-Pack", {
      description: "Reusable rules and skills for coding agents.",
      tags: ["agents, skills", "Rules"],
    });

    expect(draft.entry).toEqual({
      name: "agent-pack",
      source: "github:Owner/Agent-Pack",
      type: "package",
      description: "Reusable rules and skills for coding agents.",
      tags: ["agents", "skills", "rules"],
    });
    expect(draft.installCommand).toBe("agentwheel install github:Owner/Agent-Pack --adapter codex --local --dry-run");
    const issueUrl = new URL(draft.issueUrl);
    expect(issueUrl.searchParams.get("title")).toBe("Catalogue submission: agent-pack");
    expect(issueUrl.searchParams.get("body")).toContain('"source": "github:Owner/Agent-Pack"');
  });

  it("infers provider-specific entry types and verification commands", () => {
    expect(inferRegistryEntryType("skillkit:owner/review")).toBe("skill");
    expect(inferRegistryEntryType("vercel:owner/review")).toBe("skill");
    expect(inferRegistryEntryType("mcp-registry:io.example/demo")).toBe("mcp");
    expect(inferRegistryEntryType("clawhub:@openclaw/demo")).toBe("plugin");

    expect(installCommandForEntry({ source: "mcp-registry:io.example/demo", type: "mcp" }))
      .toBe("agentwheel install mcp-registry:io.example/demo --adapter claude --local --dry-run");
    expect(installCommandForEntry({ source: "clawhub:@openclaw/demo", type: "plugin" }))
      .toBe("agentwheel install clawhub:@openclaw/demo --adapter openclaw --local --dry-run");
  });

  it("rejects local catalogue submissions", () => {
    expect(() => normalizeCatalogueSource("./local-pack")).toThrow(/public source/);
  });
});
