import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import {
  applyCombinedInstallPlan,
  createCombinedInstallPlan,
  createOwnershipUninstallPlan,
  readInstallManifest,
  uninstall,
  type DesiredArtifact,
} from "../src/install/index.js";
import { mergeCodexTomlMcp } from "../src/install/toml-merge.js";
import { targetMappingSchema, type AdapterConfig } from "../src/model/adapter.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-merge-adoption-"));
  tempRoots.push(root);
  return root;
}

async function writeMcpArtifact(root: string, name: string, serverName: string, command: string): Promise<DesiredArtifact> {
  const sourcePath = join(root, name);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify({
    mcpServers: {
      [serverName]: {
        command,
        args: ["--stdio", "--safe"],
        env: { HANDOFF_DIR: `/etc/${serverName}` },
      },
    },
  }, null, 2)}\n`, "utf8");
  return {
    type: "mcp",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: name,
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: {
      logicalSelector: `mcp/${name}`,
      dependencyRole: "root",
      owners: ["migration"],
    },
  };
}

const jsonAdapter: AdapterConfig = {
  name: "json-adoption",
  targets: {
    mcp: {
      local: targetMappingSchema.parse({ enabled: true, dest: "config.json", merge: "json-deep" }),
    },
  },
};

describe("exact merged contribution adoption", () => {
  it("adopts and removes an exact pre-existing JSON MCP server while preserving siblings", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "legacy-amf");
    await writeFile(join(targetRoot, "config.json"), `${JSON.stringify({
      keep: true,
      mcpServers: {
        amf: { command: "canonical-amf" },
        "amf-interactive-recall": {
          command: "legacy-amf",
          args: ["--stdio", "--safe"],
          env: { HANDOFF_DIR: "/etc/amf-interactive-recall" },
        },
      },
    }, null, 2)}\n`, "utf8");

    const beforeAdoption = await readFile(join(targetRoot, "config.json"), "utf8");
    const adoption = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot, undefined, localTransport, { forceConflict: true });
    expect(adoption.hasBlockingChanges).toBe(false);
    expect(adoption.operations).toHaveLength(1);
    expect(adoption.operations[0]?.action).toBe("skip");
    expect(adoption.operations[0]?.reason).toBe("force adopting exact unmanaged merge contribution");
    expect(adoption.operations[0]?.mergeRemoval).toEqual(JSON.parse(await readFile(legacy.sourcePath, "utf8")));

    await applyCombinedInstallPlan(adoption);
    expect(await readFile(join(targetRoot, "config.json"), "utf8")).toBe(beforeAdoption);
    const adoptedManifest = await readInstallManifest(targetRoot, jsonAdapter.name);
    if (!adoptedManifest) throw new Error("expected adopted JSON manifest");
    expect(adoptedManifest.entries[0]?.mergeRemoval).toEqual(JSON.parse(await readFile(legacy.sourcePath, "utf8")));

    const repeated = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot, adoptedManifest);
    expect(repeated.operations).toHaveLength(1);
    expect(repeated.operations[0]?.action).toBe("skip");
    expect(repeated.operations[0]?.mergeRemoval).toEqual(JSON.parse(await readFile(legacy.sourcePath, "utf8")));

    const refreshedSource = JSON.parse(await readFile(legacy.sourcePath, "utf8"));
    refreshedSource.mcpServers["amf-interactive-recall"].env.EXTRA = "refreshed";
    await writeFile(legacy.sourcePath, `${JSON.stringify(refreshedSource, null, 2)}\n`, "utf8");
    const refreshed = { ...legacy, hash: await hashPath(legacy.sourcePath) };
    const refreshPlan = await createCombinedInstallPlan([refreshed], jsonAdapter, targetRoot, adoptedManifest);
    expect(refreshPlan.operations).toMatchObject([{
      action: "update",
      reason: "merge source changed",
      mergeRemoval: { mcpServers: { "amf-interactive-recall": { env: { EXTRA: "refreshed" } } } },
    }]);
    await applyCombinedInstallPlan(refreshPlan);

    const refreshedManifest = await readInstallManifest(targetRoot, jsonAdapter.name);
    if (!refreshedManifest) throw new Error("expected refreshed JSON manifest");
    const removal = await createOwnershipUninstallPlan(refreshedManifest, [], jsonAdapter);
    expect(removal.operations).toMatchObject([{ action: "remove", mergeStrategy: "json-deep" }]);
    await uninstall(removal);

    const current = JSON.parse(await readFile(join(targetRoot, "config.json"), "utf8"));
    expect(current).toEqual({ keep: true, mcpServers: { amf: { command: "canonical-amf" } } });
  });

  it("fails closed when a pre-existing JSON contribution differs", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "expected-command");
    await writeFile(join(targetRoot, "config.json"), `${JSON.stringify({
      mcpServers: {
        "amf-interactive-recall": {
          command: "different-command",
          args: ["--stdio"],
          env: { HANDOFF_DIR: "/etc/amf-interactive-recall" },
        },
      },
    }, null, 2)}\n`, "utf8");

    const plan = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot, undefined, localTransport, { forceConflict: true });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: destination differs or is missing at $.mcpServers.amf-interactive-recall",
    }]);
  });

  it.each([
    ["missing server", undefined],
    ["extra field", { command: "expected-command", args: ["--stdio", "--safe"], env: { HANDOFF_DIR: "/etc/amf-interactive-recall" }, extra: true }],
    ["extra arg", { command: "expected-command", args: ["--stdio", "--safe", "--extra"], env: { HANDOFF_DIR: "/etc/amf-interactive-recall" } }],
    ["reordered args", { command: "expected-command", args: ["--safe", "--stdio"], env: { HANDOFF_DIR: "/etc/amf-interactive-recall" } }],
    ["extra env", { command: "expected-command", args: ["--stdio", "--safe"], env: { HANDOFF_DIR: "/etc/amf-interactive-recall", EXTRA: "unsafe" } }],
  ])("rejects JSON MCP adoption with %s", async (_label, currentServer) => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "expected-command");
    const current = {
      keep: true,
      mcpServers: {
        amf: { command: "canonical-amf" },
        ...(currentServer ? { "amf-interactive-recall": currentServer } : {}),
      },
    };
    const configPath = join(targetRoot, "config.json");
    await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    const before = await readFile(configPath, "utf8");

    const plan = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot, undefined, localTransport, { forceConflict: true });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: destination differs or is missing at $.mcpServers.amf-interactive-recall",
    }]);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readInstallManifest(targetRoot, jsonAdapter.name)).toBeUndefined();
  });

  it("rejects all JSON MCP adoption when one of multiple selected servers differs", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const contribution = await writeMcpArtifact(sourceRoot, "multi.json", "first", "first-command");
    const source = JSON.parse(await readFile(contribution.sourcePath, "utf8"));
    source.mcpServers.second = { command: "second-command", args: [], env: {} };
    await writeFile(contribution.sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const desired = { ...contribution, hash: await hashPath(contribution.sourcePath) };
    await writeFile(join(targetRoot, "config.json"), `${JSON.stringify({
      mcpServers: {
        first: source.mcpServers.first,
        second: { ...source.mcpServers.second, command: "different-command" },
      },
    }, null, 2)}\n`, "utf8");

    const plan = await createCombinedInstallPlan([desired], jsonAdapter, targetRoot, undefined, localTransport, { forceConflict: true });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: destination differs or is missing at $.mcpServers.second",
    }]);
  });

  it("does not claim a pre-existing merged contribution without force-conflict", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "legacy-amf");
    await writeFile(join(targetRoot, "config.json"), await readFile(legacy.sourcePath, "utf8"), "utf8");

    const plan = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot);
    expect(plan.operations).toMatchObject([{ action: "update", mergeRemoval: {} }]);
    await applyCombinedInstallPlan(plan);
    const manifest = await readInstallManifest(targetRoot, jsonAdapter.name);
    if (!manifest) throw new Error("expected JSON manifest");
    const removal = await createOwnershipUninstallPlan(manifest, [], jsonAdapter);
    expect(removal.operations).toMatchObject([{
      action: "keep",
      reason: "legacy merge ownership is incomplete; preserving destination and releasing management",
    }]);

    const beforeRepair = await readFile(join(targetRoot, "config.json"), "utf8");
    const repair = await createCombinedInstallPlan([legacy], jsonAdapter, targetRoot, manifest, localTransport, {
      forceConflict: true,
    });
    expect(repair.operations).toMatchObject([{
      action: "skip",
      reason: "force repairing exact incomplete merge ownership",
      mergeRemoval: JSON.parse(await readFile(legacy.sourcePath, "utf8")),
    }]);
    await applyCombinedInstallPlan(repair);
    expect(await readFile(join(targetRoot, "config.json"), "utf8")).toBe(beforeRepair);

    const repairedManifest = await readInstallManifest(targetRoot, jsonAdapter.name);
    if (!repairedManifest) throw new Error("expected repaired JSON manifest");
    expect(repairedManifest.entries[0]?.mergeRemoval).toEqual(JSON.parse(await readFile(legacy.sourcePath, "utf8")));
    await uninstall(await createOwnershipUninstallPlan(repairedManifest, [], jsonAdapter));

    const current = JSON.parse(await readFile(join(targetRoot, "config.json"), "utf8"));
    expect(current.mcpServers).toBeUndefined();
  });

  it("adopts and removes an exact pre-existing Codex MCP block while preserving canonical and user config", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const canonical = await writeMcpArtifact(sourceRoot, "canonical.json", "amf", "canonical-amf");
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "legacy-amf");
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "model = \"gpt-test\"\n", "utf8");
    await mergeCodexTomlMcp(canonical.sourcePath, configPath);
    await mergeCodexTomlMcp(legacy.sourcePath, configPath);
    const beforeAdoption = await readFile(configPath, "utf8");
    const legacyContribution = JSON.parse(await readFile(legacy.sourcePath, "utf8"));

    const adoption = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, undefined, localTransport, {
      forceConflict: true,
      installationType: "local",
    });
    expect(adoption.hasBlockingChanges).toBe(false);
    expect(adoption.operations).toHaveLength(1);
    expect(adoption.operations[0]?.action).toBe("skip");
    expect(adoption.operations[0]?.reason).toBe("force adopting exact unmanaged merge contribution");
    expect(adoption.operations[0]?.mergeRemoval).toEqual(legacyContribution);

    await applyCombinedInstallPlan(adoption);
    expect(await readFile(configPath, "utf8")).toBe(beforeAdoption);
    const manifest = await readInstallManifest(targetRoot, codexAdapter.name);
    if (!manifest) throw new Error("expected adopted Codex manifest");
    expect(manifest.entries[0]?.mergeRemoval).toEqual(legacyContribution);

    const repeated = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, manifest, localTransport, {
      installationType: "local",
    });
    expect(repeated.operations).toHaveLength(1);
    expect(repeated.operations[0]?.action).toBe("skip");
    expect(repeated.operations[0]?.mergeRemoval).toEqual(legacyContribution);

    await uninstall(await createOwnershipUninstallPlan(manifest, [], codexAdapter));

    const current = await readFile(configPath, "utf8");
    expect(current).toContain("model = \"gpt-test\"");
    expect(current).toContain("[mcp_servers.amf]");
    expect(current).not.toContain("[mcp_servers.amf-interactive-recall]");
  });

  it("fails closed when a pre-existing Codex MCP block differs", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "expected-command");
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "[mcp_servers.amf-interactive-recall]",
      "command = \"different-command\"",
      "args = [\"--stdio\"]",
      "",
      "[mcp_servers.amf-interactive-recall.env]",
      "HANDOFF_DIR = \"/etc/amf-interactive-recall\"",
      "",
    ].join("\n"), "utf8");

    const plan = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, undefined, localTransport, {
      forceConflict: true,
      installationType: "local",
    });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: Codex MCP server content differs or is missing for amf-interactive-recall",
    }]);
  });

  it("repairs incomplete legacy Codex merge ownership without rewriting the TOML", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "legacy-amf");
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "model = \"gpt-test\"\n", "utf8");
    await mergeCodexTomlMcp(legacy.sourcePath, configPath);

    const initial = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, undefined, localTransport, {
      installationType: "local",
    });
    expect(initial.operations).toMatchObject([{ action: "update", mergeRemoval: { mcpServers: {} } }]);
    await applyCombinedInstallPlan(initial);
    const incompleteManifest = await readInstallManifest(targetRoot, codexAdapter.name);
    if (!incompleteManifest) throw new Error("expected incomplete Codex manifest");
    expect((await createOwnershipUninstallPlan(incompleteManifest, [], codexAdapter)).operations).toMatchObject([{
      action: "keep",
      reason: "legacy merge ownership is incomplete; preserving destination and releasing management",
    }]);

    const beforeRepair = await readFile(configPath, "utf8");
    const repair = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, incompleteManifest, localTransport, {
      forceConflict: true,
      installationType: "local",
    });
    expect(repair.hasBlockingChanges).toBe(false);
    expect(repair.operations).toMatchObject([{
      action: "skip",
      reason: "force repairing exact incomplete merge ownership",
      mergeRemoval: JSON.parse(await readFile(legacy.sourcePath, "utf8")),
    }]);
    await applyCombinedInstallPlan(repair);
    expect(await readFile(configPath, "utf8")).toBe(beforeRepair);

    const repairedManifest = await readInstallManifest(targetRoot, codexAdapter.name);
    if (!repairedManifest) throw new Error("expected repaired Codex manifest");
    expect(repairedManifest.entries[0]?.mergeRemoval).toEqual(JSON.parse(await readFile(legacy.sourcePath, "utf8")));
    await uninstall(await createOwnershipUninstallPlan(repairedManifest, [], codexAdapter));
    expect(await readFile(configPath, "utf8")).toBe("model = \"gpt-test\"\n");
  });

  it.each([
    ["missing block", (content: string) => content.replace(/\[mcp_servers\.amf-interactive-recall][\s\S]*$/, "")],
    ["extra arg", (content: string) => content.replace('args = ["--stdio", "--safe"]', 'args = ["--stdio", "--safe", "--extra"]')],
    ["reordered args", (content: string) => content.replace('args = ["--stdio", "--safe"]', 'args = ["--safe", "--stdio"]')],
    ["different env", (content: string) => content.replace('HANDOFF_DIR = "/etc/amf-interactive-recall"', 'HANDOFF_DIR = "/tmp/different"')],
    ["extra field", (content: string) => content.replace('command = "expected-command"', 'command = "expected-command"\nextra = true')],
  ])("rejects Codex MCP adoption with %s", async (_label, alterCurrent) => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const legacy = await writeMcpArtifact(sourceRoot, "legacy.json", "amf-interactive-recall", "expected-command");
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "model = \"gpt-test\"\n", "utf8");
    await mergeCodexTomlMcp(legacy.sourcePath, configPath);
    await writeFile(configPath, alterCurrent(await readFile(configPath, "utf8")), "utf8");
    const before = await readFile(configPath, "utf8");

    const plan = await createCombinedInstallPlan([legacy], codexAdapter, targetRoot, undefined, localTransport, {
      forceConflict: true,
      installationType: "local",
    });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: Codex MCP server content differs or is missing for amf-interactive-recall",
    }]);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readInstallManifest(targetRoot, codexAdapter.name)).toBeUndefined();
  });

  it("rejects all Codex MCP adoption when one of multiple selected servers differs", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const contribution = await writeMcpArtifact(sourceRoot, "multi.json", "first", "first-command");
    const source = JSON.parse(await readFile(contribution.sourcePath, "utf8"));
    source.mcpServers.second = { command: "second-command", args: [], env: {} };
    await writeFile(contribution.sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const desired = { ...contribution, hash: await hashPath(contribution.sourcePath) };
    const configPath = join(targetRoot, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "model = \"gpt-test\"\n", "utf8");
    await mergeCodexTomlMcp(desired.sourcePath, configPath);
    await writeFile(configPath, (await readFile(configPath, "utf8")).replace('command = "second-command"', 'command = "different-command"'), "utf8");
    const before = await readFile(configPath, "utf8");

    const plan = await createCombinedInstallPlan([desired], codexAdapter, targetRoot, undefined, localTransport, {
      forceConflict: true,
      installationType: "local",
    });
    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{
      action: "conflict",
      reason: "cannot adopt merged contribution: Codex MCP server content differs or is missing for second",
    }]);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readInstallManifest(targetRoot, codexAdapter.name)).toBeUndefined();
  });
});
