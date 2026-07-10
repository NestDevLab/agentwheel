import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import type { AdapterConfig } from "../src/model/adapter.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-adapter-target-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeOpenPack(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeJson(join(root, "openpack.json"), {
    schemaVersion: 2,
    version: "1.0.0",
    ...manifest,
  });
}

async function writeFixturePackage(root: string, provides: Record<string, unknown>[] = [
  { type: "skills", path: "skills" },
  { type: "subagents", path: "subagents" },
]): Promise<void> {
  await writeText(join(root, "skills", "tool", "SKILL.md"), "---\nname: tool\ndescription: Fixture tool.\n---\n\n# Tool\n");
  await writeText(join(root, "subagents", "helper", "AGENTS.md"), "# Helper\n");
  await writeOpenPack(root, {
    name: "adapter-target/fixture",
    provides,
  });
}

function openClawAdapterWithTargets(targets: AdapterConfig["targets"]): AdapterConfig {
  return {
    name: "openclaw",
    targets,
  };
}

const openClawWithoutSubagents = openClawAdapterWithTargets({
  skills: {
    user: { enabled: true, root: "home", dest: ".openclaw/skills" },
  },
});

const openClawWithDisabledSubagents = openClawAdapterWithTargets({
  skills: {
    user: { enabled: true, root: "home", dest: ".openclaw/skills" },
  },
  subagents: {
    user: { enabled: false, root: "home", dest: ".openclaw/workspace-subagents", semantic: "openclaw-subagent" },
  },
});

const openClawWithSubagentsElsewhere = openClawAdapterWithTargets({
  skills: {
    user: { enabled: true, root: "home", dest: ".openclaw/skills" },
  },
  subagents: {
    profile: { enabled: true, root: "home", dest: ".openclaw/workspace-subagents", semantic: "openclaw-subagent" },
  },
});

const openClawWithSubagents = openClawAdapterWithTargets({
  subagents: {
    user: { enabled: true, root: "home", dest: ".openclaw/workspace-subagents", semantic: "openclaw-subagent" },
  },
});

describe("adapter target graceful skip", () => {
  it("skips selected artifacts whose adapter target is missing while keeping installable artifacts", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-adapter-target-target-");
    const root = join(workspace, "root");
    const warnings: string[] = [];
    await writeFixturePackage(root);

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/tool", "subagents/helper"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawWithoutSubagents,
      installationType: "user",
      targetKey: "missing-subagents",
      yes: true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      "skip subagents/helper (selected but adapter-target-unsupported: openclaw/user has no enabled target for subagents)",
    ]);
    expect(result.desiredArtifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/tool"]);
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toEqual([".openclaw/skills/tool"]);
  });

  it("skips selected artifacts whose adapter target is disabled", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-adapter-target-target-");
    const root = join(workspace, "root");
    const warnings: string[] = [];
    await writeFixturePackage(root);

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/tool", "subagents/helper"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawWithDisabledSubagents,
      installationType: "user",
      targetKey: "disabled-subagents",
      yes: true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      "skip subagents/helper (selected but adapter-target-disabled: openclaw/user disables subagents)",
    ]);
    expect(result.desiredArtifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/tool"]);
    expect(result.plan.operations.map((operation) => operation.artifactType)).toEqual(["skills"]);
  });

  it("mentions supported installation types when the target exists elsewhere", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-adapter-target-target-");
    const root = join(workspace, "root");
    const warnings: string[] = [];
    await writeFixturePackage(root);

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["skills/tool", "subagents/helper"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawWithSubagentsElsewhere,
      installationType: "user",
      targetKey: "other-installation-type",
      yes: true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      "skip subagents/helper (selected but adapter-target-unsupported: openclaw/user has no enabled target for subagents; supported installation types: profile)",
    ]);
    expect(result.desiredArtifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["skills/tool"]);
  });

  it("throws when every selected non-fragment artifact is skipped", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-adapter-target-target-");
    const root = join(workspace, "root");
    const warnings: string[] = [];
    await writeFixturePackage(root, [{ type: "subagents", path: "subagents" }]);

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["subagents/helper"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawWithoutSubagents,
      installationType: "user",
      targetKey: "all-skipped",
      yes: true,
      warn: (message) => warnings.push(message),
    })).rejects.toThrow(/No installable artifacts remain for adapter openclaw\/user after skipping unsupported targets: subagents\/helper/);

    expect(warnings).toEqual([
      "skip subagents/helper (selected but adapter-target-unsupported: openclaw/user has no enabled target for subagents)",
    ]);
  });

  it("keeps OpenClaw subagents when the adapter target is enabled", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot("agentwheel-adapter-target-target-");
    const root = join(workspace, "root");
    const warnings: string[] = [];
    await writeFixturePackage(root, [{ type: "subagents", path: "subagents" }]);

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root, select: ["subagents/helper"] }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: openClawWithSubagents,
      installationType: "user",
      targetKey: "enabled-subagents",
      yes: true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(result.desiredArtifacts.map((artifact) => `${artifact.type}/${artifact.name}`)).toEqual(["subagents/helper"]);
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toEqual([
      ".openclaw/workspace-subagents/helper",
    ]);
  });
});
