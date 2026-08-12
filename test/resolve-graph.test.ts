import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { canonicalGraphLockJson } from "../src/model/graph-lock.js";
import { RegistryClient } from "../src/registry/client.js";
import { createGraphLock, resolveDependencyGraph } from "../src/resolve/graph.js";
import { renderGraphForTarget } from "../src/resolve/render.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-resolve-graph-"): Promise<string> {
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

describe("dependency graph resolver", () => {
  it("recursively resolves local fixture package requires", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
    await writeOpenPack(dep, {
      name: "acme/dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        dep: { source: "../dep", select: ["rules/dep.md"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    const bundle = await renderGraphForTarget(graph, { workspaceRoot: workspace, adapter: openClawAdapter });

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["acme/dep", "acme/root"]);
    expect(graph.edges).toHaveLength(1);
    expect(bundle.artifacts.map((artifact) => `${artifact.dependencyRole}:${artifact.type}/${artifact.name}`).sort()).toEqual([
      "direct:rules/dep.md",
      "root:rules/root.md",
    ]);
  });

  it("keeps suggested packages out of the graph unless suggestions are requested", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
    await writeOpenPack(dep, {
      name: "acme/dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "acme/root",
      suggests: {
        brainstorm: {
          source: "../dep",
          select: ["rules/dep.md"],
          reason: "Try a companion rule before converging.",
        },
      },
      provides: [
        {
          type: "rules",
          path: "rules",
          items: {
            "root.md": { suggests: ["brainstorm"] },
          },
        },
      ],
    });

    const withoutSuggestions = await resolveDependencyGraph([
      { rootId: "main", source: root, select: ["rules/root.md"] },
    ], { workspaceRoot: workspace });
    expect(withoutSuggestions.nodes.map((node) => node.name)).toEqual(["acme/root"]);

    const withSuggestions = await resolveDependencyGraph([
      { rootId: "main", source: root, select: ["rules/root.md"], includeSuggestions: true },
    ], { workspaceRoot: workspace });
    const depNode = withSuggestions.nodes.find((node) => node.name === "acme/dep");
    expect(withSuggestions.nodes.map((node) => node.name).sort()).toEqual(["acme/dep", "acme/root"]);
    expect(depNode?.selected).toEqual(["rules/dep.md"]);
    expect(depNode?.selectionReasons?.["rules/dep.md"]).toEqual(["suggested by rules/root.md"]);
    expect(withSuggestions.edges).toMatchObject([{ alias: "brainstorm", optional: true, selected: ["rules/dep.md"] }]);

    const withExplicitSuggestion = await resolveDependencyGraph([
      { rootId: "main", source: root, select: ["rules/root.md"], suggestionAliases: ["brainstorm"] },
    ], { workspaceRoot: workspace });
    expect(withExplicitSuggestion.nodes.map((node) => node.name).sort()).toEqual(["acme/dep", "acme/root"]);
    expect(withExplicitSuggestion.edges).toMatchObject([{ alias: "brainstorm", optional: false }]);
  });

  it("resolves root meta-packages that select local dependency artifacts", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const depA = join(workspace, "dep-a");
    const depB = join(workspace, "dep-b");
    await writeText(join(depA, "rules", "a.md"), "# A\n");
    await writeText(join(depB, "rules", "b.md"), "# B\n");
    await writeOpenPack(depA, {
      name: "acme/dep-a",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(depB, {
      name: "acme/dep-b",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "acme/meta-root",
      requires: {
        a: { source: "../dep-a", select: ["rules/a.md"] },
        b: { source: "../dep-b", select: ["rules/b.md"] },
      },
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    const depANode = graph.nodes.find((node) => node.name === "acme/dep-a");
    const depBNode = graph.nodes.find((node) => node.name === "acme/dep-b");
    const rootNode = graph.nodes.find((node) => node.name === "acme/meta-root");

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["acme/dep-a", "acme/dep-b", "acme/meta-root"]);
    expect(depANode?.selected).toEqual(["rules/a.md"]);
    expect(depBNode?.selected).toEqual(["rules/b.md"]);
    expect(rootNode?.selected).toEqual([]);
  });

  it("resolves meta-packages used as transitive dependencies", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const meta = join(workspace, "meta");
    const leaf = join(workspace, "leaf");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(leaf, "rules", "leaf.md"), "# Leaf\n");
    await writeOpenPack(leaf, {
      name: "acme/leaf",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(meta, {
      name: "acme/meta",
      requires: {
        leaf: { source: "../leaf", select: ["rules/leaf.md"] },
      },
    });
    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        meta: { source: "../meta" },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    const bundle = await renderGraphForTarget(graph, { workspaceRoot: workspace, adapter: openClawAdapter });
    const leafNode = graph.nodes.find((node) => node.name === "acme/leaf");
    const metaNode = graph.nodes.find((node) => node.name === "acme/meta");

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["acme/leaf", "acme/meta", "acme/root"]);
    expect(leafNode?.selected).toEqual(["rules/leaf.md"]);
    expect(metaNode?.selected).toEqual([]);
    expect(bundle.artifacts.map((artifact) => `${artifact.type}/${artifact.name}`).sort()).toEqual(["rules/leaf.md", "rules/root.md"]);
  });

  it("resolves nested meta-packages that select leaf artifacts", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const meta = join(workspace, "meta");
    const leaf = join(workspace, "leaf");
    await writeText(join(leaf, "rules", "leaf.md"), "# Leaf\n");
    await writeOpenPack(leaf, {
      name: "acme/leaf",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(meta, {
      name: "acme/meta",
      requires: {
        leaf: { source: "../leaf", select: ["rules/leaf.md"] },
      },
    });
    await writeOpenPack(root, {
      name: "acme/meta-root",
      requires: {
        meta: { source: "../meta" },
      },
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    const leafNode = graph.nodes.find((node) => node.name === "acme/leaf");
    const metaNode = graph.nodes.find((node) => node.name === "acme/meta");
    const rootNode = graph.nodes.find((node) => node.name === "acme/meta-root");

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["acme/leaf", "acme/meta", "acme/meta-root"]);
    expect(leafNode?.selected).toEqual(["rules/leaf.md"]);
    expect(metaNode?.selected).toEqual([]);
    expect(rootNode?.selected).toEqual([]);
  });

  it("uses locked registry dependency nodes before refreshing registry entries", async () => {
    const workspace = await tempRoot();
    const registry = join(workspace, "registry.json");
    const cachePath = join(workspace, "registry-cache.json");
    const root = join(workspace, "root");
    const depV1 = join(workspace, "dep-v1");
    const depV2 = join(workspace, "dep-v2");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(depV1, "rules", "dep.md"), "# Dep v1\n");
    await writeText(join(depV2, "rules", "dep.md"), "# Dep v2\n");
    await writeOpenPack(depV1, { name: "acme/dep-v1", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(depV2, { name: "acme/dep-v2", provides: [{ type: "rules", path: "rules" }] });
    await writeOpenPack(root, {
      name: "acme/root-registry",
      requires: { dep: { source: "registry:dep", select: ["rules/dep.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeJson(registry, [{ name: "dep", source: depV1, type: "package", description: "dep", tags: [] }]);

    const first = await resolveDependencyGraph([{ rootId: "root", source: root }], {
      workspaceRoot: workspace,
      registryClient: new RegistryClient({ sources: [registry], cachePath, ttlMs: -1 }),
    });
    const lock = createGraphLock(first);
    expect(first.nodes.map((node) => node.name).sort()).toEqual(["acme/dep-v1", "acme/root-registry"]);

    await writeJson(registry, [{ name: "dep", source: depV2, type: "package", description: "dep", tags: [] }]);
    const locked = await resolveDependencyGraph([{ rootId: "root", source: root }], {
      workspaceRoot: workspace,
      previousLock: lock,
      lockedResolution: true,
      registryClient: new RegistryClient({ sources: [registry], cachePath, ttlMs: -1 }),
    });

    expect(locked.nodes.map((node) => node.name).sort()).toEqual(["acme/dep-v1", "acme/root-registry"]);
  });

  it("uses locked git refs without requiring a warm checkout", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "repo");
    await writeText(join(repo, "rules", "root.md"), "# Root v1\n");
    await writeOpenPack(repo, {
      name: "acme/git-root",
      provides: [{ type: "rules", path: "rules" }],
    });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const commit1 = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const first = await resolveDependencyGraph([{ rootId: "root", source: `git:${repo}#main`, mode: "tracking" }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(first);

    await writeText(join(repo, "rules", "root.md"), "# Root v2\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);

    const locked = await resolveDependencyGraph([{ rootId: "root", source: `git:${repo}#main`, mode: "tracking" }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-cold"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(locked.nodes).toHaveLength(1);
    expect(locked.nodes[0]?.resolvedCommit).toBe(commit1);
    expect(locked.nodes[0]?.sourceHash).toBe(lock.canonical.nodes[0]?.sourceHash);
  });

  it("falls back to fresh resolve when a soft lock has ambiguous source matches", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    await writeText(join(root, "rules", "root.md"), "# Root v1\n");
    await writeOpenPack(root, {
      name: "acme/ambiguous-root",
      provides: [{ type: "rules", path: "rules" }],
    });

    const first = await resolveDependencyGraph([{ rootId: "root", source: root }], { workspaceRoot: workspace });
    const lock = createGraphLock(first);
    const lockedNode = lock.canonical.nodes[0]!;
    lock.canonical.nodes.push({ ...lockedNode, id: `${lockedNode.id}:duplicate` });

    await writeText(join(root, "rules", "root.md"), "# Root v2\n");
    const fresh = await resolveDependencyGraph([{ rootId: "renamed", source: root }], {
      workspaceRoot: workspace,
      previousLock: lock,
      lockedResolution: true,
    });

    expect(fresh.nodes).toHaveLength(1);
    expect(fresh.nodes[0]?.sourceHash).not.toBe(lockedNode.sourceHash);
  });

  it("falls back to fresh resolve when a soft locked root source changes", async () => {
    const workspace = await tempRoot();
    const oldRoot = join(workspace, "old-root");
    const newRoot = join(workspace, "new-root");
    await writeText(join(oldRoot, "rules", "root.md"), "# Old Root\n");
    await writeOpenPack(oldRoot, {
      name: "acme/root",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeText(join(newRoot, "rules", "root.md"), "# New Root\n");
    await writeOpenPack(newRoot, {
      name: "acme/root",
      provides: [{ type: "rules", path: "rules" }],
    });

    const first = await resolveDependencyGraph([{ rootId: "root", source: oldRoot }], { workspaceRoot: workspace });
    const lock = createGraphLock(first);
    const oldNode = lock.canonical.nodes[0]!;
    await rm(oldRoot, { recursive: true, force: true });

    const fresh = await resolveDependencyGraph([{ rootId: "root", source: newRoot }], {
      workspaceRoot: workspace,
      previousLock: lock,
      lockedResolution: true,
    });
    const rewrittenLock = createGraphLock(fresh);

    expect(fresh.nodes).toHaveLength(1);
    expect(fresh.nodes[0]?.normalizedSource).toBe(`local:${newRoot}`);
    expect(fresh.nodes[0]?.sourceHash).not.toBe(oldNode.sourceHash);
    expect(rewrittenLock.canonical.nodes.some((node) => node.normalizedSource === oldNode.normalizedSource)).toBe(false);
  });

  it("refreshes a tracking dependency closure when a soft locked root source changes", async () => {
    const workspace = await tempRoot();
    const oldRoot = join(workspace, "old-root");
    const newRoot = join(workspace, "new-root");
    const depRepo = join(workspace, "dep-repo");
    await writeText(join(depRepo, "rules", "old.md"), "# Old Dependency\n");
    await writeOpenPack(depRepo, {
      name: "acme/tracking-dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await git(depRepo, ["init", "-b", "main"]);
    await git(depRepo, ["config", "user.name", "Test"]);
    await git(depRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v1"]);
    const commit1 = (await git(depRepo, ["rev-parse", "HEAD"])).trim();

    await writeOpenPack(oldRoot, {
      name: "acme/root",
      requires: {
        dep: { source: `git:${depRepo}#main`, mode: "tracking", select: ["rules/old.md"] },
      },
    });
    await writeOpenPack(newRoot, {
      name: "acme/root",
      requires: {
        dep: { source: `git:${depRepo}#main`, mode: "tracking", select: ["rules/new.md"] },
      },
    });

    const first = await resolveDependencyGraph([{ rootId: "root", source: oldRoot }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(first);
    expect(first.nodes.find((node) => node.name === "acme/tracking-dep")?.resolvedCommit).toBe(commit1);

    await writeText(join(depRepo, "rules", "new.md"), "# New Dependency\n");
    await writeOpenPack(depRepo, {
      name: "acme/tracking-dep",
      version: "1.1.0",
      provides: [{ type: "rules", path: "rules" }],
    });
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v2"]);
    const commit2 = (await git(depRepo, ["rev-parse", "HEAD"])).trim();

    const fresh = await resolveDependencyGraph([{ rootId: "root", source: newRoot }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });
    const depNode = fresh.nodes.find((node) => node.name === "acme/tracking-dep");

    expect(depNode?.resolvedCommit).toBe(commit2);
    expect(depNode?.version).toBe("1.1.0");
    expect(depNode?.selected).toEqual(["rules/new.md"]);
  });

  it("keeps frozen lock behavior when a locked root source changes", async () => {
    const workspace = await tempRoot();
    const oldRoot = join(workspace, "old-root");
    const newRoot = join(workspace, "new-root");
    await writeText(join(oldRoot, "rules", "root.md"), "# Old Root\n");
    await writeOpenPack(oldRoot, {
      name: "acme/root",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeText(join(newRoot, "rules", "root.md"), "# New Root\n");
    await writeOpenPack(newRoot, {
      name: "acme/root",
      provides: [{ type: "rules", path: "rules" }],
    });

    const first = await resolveDependencyGraph([{ rootId: "root", source: oldRoot }], { workspaceRoot: workspace });
    const lock = createGraphLock(first);

    await expect(resolveDependencyGraph([{ rootId: "root", source: newRoot }], {
      workspaceRoot: workspace,
      previousLock: lock,
      lockedResolution: true,
      frozenLock: true,
    })).rejects.toThrow(/Frozen lock root 'root' source differs from declared source/);
  });

  it("dedupes the same dependency required by two roots", async () => {
    const workspace = await tempRoot();
    const shared = join(workspace, "shared");
    const rootOne = join(workspace, "root-one");
    const rootTwo = join(workspace, "root-two");
    await writeText(join(shared, "rules", "shared.md"), "# Shared\n");
    await writeText(join(rootOne, "rules", "one.md"), "# One\n");
    await writeText(join(rootTwo, "rules", "two.md"), "# Two\n");
    await writeOpenPack(shared, {
      name: "acme/shared",
      provides: [{ type: "rules", path: "rules" }],
    });
    for (const [root, name] of [[rootOne, "acme/root-one"], [rootTwo, "acme/root-two"]] as const) {
      await writeOpenPack(root, {
        name,
        requires: {
          shared: { source: "../shared", select: ["rules/shared.md"] },
        },
        provides: [{ type: "rules", path: "rules" }],
      });
    }

    const graph = await resolveDependencyGraph([
      { rootId: "one", source: rootOne },
      { rootId: "two", source: rootTwo },
    ], { workspaceRoot: workspace });
    const sharedNode = graph.nodes.find((node) => node.name === "acme/shared");

    expect(graph.nodes.filter((node) => node.name === "acme/shared")).toHaveLength(1);
    expect(sharedNode?.requiredBy).toHaveLength(2);
    expect(sharedNode?.selected).toEqual(["rules/shared.md"]);
  });

  it("propagates dependency selections, required artifacts, and keeps fragments uninstalled", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "required.md"), "# Required\n");
    await writeText(join(dep, "rules", "optional.md"), "# Optional\n");
    await writeText(join(dep, "fragments", "shared.md"), "Shared Fragment\n");
    await writeText(join(dep, "skills", "selected", "SKILL.md"), "# Selected\n\n<!-- openpack:include fragments/shared.md -->\n");
    await writeOpenPack(dep, {
      name: "acme/dep",
      provides: [
        { type: "rules", path: "rules/required.md", required: true },
        { type: "rules", path: "rules/optional.md" },
        { type: "fragments", path: "fragments", required: true },
        { type: "skills", path: "skills" },
      ],
    });
    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        dep: { source: "../dep", select: ["skills/selected"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace });
    const depNode = graph.nodes.find((node) => node.name === "acme/dep");
    const bundle = await renderGraphForTarget(graph, { workspaceRoot: workspace, adapter: openClawAdapter });
    const depArtifacts = bundle.artifacts
      .filter((artifact) => artifact.graphNodeId === depNode?.id)
      .map((artifact) => `${artifact.type}/${artifact.name}`)
      .sort();
    const skill = bundle.artifacts.find((artifact) => artifact.graphNodeId === depNode?.id && artifact.type === "skills");

    expect(depNode?.selected).toEqual(["rules/required.md", "skills/selected"]);
    expect(depArtifacts).toEqual(["rules/required.md", "skills/selected"]);
    expect(skill?.stagedPath ? await readFile(join(skill.stagedPath, "SKILL.md"), "utf8") : "").toContain("Shared Fragment");
  });

  it("allows package cycles that add no unsatisfied selection", async () => {
    const workspace = await tempRoot();
    const a = join(workspace, "a");
    const b = join(workspace, "b");
    await writeText(join(a, "rules", "a.md"), "# A\n");
    await writeText(join(b, "rules", "b.md"), "# B\n");
    await writeOpenPack(a, {
      name: "acme/a",
      requires: { b: { source: "../b" } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(b, {
      name: "acme/b",
      requires: { a: { source: "../a", select: ["rules/a.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });

    const graph = await resolveDependencyGraph([{ rootId: "main", source: a }], { workspaceRoot: workspace });
    const aNode = graph.nodes.find((node) => node.name === "acme/a");

    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["acme/a", "acme/b"]);
    expect(aNode?.requiredBy.some((owner) => owner.startsWith("acme/b@"))).toBe(true);
  });

  it("fails package cycles that introduce an unsatisfied selection", async () => {
    const workspace = await tempRoot();
    const a = join(workspace, "a");
    const b = join(workspace, "b");
    await writeText(join(a, "rules", "a.md"), "# A\n");
    await writeText(join(b, "rules", "b.md"), "# B\n");
    await writeOpenPack(a, {
      name: "acme/a",
      requires: { b: { source: "../b" } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(b, {
      name: "acme/b",
      requires: { a: { source: "../a", select: ["rules/missing.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });

    await expect(resolveDependencyGraph([{ rootId: "main", source: a }], { workspaceRoot: workspace }))
      .rejects.toThrow(/Selected artifact not found in package: rules\/missing.md/);
  });

  it("errors on direct dependency plain-name collisions", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const depA = join(workspace, "dep-a");
    const depB = join(workspace, "dep-b");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(depA, "rules", "collide.md"), "# A\n");
    await writeText(join(depB, "rules", "collide.md"), "# B\n");
    await writeOpenPack(depA, {
      name: "acme/dep-a",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(depB, {
      name: "acme/dep-b",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        a: { source: "../dep-a", select: ["rules/collide.md"] },
        b: { source: "../dep-b", select: ["rules/collide.md"] },
      },
      provides: [{ type: "rules", path: "rules" }],
    });

    await expect(resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace }))
      .rejects.toThrow(/Direct dependency artifact collision for rules\/collide.md.*aliasing, deselecting one artifact, or overriding/s);
  });

  it("serializes byte-identical canonical lock sections for the same graph", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const dep = join(workspace, "dep");
    await writeText(join(root, "rules", "root.md"), "# Root\n");
    await writeText(join(dep, "rules", "dep.md"), "# Dep\n");
    await writeOpenPack(dep, {
      name: "acme/dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeOpenPack(root, {
      name: "acme/root",
      requires: { dep: { source: "../dep", select: ["rules/dep.md"] } },
      provides: [{ type: "rules", path: "rules" }],
    });

    const first = await renderGraphForTarget(await resolveDependencyGraph([{ rootId: "main", source: root }], {
      workspaceRoot: workspace,
      now: () => new Date("2026-06-10T00:00:00.000Z"),
    }), { workspaceRoot: workspace, adapter: openClawAdapter, targetFingerprint: "target" });
    const second = await renderGraphForTarget(await resolveDependencyGraph([{ rootId: "main", source: root }], {
      workspaceRoot: workspace,
      now: () => new Date("2026-06-10T00:01:00.000Z"),
    }), { workspaceRoot: workspace, adapter: openClawAdapter, targetFingerprint: "target" });

    expect(canonicalGraphLockJson(first.graphLock)).toBe(canonicalGraphLockJson(second.graphLock));
  });

  it("renders a single root with no dependencies the same as stageSource", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    await writeText(join(root, "skills", "demo", "SKILL.md"), "# Demo\n\n<!-- openpack:include fragments/shared.md -->\n");
    await writeText(join(root, "fragments", "shared.md"), "Shared\n");
    await writeOpenPack(root, {
      name: "acme/root",
      provides: [
        { type: "fragments", path: "fragments" },
        { type: "skills", path: "skills" },
      ],
    });

    const staged = await stageSource(new LocalSourceDriver(), root, { workspaceRoot: workspace, adapter: openClawAdapter });
    const rendered = await renderGraphForTarget(
      await resolveDependencyGraph([{ rootId: "main", source: root }], { workspaceRoot: workspace }),
      { workspaceRoot: workspace, adapter: openClawAdapter },
    );

    expect(rendered.artifacts.map(artifactSignature)).toEqual(staged.artifacts.map(artifactSignature));
    await rm(staged.root, { recursive: true, force: true });
    await rm(rendered.root, { recursive: true, force: true });
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function artifactSignature(artifact: { type: string; name: string; hash: string; composedFrom?: Array<{ selector: string; hash: string }> }): string {
  return `${artifact.type}/${artifact.name}/${artifact.hash}/${JSON.stringify(artifact.composedFrom ?? [])}`;
}
