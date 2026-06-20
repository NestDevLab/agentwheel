import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { createCombinedInstallPlan, type DesiredArtifact } from "../src/install/index.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import type { ArtifactFormat, ArtifactType, FileKind } from "../src/model/artifact.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-p1-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("P1 validation guardrails", () => {
  it("skips Codex-incompatible behavioral rules only when another artifact remains installable", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const skill = await desiredArtifact(source, "skills", "smoke", "dir");
    const rule = await desiredArtifact(source, "rules", "behavior.md");
    const adapter = codexAdapterWithoutRules();
    const warnings: string[] = [];

    const plan = await createCombinedInstallPlan([skill, rule], adapter, target, undefined, localTransport, {
      installationType: "local",
      warn: (message) => warnings.push(message),
    });

    expect(plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".agents/skills/smoke"]);
    expect(warnings.join("\n")).toMatch(/skip rules\/behavior\.md .*target does not support behavioral Markdown rules/);

    await expect(createCombinedInstallPlan([rule], adapter, target, undefined, localTransport, {
      installationType: "local",
    })).rejects.toThrow(/does not support rules artifacts/);
  });

  it("filters non-behavioral rule artifacts before graph desired artifacts and locks", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-p1-target-");
    const root = join(workspace, "root");

    await writeText(join(root, "skills", "smoke", "SKILL.md"), [
      "---",
      "name: smoke",
      "description: Smoke skill.",
      "---",
      "",
      "# Smoke",
      "",
    ].join("\n"));
    await writeText(join(root, "rules", "policy.rules"), [
      "prefix_rule(",
      "    pattern = [\"gh\", \"pr\", \"view\"],",
      "    decision = \"prompt\",",
      "    justification = \"Viewing PRs is allowed with approval\",",
      ")",
      "",
    ].join("\n"));
    await writeOpenPack(root, {
      name: "p1/root",
      provides: [
        { type: "skills", path: "skills" },
        { type: "rules", path: "rules" },
      ],
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: codexAdapterWithoutRules(),
      targetKey: "p1-guardrails",
      isTTY: false,
    });

    expect(result.desiredArtifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/smoke"]);
    expect(result.bundle.graphLock.canonical.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/smoke"]);
    expect(result.warnings.join("\n")).toMatch(/skip rules\/policy\.rules .*format-incompatible/);
  });

  it("rejects yaml-deep merge sources that are invalid YAML or not objects", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const adapter: AdapterConfig = {
      name: "yaml-runtime",
      targets: {
        settings: {
          local: { enabled: true, dest: "settings.yaml", merge: "yaml-deep" },
        },
      },
    };

    const invalidYaml = await desiredArtifact(source, "settings", "invalid.yaml", "file", undefined, "settings:\n  - [\n");
    await expect(createCombinedInstallPlan([invalidYaml], adapter, target))
      .rejects.toThrow(/merge artifact must be valid YAML/);

    const arrayYaml = await desiredArtifact(source, "settings", "array.yaml", "file", undefined, "- one\n");
    await expect(createCombinedInstallPlan([arrayYaml], adapter, target))
      .rejects.toThrow(/merge artifacts must contain a YAML object/);
  });

  it("requires plugin artifacts to match the target harness plugin format", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    const adapter: AdapterConfig = {
      name: "codex-plugin-runtime",
      targets: {
        plugins: {
          local: { enabled: true, dest: "plugins", semantic: "codex-plugin" },
        },
      },
    };
    const plugin = await desiredArtifact(source, "plugins", "demo", "dir", "claude-plugin");

    await expect(createCombinedInstallPlan([plugin], adapter, target))
      .rejects.toThrow(/format 'claude-plugin' is not compatible; expected one of: codex-plugin/);

    const matching = { ...plugin, format: "codex-plugin" as ArtifactFormat };
    const plan = await createCombinedInstallPlan([matching], adapter, target);
    expect(plan.operations.map((operation) => operation.relativeDestPath)).toEqual(["plugins/demo"]);
  });
});

async function desiredArtifact(
  root: string,
  type: ArtifactType,
  name: string,
  kind: FileKind = "file",
  format?: ArtifactFormat,
  content?: string,
): Promise<DesiredArtifact> {
  const sourcePath = join(root, type, name);
  if (kind === "dir") {
    await mkdir(sourcePath, { recursive: true });
    const fileName = type === "skills" ? "SKILL.md" : "AGENTS.md";
    const body = type === "skills"
      ? `---\nname: ${name}\ndescription: Fixture skill for tests.\n---\n\n# ${name}\n`
      : `# ${name}\n`;
    await writeFile(join(sourcePath, fileName), body, "utf8");
  } else {
    await writeText(sourcePath, content ?? `# ${name}\n`);
  }

  return {
    type,
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: join(type, name),
    kind,
    hash: await hashPath(sourcePath),
    format,
    channel: "managed",
    meta: {
      logicalSelector: `${type}/${name}`,
      dependencyRole: "root",
      owners: ["p1-test"],
    },
  };
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeOpenPack(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeText(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    version: "1.0.0",
    ...manifest,
  }, null, 2)}\n`);
}

function codexAdapterWithoutRules(): AdapterConfig {
  const targets = { ...codexAdapter.targets };
  delete targets.rules;
  return { ...codexAdapter, targets };
}
