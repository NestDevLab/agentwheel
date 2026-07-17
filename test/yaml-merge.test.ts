import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { applyCombinedInstallPlan, createCombinedInstallPlan, createOwnershipUninstallPlan, readInstallManifest, uninstall, type DesiredArtifact } from "../src/install/index.js";
import { mergeYamlFile } from "../src/install/yaml-merge.js";
import { targetMappingSchema, type AdapterConfig } from "../src/model/adapter.js";
import type { ArtifactType } from "../src/model/artifact.js";
import { manifestEntrySchema } from "../src/model/manifest.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-yaml-merge-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("YAML deep merge", () => {
  it("deep-merges YAML objects and dedupes arrays", async () => {
    const root = await tempRoot();
    const source = join(root, "source.yaml");
    const dest = join(root, "nested", "dest.yaml");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(source, [
      "features:",
      "  managed: true",
      "  nested:",
      "    source: yes",
      "order:",
      "  - user",
      "  - managed",
      "scalar: source",
      "",
    ].join("\n"), "utf8");
    await writeFile(dest, [
      "features:",
      "  user: true",
      "  nested:",
      "    existing: yes",
      "order:",
      "  - user",
      "scalar: existing",
      "",
    ].join("\n"), "utf8");

    await mergeYamlFile(source, dest);

    const merged = parse(await readFile(dest, "utf8"));
    expect(merged).toEqual({
      features: {
        user: true,
        managed: true,
        nested: {
          existing: "yes",
          source: "yes",
        },
      },
      order: ["user", "managed"],
      scalar: "source",
    });
  });

  it("wires yaml-deep through adapter schema, install planning, apply, and manifest entries", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const sourcePath = join(sourceRoot, "settings.yaml");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, [
      "settings:",
      "  managed: true",
      "plugins:",
      "  - managed",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(targetRoot, "settings.yaml"), [
      "settings:",
      "  user: true",
      "plugins:",
      "  - user",
      "",
    ].join("\n"), "utf8");

    const adapter: AdapterConfig = {
      name: "yaml-runtime",
      targets: {
        settings: { local: targetMappingSchema.parse({ enabled: true, dest: "settings.yaml", merge: "yaml-deep" }) },
      },
    };
    const artifact = await desiredArtifact("settings", "settings.yaml", sourcePath);
    const plan = await createCombinedInstallPlan([artifact], adapter, targetRoot);
    expect(plan.operations[0]?.mergeStrategy).toBe("yaml-deep");

    await applyCombinedInstallPlan(plan);

    const merged = parse(await readFile(join(targetRoot, "settings.yaml"), "utf8"));
    expect(merged).toEqual({
      settings: {
        user: true,
        managed: true,
      },
      plugins: ["user", "managed"],
    });
    const manifest = await readInstallManifest(targetRoot, adapter.name);
    const entry = manifest?.entries[0];
    expect(entry?.mergeStrategy).toBe("yaml-deep");
    if (!entry) throw new Error("expected manifest entry");
    expect(manifestEntrySchema.parse(entry).mergeStrategy).toBe("yaml-deep");
  });

  it("uninstalls an owned YAML MCP contribution without deleting the surrounding config", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const sourcePath = join(sourceRoot, "telegram-hermes.yaml");
    await writeFile(sourcePath, "mcp_servers:\n  telegram:\n    command: telegram-mcp\n", "utf8");
    await writeFile(join(targetRoot, "config.yaml"), "identity:\n  name: Hermes\ndelegation:\n  enabled: true\nmcp_servers:\n  user_server:\n    command: user-mcp\n", "utf8");
    const adapter: AdapterConfig = { name: "yaml-mcp-runtime", targets: { mcp: { local: targetMappingSchema.parse({ enabled: true, dest: "config.yaml", merge: "yaml-deep" }) } } };
    await applyCombinedInstallPlan(await createCombinedInstallPlan([await desiredArtifact("mcp", "telegram-hermes.yaml", sourcePath)], adapter, targetRoot));
    const manifest = await readInstallManifest(targetRoot, adapter.name);
    if (!manifest) throw new Error("expected install manifest");
    const uninstallPlan = await createOwnershipUninstallPlan(manifest, [], adapter);
    expect(uninstallPlan.operations).toMatchObject([{ action: "remove", mergeStrategy: "yaml-deep", mergeRemoval: { mcp_servers: { telegram: { command: "telegram-mcp" } } } }]);
    expect(uninstallPlan.operations[0]?.reason).toBe("remove managed merge contribution; preserving merge destination");
    await uninstall(uninstallPlan);
    expect(parse(await readFile(join(targetRoot, "config.yaml"), "utf8"))).toEqual({ identity: { name: "Hermes" }, delegation: { enabled: true }, mcp_servers: { user_server: { command: "user-mcp" } } });
    expect(await readInstallManifest(targetRoot, adapter.name)).toBeUndefined();
  });

  it("keeps legacy merge destinations when the manifest has no removal metadata", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const sourcePath = join(sourceRoot, "telegram-hermes.yaml");
    await writeFile(sourcePath, "mcp_servers:\n  telegram:\n    command: telegram-mcp\n", "utf8");
    await writeFile(join(targetRoot, "config.yaml"), "delegation:\n  enabled: true\n", "utf8");
    const adapter: AdapterConfig = { name: "yaml-legacy-runtime", targets: { mcp: { local: targetMappingSchema.parse({ enabled: true, dest: "config.yaml", merge: "yaml-deep" }) } } };
    await applyCombinedInstallPlan(await createCombinedInstallPlan([await desiredArtifact("mcp", "telegram-hermes.yaml", sourcePath)], adapter, targetRoot));
    const manifest = await readInstallManifest(targetRoot, adapter.name);
    if (!manifest) throw new Error("expected install manifest");
    const legacyManifest = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    delete legacyManifest.entries[0]?.mergeRemoval;
    const uninstallPlan = await createOwnershipUninstallPlan(legacyManifest, [], adapter);
    expect(uninstallPlan.operations).toMatchObject([{ action: "keep", reason: "legacy merge ownership is incomplete; preserving destination and releasing management" }]);
    await uninstall(uninstallPlan);
    expect(await readFile(join(targetRoot, "config.yaml"), "utf8")).toContain("telegram-mcp");
  });

  it("accepts forward-looking plugin and managed-block schema values", () => {
    expect(targetMappingSchema.parse({ enabled: true, dest: "plugin", semantic: "claude-plugin" }).semantic).toBe("claude-plugin");
    expect(targetMappingSchema.parse({ enabled: true, dest: "plugin", semantic: "codex-plugin" }).semantic).toBe("codex-plugin");
    expect(targetMappingSchema.parse({ enabled: true, dest: "plugin", semantic: "hermes-plugin" }).semantic).toBe("hermes-plugin");
    expect(targetMappingSchema.parse({ enabled: true, dest: "plugin", semantic: "copilot-plugin" }).semantic).toBe("copilot-plugin");
    const managedBlock = targetMappingSchema.parse({ enabled: true, dest: "AGENTS.md", mode: "managed-block" });
    expect(managedBlock.merge).toBeUndefined();
    expect(managedBlock.mode).toBe("managed-block");
  });
});

async function desiredArtifact(type: ArtifactType, name: string, sourcePath: string): Promise<DesiredArtifact> {
  return {
    type,
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: name,
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: {
      logicalSelector: `${type}/${name}`,
      dependencyRole: "root",
      owners: ["root"],
    },
  };
}
