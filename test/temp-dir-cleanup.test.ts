import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { createGraphSourcePlan } from "../src/lifecycle/source-plan.js";
import { resolveDependencyGraph } from "../src/resolve/graph.js";
import { renderGraphForTarget } from "../src/resolve/render.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];
const originalTmpdir = process.env.TMPDIR;

afterEach(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function isolatedTmpdir(): Promise<{ workspace: string; scratch: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "agentwheel-temp-cleanup-"));
  tempRoots.push(workspace);
  const scratch = join(workspace, "tmp");
  await mkdir(scratch);
  process.env.TMPDIR = scratch;
  return { workspace, scratch };
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeOpenPack(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeText(join(root, "openpack.json"), `${JSON.stringify({ schemaVersion: 2, version: "1.0.0", ...manifest }, null, 2)}\n`);
}

async function rootWithDependency(workspace: string, rootRule = "# Root\n"): Promise<string> {
  const root = join(workspace, "root");
  const dep = join(workspace, "dep");
  await writeText(join(root, "rules", "root.md"), rootRule);
  await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
  await writeOpenPack(dep, { name: "acme/dep", provides: [{ type: "rules", path: "rules" }] });
  await writeOpenPack(root, {
    name: "acme/root",
    requires: { dep: { source: "../dep", select: ["rules/dep.md"] } },
    provides: [{ type: "rules", path: "rules" }],
  });
  return root;
}

describe("temporary staging directories", () => {
  it("stages every graph node under the rendered bundle root", async () => {
    const { workspace, scratch } = await isolatedTmpdir();
    const root = await rootWithDependency(workspace);

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    expect(await readdir(scratch)).toEqual([]);

    const bundle = await renderGraphForTarget(graph, { workspaceRoot: workspace, adapter: openClawAdapter });
    expect(await readdir(scratch)).toEqual([basename(bundle.root)]);
    expect(bundle.artifacts.map((artifact) => artifact.name).sort()).toEqual(["dep.md", "root.md"]);
    for (const artifact of bundle.artifacts) {
      expect(artifact.stagedPath?.startsWith(`${bundle.root}/`)).toBe(true);
    }

    await rm(bundle.root, { recursive: true, force: true });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("removes the render root when rendering fails", async () => {
    const { workspace, scratch } = await isolatedTmpdir();
    const root = await rootWithDependency(workspace, "# Root\n\n<!-- openpack:include fragments/missing.md -->\n");

    await expect(createGraphSourcePlan({
      roots: [{ rootId: "main", source: root }],
      targetRoot: join(workspace, "target"),
      workspaceRoot: workspace,
      adapter: claudeAdapter,
      targetKey: "temp-cleanup",
      yes: true,
    })).rejects.toThrow(/OpenPack include not found/);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("keeps a single-source stage to its bundle root and removes it when rendering fails", async () => {
    const { workspace, scratch } = await isolatedTmpdir();
    const root = await rootWithDependency(workspace);
    const driver = new LocalSourceDriver();

    const bundle = await stageSource(driver, root, { cacheRoot: join(workspace, "cache") });
    expect(await readdir(scratch)).toEqual([basename(bundle.root)]);
    await rm(bundle.root, { recursive: true, force: true });

    await writeText(join(root, "rules", "root.md"), "# Root\n\n<!-- openpack:include fragments/missing.md -->\n");
    await expect(stageSource(driver, root, { cacheRoot: join(workspace, "cache") })).rejects.toThrow(/OpenPack include not found/);
    expect(await readdir(scratch)).toEqual([]);
  });
});
