import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { readInstallManifest, uninstall, writeInstallManifest, type DesiredArtifact } from "../src/install/index.js";
import { applyJournalPath } from "../src/install/transaction.js";
import { createExactMcpRetirementPlan } from "../src/lifecycle/mcp-retirement.js";
import { targetMappingSchema, type AdapterConfig } from "../src/model/adapter.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath, pathExists } from "../src/utils/fs.js";

const roots: string[] = [];
const stateKey = "fixture.user.legacy";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const claudeAdapter: AdapterConfig = {
  name: "claude",
  targets: {
    mcp: {
      user: targetMappingSchema.parse({ enabled: true, dest: ".claude.json", merge: "json-deep" }),
    },
  },
};

describe("exact MCP retirement", () => {
  it("removes one exact unmanaged Claude server while preserving canonical and user config", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const configPath = join(targetRoot, ".claude.json");
    await writeFile(configPath, jsonConfig(), "utf8");

    const plan = await retirementPlan([legacy], claudeAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    });
    expect(plan.hasBlockingChanges).toBe(false);
    expect(plan.operations).toMatchObject([{
      action: "remove",
      exactMergeRemoval: true,
      reason: "retire exact unmanaged MCP contribution under workspace-root:/fleet/cutover",
    }]);

    await uninstall(plan);
    const current = JSON.parse(await readFile(configPath, "utf8"));
    expect(current.keep).toBe(true);
    expect(current.mcpServers.amf).toEqual({ command: "canonical-amf", args: ["--stdio"] });
    expect(current.mcpServers["amf-interactive-recall"]).toBeUndefined();
    expect(await readInstallManifest(targetRoot, claudeAdapter.name, localTransport, { installationType: "user", stateKey })).toBeUndefined();
  });

  it("accepts one exact foreign-owned incomplete manifest only with the declared handoff owner", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const configPath = join(targetRoot, ".claude.json");
    await writeFile(configPath, jsonConfig(), "utf8");
    const oldOwner = "workspace-root:/tmp/old-cutover";
    await writeLegacyManifest(claudeAdapter, targetRoot, legacy, configPath, oldOwner);
    const manifest = await readManifest(claudeAdapter, targetRoot);

    await expect(retirementPlan([legacy], claudeAdapter, targetRoot, manifest, {
      workspaceOwner: "workspace-root:/fleet/cutover",
      expectedFromWorkspaceOwner: "workspace-root:/wrong-owner",
    })).rejects.toThrow(/manifest precondition failed: owner/);

    const plan = await retirementPlan([legacy], claudeAdapter, targetRoot, manifest, {
      workspaceOwner: "workspace-root:/fleet/cutover",
      expectedFromWorkspaceOwner: oldOwner,
    });
    expect(plan.baseRevision).toBe(manifest.revision);
    expect(plan.operations[0]?.reason).toContain(`ownership handoff from ${oldOwner}`);
    await uninstall(plan);
    expect((JSON.parse(await readFile(configPath, "utf8"))).mcpServers).toEqual({
      amf: { command: "canonical-amf", args: ["--stdio"] },
    });
  });

  it("fails closed during planning when the legacy contribution differs", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const current = JSON.parse(jsonConfig());
    current.mcpServers["amf-interactive-recall"].args.push("--unexpected");
    const configPath = join(targetRoot, ".claude.json");
    await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    const before = await readFile(configPath, "utf8");

    const plan = await retirementPlan([legacy], claudeAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{ action: "conflict" }]);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("retires multiple exact servers from one MCP artifact", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const source = JSON.parse(await readFile(legacy.sourcePath, "utf8"));
    source.mcpServers.secondLegacy = { command: "second" };
    await writeFile(legacy.sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const desired = { ...legacy, hash: await hashPath(legacy.sourcePath) };
    await writeFile(join(targetRoot, ".claude.json"), `${JSON.stringify({
      mcpServers: { amf: { command: "canonical-amf" }, ...source.mcpServers },
    }, null, 2)}\n`, "utf8");

    const plan = await retirementPlan([desired], claudeAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    });
    expect(plan.operations).toMatchObject([{ action: "remove", exactMergeRemoval: true }]);
    await uninstall(plan);
    expect((JSON.parse(await readFile(join(targetRoot, ".claude.json"), "utf8"))).mcpServers).toEqual({
      amf: { command: "canonical-amf" },
    });
  });

  it("rejects non-MCP root configuration", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const source = JSON.parse(await readFile(legacy.sourcePath, "utf8"));
    source.unrelated = true;
    await writeFile(legacy.sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const desired = { ...legacy, hash: await hashPath(legacy.sourcePath) };
    await writeFile(join(targetRoot, ".claude.json"), `${JSON.stringify({
      ...source,
      mcpServers: { amf: { command: "canonical-amf" }, ...source.mcpServers },
    }, null, 2)}\n`, "utf8");

    await expect(retirementPlan([desired], claudeAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    })).rejects.toThrow(/one or more MCP servers and no non-MCP configuration/);
  });

  it("revalidates exact content before apply without leaving a journal on a plan/apply race", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const configPath = join(targetRoot, ".claude.json");
    await writeFile(configPath, jsonConfig(), "utf8");
    const plan = await retirementPlan([legacy], claudeAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    });
    const changed = JSON.parse(await readFile(configPath, "utf8"));
    changed.mcpServers["amf-interactive-recall"].command = "drifted-command";
    await writeFile(configPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
    const before = await readFile(configPath, "utf8");

    await expect(uninstall(plan)).rejects.toThrow(/exact MCP retirement precondition failed/i);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await pathExists(applyJournalPath(targetRoot, claudeAdapter.name, { installationType: "user", stateKey }))).toBe(false);
  });

  it("removes only the exact legacy Codex TOML sections", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await mcpArtifact(sourceRoot);
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "model = \"gpt-test\"",
      "",
      "[mcp_servers.amf]",
      "command = \"canonical-amf\"",
      "args = [\"--stdio\"]",
      "",
      "[mcp_servers.amf-interactive-recall]",
      "command = \"legacy-amf\"",
      "args = [\"--stdio\", \"--safe\"]",
      "",
      "[mcp_servers.amf-interactive-recall.env]",
      "HANDOFF_DIR = \"/etc/amf-interactive-recall\"",
      "",
    ].join("\n"), "utf8");

    const plan = await retirementPlan([legacy], codexAdapter, targetRoot, undefined, {
      workspaceOwner: "workspace-root:/fleet/cutover",
    }, "local");
    expect(plan.operations).toMatchObject([{ action: "remove" }]);
    await uninstall(plan);
    const current = await readFile(configPath, "utf8");
    expect(current).toContain("[mcp_servers.amf]");
    expect(current).toContain("command = \"canonical-amf\"");
    expect(current).not.toContain("amf-interactive-recall");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-mcp-retirement-"));
  roots.push(root);
  return root;
}

async function mcpArtifact(root: string): Promise<DesiredArtifact> {
  const sourcePath = join(root, "amf-interactive-recall.json");
  await writeFile(sourcePath, `${JSON.stringify({
    mcpServers: {
      "amf-interactive-recall": {
        command: "legacy-amf",
        args: ["--stdio", "--safe"],
        env: { HANDOFF_DIR: "/etc/amf-interactive-recall" },
      },
    },
  }, null, 2)}\n`, "utf8");
  return {
    type: "mcp",
    name: "amf-interactive-recall.json",
    sourcePath,
    stagedPath: sourcePath,
    relativePath: "amf-interactive-recall.json",
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: {
      logicalSelector: "mcp/amf-interactive-recall.json",
      dependencyRole: "root",
      owners: ["legacy-amf"],
    },
  };
}

function jsonConfig(): string {
  return `${JSON.stringify({
    keep: true,
    mcpServers: {
      amf: { command: "canonical-amf", args: ["--stdio"] },
      "amf-interactive-recall": {
        command: "legacy-amf",
        args: ["--stdio", "--safe"],
        env: { HANDOFF_DIR: "/etc/amf-interactive-recall" },
      },
    },
  }, null, 2)}\n`;
}

async function retirementPlan(
  artifacts: DesiredArtifact[],
  adapter: AdapterConfig,
  targetRoot: string,
  manifest: Awaited<ReturnType<typeof readInstallManifest>>,
  owner: { workspaceOwner: string; expectedFromWorkspaceOwner?: string },
  installationType = "user",
) {
  return createExactMcpRetirementPlan(artifacts, adapter, targetRoot, manifest, localTransport, {
    installationType,
    stateKey,
    ...owner,
  });
}

async function writeLegacyManifest(
  adapter: AdapterConfig,
  targetRoot: string,
  artifact: DesiredArtifact,
  configPath: string,
  workspaceOwner: string,
): Promise<void> {
  await writeInstallManifest({
    version: 2,
    adapter: adapter.name,
    installationType: "user",
    stateKey,
    targetRoot,
    generatedAt: "2026-08-13T00:00:00.000Z",
    revision: "pending-legacy-fixture",
    legacy: false,
    entries: [{
      path: adapter.name === "claude" ? ".claude.json" : ".codex/config.toml",
      artifactType: "mcp",
      artifactName: artifact.name,
      installName: artifact.name,
      logicalSelector: `mcp/${artifact.name}`,
      dependencyRole: "root",
      owners: ["legacy-amf"],
      refCount: 1,
      workspaceOwner,
      kind: "file",
      hash: await hashPath(configPath),
      sourceHash: artifact.hash,
      updatedAt: "2026-08-13T00:00:00.000Z",
      channel: "managed",
      mergeStrategy: adapter.name === "claude" ? "json-deep" : "codex-toml-mcp",
      mergeRemoval: {},
    }],
  }, localTransport);
}

async function readManifest(adapter: AdapterConfig, targetRoot: string) {
  const manifest = await readInstallManifest(targetRoot, adapter.name, localTransport, { installationType: "user", stateKey });
  if (!manifest) throw new Error("expected fixture manifest");
  return manifest;
}
