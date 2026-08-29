import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import { readPackageManifest } from "../src/model/package.js";
import { validatePackage } from "../src/model/package-validate.js";
import { writeWorkspaceConfig } from "../src/model/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  roots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-openpack-v3-"));
  roots.push(root);
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

describe("OpenPack v3", () => {
  it("rejects v3-only fields in a v2 manifest", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 2,
      name: "test/invalid-v2",
      version: "1.0.0",
      compositionRules: [{ target: "skills/*", include: "fragments/evolution.md" }],
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await expect(readPackageManifest(root)).rejects.toThrow(/schemaVersion 3 is required for compositionRules/);
  });

  it("rejects supersedes declarations for a different artifact selector", async () => {
    const root = await tempRoot();
    await writeText(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Invalid replacement.\n---\n");
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 3,
      name: "test/invalid-supersedes",
      version: "1.0.0",
      provides: [{
        type: "skills",
        path: "skills",
        items: { demo: { supersedes: [{ package: "vendor/upstream", selector: "skills/other", reason: "invalid" }] } },
      }],
    });
    const result = await validatePackage(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.message).join("\n")).toMatch(/selector must equal skills\/demo/);
  });

  it("composes a fragment into skills from another package", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot();
    const policy = join(workspace, "policy");
    const thirdParty = join(workspace, "third-party");
    await writeText(join(policy, "fragments", "evolution.md"), "## Evolution\n\nImprove at the source.\n");
    await writeText(join(thirdParty, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demonstrate cross-package composition.\n---\n\n# Demo\n");
    await writeJson(join(thirdParty, "openpack.json"), {
      schemaVersion: 2,
      name: "vendor/third-party",
      version: "1.0.0",
      provides: [{ type: "skills", path: "skills" }],
    });
    await writeJson(join(policy, "openpack.json"), {
      schemaVersion: 3,
      name: "test/policy",
      version: "1.0.0",
      requires: { vendor: { source: "../third-party", select: ["skills/demo"] } },
      compositionRules: [{ target: "skills/*", include: "fragments/evolution.md" }],
      provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { allow: ["local:*"] },
      packages: [],
      profiles: {},
      agents: {},
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "policy", source: policy }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "openpack-v3-compose",
      yes: true,
    });
    const demo = result.bundle.artifacts.find((artifact) => artifact.type === "skills" && artifact.name === "demo");
    expect(demo?.composedFrom?.some((entry) => entry.selector.includes(":fragments/evolution.md"))).toBe(true);
    expect(await readFile(join(demo!.stagedPath!, "SKILL.md"), "utf8")).toContain("Improve at the source.");
  });

  it("lets a root composition rule include a fragment through a dependency alias", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot();
    const root = join(workspace, "root");
    const core = join(workspace, "core");
    const vendor = join(workspace, "vendor");
    await writeText(join(core, "fragments", "evolution.md"), "## Evolution\n\nAlias fragment.\n");
    await writeText(join(vendor, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Alias composition target.\n---\n\n# Demo\n");
    await writeJson(join(core, "openpack.json"), {
      schemaVersion: 2, name: "test/core", version: "1.0.0", provides: [{ type: "fragments", path: "fragments" }],
    });
    await writeJson(join(vendor, "openpack.json"), {
      schemaVersion: 2, name: "test/vendor", version: "1.0.0", provides: [{ type: "skills", path: "skills" }],
    });
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 3,
      name: "test/root",
      version: "1.0.0",
      requires: {
        core: { source: "../core", select: ["fragments/evolution.md"] },
        vendor: { source: "../vendor", select: ["skills/demo"] },
      },
      compositionRules: [{ target: "skills/*", include: "core:fragments/evolution.md" }],
      provides: [],
    });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1, registry: {}, trust: { allow: ["local:*"] }, packages: [], profiles: {}, agents: {},
    });
    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }], targetRoot: target, workspaceRoot: workspace,
      adapter: claudeAdapter, targetKey: "openpack-v3-alias", yes: true,
    });
    const demo = result.bundle.artifacts.find((artifact) => artifact.type === "skills" && artifact.name === "demo");
    expect(await readFile(join(demo!.stagedPath!, "SKILL.md"), "utf8")).toContain("Alias fragment.");
  });

  it("lets one declared derivative supersede a colliding direct dependency", async () => {
    const workspace = await tempRoot();
    const target = await tempRoot();
    const root = join(workspace, "root");
    const upstream = join(workspace, "upstream");
    const derivative = join(workspace, "derivative");
    await writeText(join(upstream, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Upstream demo.\n---\n\n# Upstream\n");
    await writeText(join(derivative, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Governed derivative demo.\n---\n\n# Derivative\n");
    await writeJson(join(upstream, "openpack.json"), {
      schemaVersion: 2,
      name: "vendor/upstream",
      version: "1.0.0",
      provides: [{ type: "skills", path: "skills" }],
    });
    await writeJson(join(derivative, "openpack.json"), {
      schemaVersion: 3,
      name: "test/derivative",
      version: "1.0.0",
      provides: [{
        type: "skills",
        path: "skills",
        items: { demo: { supersedes: [{ package: "vendor/upstream", selector: "skills/demo", reason: "governed derivative" }] } },
      }],
    });
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 2,
      name: "test/root",
      version: "1.0.0",
      requires: {
        upstream: { source: "../upstream", select: ["skills/demo"] },
        derivative: { source: "../derivative", select: ["skills/demo"] },
      },
      provides: [],
    });
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      registry: {},
      trust: { allow: ["local:*"] },
      packages: [],
      profiles: {},
      agents: {},
    });

    const result = await createGraphSourcePlan({
      roots: [{ rootId: "root", source: root }],
      targetRoot: target,
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "openpack-v3-supersedes",
      yes: true,
    });
    const demos = result.bundle.artifacts.filter((artifact) => artifact.type === "skills" && artifact.name === "demo");
    expect(demos).toHaveLength(1);
    expect(demos[0]?.packageName).toBe("test/derivative");
  });
});
