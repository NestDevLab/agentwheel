import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { canonicalGraphLockJson, type GraphLock } from "../src/model/graph-lock.js";
import { RegistryClient } from "../src/registry/client.js";
import { createGraphLock, resolveDependencyGraph } from "../src/resolve/graph.js";
import { renderGraphForTarget } from "../src/resolve/render.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { SkillKitSourceDriver } from "../src/source/skillkit.js";
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
  it("reuses graph-locked non-Git cache identities in frozen and offline modes", async () => {
    const workspace = await tempRoot();
    const cacheRoot = join(workspace, "cache");
    const source = "skillkit:https://skills.example.test/.well-known/skills";
    const firstDriver = new SkillKitSourceDriver({
      detectProvider() {
        return {
          async clone(_source: string, targetDir: string) {
            await writeText(join(targetDir, "rules", "root.md"), "# Root\n");
            await writeOpenPack(targetDir, {
              name: "acme/well-known",
              provides: [{ type: "rules", path: "rules" }],
            });
            return { success: true, path: targetDir };
          },
        };
      },
    });
    const first = await firstDriver.fetch(await firstDriver.resolve(source, { cacheRoot }));
    const cacheIdentity = first.cacheIdentity!;
    const nodeId = "acme/well-known@1.0.0+locked";
    const lock: GraphLock = {
      version: 1,
      canonical: {
        roots: [{
          rootId: "root",
          source,
          normalizedSource: source,
          graphNodeId: nodeId,
          mode: "tracking",
          selected: [],
        }],
        nodes: [{
          id: nodeId,
          name: "acme/well-known",
          version: "1.0.0",
          source,
          normalizedSource: source,
          driver: "skillkit",
          cacheIdentity,
          sourceHash: first.sourceHash!,
          mode: "tracking",
          requiredBy: ["workspace:root"],
          selected: [],
        }],
        edges: [],
        includeEdges: [],
        artifacts: [],
        namespacing: [],
        overrides: [],
        plainNameIncumbents: [],
      },
    };

    expect(lock.canonical.nodes[0]?.cacheIdentity).toBe(cacheIdentity);
    expect(JSON.parse(canonicalGraphLockJson(lock)).nodes[0]?.cacheIdentity).toBe(cacheIdentity);
    for (const hardMode of [{ frozenLock: true }, { offline: true }]) {
      const graph = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking" }], {
        workspaceRoot: workspace,
        cacheRoot,
        previousLock: lock,
        lockedResolution: true,
        ...hardMode,
      });

      expect(graph.nodes[0]?.cacheIdentity).toBe(cacheIdentity);
      expect(graph.nodes[0]?.resolvedCommit).toBeUndefined();
      expect(graph.nodes[0]?.sourceHash).toBe(first.sourceHash);
    }

    lock.canonical.nodes[0]!.cacheIdentity = "../mutable-path";
    expect(() => canonicalGraphLockJson(lock)).toThrow(/Git commit or content-addressed SHA-256/);
  });

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

  it("refreshes a tracking dependency when the root expands its selection", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const depRepo = join(workspace, "dep-repo");
    await writeText(join(depRepo, "rules", "existing.md"), "# Existing\n");
    await writeOpenPack(depRepo, {
      name: "acme/tracking-dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await git(depRepo, ["init", "-b", "main"]);
    await git(depRepo, ["config", "user.name", "Test"]);
    await git(depRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v1"]);

    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        dep: { source: `git:file://${depRepo}#main`, mode: "tracking", select: ["rules/existing.md"] },
      },
    });
    const first = await resolveDependencyGraph([{ rootId: "root", source: root }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(first);

    await writeText(join(depRepo, "rules", "added.md"), "# Added\n");
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v2"]);
    const latestCommit = (await git(depRepo, ["rev-parse", "HEAD"])).trim();
    await writeOpenPack(root, {
      name: "acme/root",
      requires: {
        dep: {
          source: `git:file://${depRepo}#main`,
          mode: "tracking",
          select: ["rules/added.md", "rules/existing.md"],
        },
      },
    });

    const refreshed = await resolveDependencyGraph([{ rootId: "root", source: root }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });
    const depNode = refreshed.nodes.find((node) => node.name === "acme/tracking-dep");

    expect(depNode?.resolvedCommit).toBe(latestCommit);
    expect(depNode?.selected).toEqual(["rules/added.md", "rules/existing.md"]);
  });

  it("refreshes a referenced tracking dependency when a stable root selection expands", async () => {
    const workspace = await tempRoot();
    const root = join(workspace, "root");
    const depRepo = join(workspace, "dep-repo");
    await writeText(join(root, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeText(join(root, "skills", "expanded", "SKILL.md"), "# Expanded\n");
    await writeText(join(depRepo, "rules", "existing.md"), "# Existing\n");
    await writeOpenPack(depRepo, {
      name: "acme/tracking-dep",
      provides: [{ type: "rules", path: "rules" }],
    });
    await git(depRepo, ["init", "-b", "main"]);
    await git(depRepo, ["config", "user.name", "Test"]);
    await git(depRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v1"]);
    await writeOpenPack(root, {
      name: "acme/root",
      requires: { dep: { source: `git:file://${depRepo}#main`, mode: "tracking" } },
      provides: [{
        type: "skills",
        path: "skills",
        items: {
          existing: { requires: ["dep:rules/existing.md"] },
          expanded: { requires: ["dep:rules/added.md"] },
        },
      }],
    });

    const first = await resolveDependencyGraph([{ rootId: "root", source: root, select: ["skills/existing"] }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(first);
    await writeText(join(depRepo, "rules", "added.md"), "# Added\n");
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v2"]);
    const latestCommit = (await git(depRepo, ["rev-parse", "HEAD"])).trim();

    for (const hardMode of [{ frozenLock: true }, { offline: true }]) {
      await expect(resolveDependencyGraph([{ rootId: "root", source: root, select: ["skills/expanded"] }], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, "cache-first"),
        previousLock: lock,
        lockedResolution: true,
        ...hardMode,
      })).rejects.toThrow(/Selected artifact not found in package: rules\/added\.md/);
    }

    const refreshed = await resolveDependencyGraph([{ rootId: "root", source: root, select: ["skills/expanded"] }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });
    const depNode = refreshed.nodes.find((node) => node.name === "acme/tracking-dep");

    expect(depNode?.resolvedCommit).toBe(latestCommit);
    expect(depNode?.selected).toEqual(["rules/added.md"]);
  });

  it.each([["locked", "fresh"], ["fresh", "locked"]] as const)(
    "refreshes shared tracking consumers in %s-first root order",
    async (firstKind, secondKind) => {
      const workspace = await tempRoot();
      const lockedRoot = join(workspace, "locked-root");
      const oldFreshRoot = join(workspace, "old-fresh-root");
      const freshRoot = join(workspace, "fresh-root");
      const depRepo = join(workspace, "dep-repo");
      await writeText(join(depRepo, "rules", "existing.md"), "# Existing\n");
      await writeOpenPack(depRepo, {
        name: "acme/shared-tracking-dep",
        provides: [{ type: "rules", path: "rules" }],
      });
      await git(depRepo, ["init", "-b", "main"]);
      await git(depRepo, ["config", "user.name", "Test"]);
      await git(depRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
      await git(depRepo, ["add", "-A"]);
      await git(depRepo, ["commit", "-m", "v1"]);
      for (const [path, name, selector] of [
        [lockedRoot, "acme/locked-root", "rules/existing.md"],
        [oldFreshRoot, "acme/fresh-root", "rules/existing.md"],
        [freshRoot, "acme/fresh-root", "rules/added.md"],
      ] as const) {
        await writeOpenPack(path, {
          name,
          requires: { dep: { source: `git:file://${depRepo}#main`, mode: "tracking", select: [selector] } },
        });
      }
      const initial = await resolveDependencyGraph([
        { rootId: "locked", source: lockedRoot },
        { rootId: "fresh", source: oldFreshRoot },
      ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
      const lock = createGraphLock(initial);
      await writeText(join(depRepo, "rules", "added.md"), "# Added\n");
      await git(depRepo, ["add", "-A"]);
      await git(depRepo, ["commit", "-m", "v2"]);
      const latestCommit = (await git(depRepo, ["rev-parse", "HEAD"])).trim();
      const roots = {
        locked: { rootId: "locked", source: lockedRoot },
        fresh: { rootId: "fresh", source: freshRoot },
      } as const;

      const refreshed = await resolveDependencyGraph([roots[firstKind], roots[secondKind]], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-${firstKind}-first`),
        previousLock: lock,
        lockedResolution: true,
        concurrency: 4,
      });
      const depNodes = refreshed.nodes.filter((node) => node.name === "acme/shared-tracking-dep");

      expect(depNodes).toHaveLength(1);
      expect(depNodes[0]?.resolvedCommit).toBe(latestCommit);
      expect(depNodes[0]?.selected).toEqual(["rules/added.md", "rules/existing.md"]);
    },
  );

  it.each([["direct", "deep"], ["deep", "direct"]] as const)(
    "refreshes shared tracking consumers across dependency depths in %s-first root order",
    async (firstKind, secondKind) => {
      const workspace = await tempRoot();
      const directRoot = join(workspace, "direct-root");
      const oldDeepRoot = join(workspace, "old-deep-root");
      const newDeepRoot = join(workspace, "new-deep-root");
      const middle = join(workspace, "middle");
      const sharedRepo = join(workspace, "shared-repo");
      await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
      await writeOpenPack(sharedRepo, {
        name: "acme/deep-shared",
        provides: [{ type: "rules", path: "rules" }],
      });
      await git(sharedRepo, ["init", "-b", "main"]);
      await git(sharedRepo, ["config", "user.name", "Test"]);
      await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v1"]);
      await writeOpenPack(directRoot, {
        name: "acme/direct-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/existing.md"] } },
      });
      await writeOpenPack(middle, {
        name: "acme/middle",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/existing.md"] } },
      });
      for (const [path, name] of [[oldDeepRoot, "acme/old-deep-root"], [newDeepRoot, "acme/new-deep-root"]] as const) {
        await writeOpenPack(path, {
          name,
          requires: { middle: { source: middle, mode: "tracking" } },
        });
      }
      const initial = await resolveDependencyGraph([
        { rootId: "direct", source: directRoot },
        { rootId: "deep", source: oldDeepRoot },
      ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
      const lock = createGraphLock(initial);
      await writeText(join(sharedRepo, "rules", "added.md"), "# Added\n");
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v2"]);
      await writeOpenPack(middle, {
        name: "acme/middle",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/added.md"] } },
      });
      const latestCommit = (await git(sharedRepo, ["rev-parse", "HEAD"])).trim();
      const roots = {
        direct: { rootId: "direct", source: directRoot },
        deep: { rootId: "deep", source: newDeepRoot },
      } as const;

      const refreshed = await resolveDependencyGraph([roots[firstKind], roots[secondKind]], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-depth-${firstKind}`),
        previousLock: lock,
        lockedResolution: true,
        concurrency: 4,
      });
      const shared = refreshed.nodes.find((node) => node.name === "acme/deep-shared");

      expect(shared?.resolvedCommit).toBe(latestCommit);
      expect(shared?.selected).toEqual(["rules/added.md", "rules/existing.md"]);
    },
  );

  it.each([["pinned", "tracking"], ["tracking", "pinned"]] as const)(
    "rejects mixed pinned and refreshed tracking snapshots in %s-first order",
    async (firstKind, secondKind) => {
      const workspace = await tempRoot();
      const pinnedRoot = join(workspace, "pinned-root");
      const trackingRoot = join(workspace, "tracking-root");
      const sharedRepo = join(workspace, "shared-repo");
      await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
      await writeOpenPack(sharedRepo, { name: "acme/mixed-shared", provides: [{ type: "rules", path: "rules" }] });
      await git(sharedRepo, ["init", "-b", "main"]);
      await git(sharedRepo, ["config", "user.name", "Test"]);
      await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v1"]);
      await writeOpenPack(pinnedRoot, {
        name: "acme/pinned-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "pinned", select: ["rules/existing.md"] } },
      });
      await writeOpenPack(trackingRoot, {
        name: "acme/tracking-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/existing.md"] } },
      });
      const initial = await resolveDependencyGraph([
        { rootId: "pinned", source: pinnedRoot },
        { rootId: "tracking", source: trackingRoot },
      ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
      const lock = createGraphLock(initial);
      await writeText(join(sharedRepo, "rules", "added.md"), "# Added\n");
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v2"]);
      await writeOpenPack(trackingRoot, {
        name: "acme/tracking-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/added.md"] } },
      });
      const roots = {
        pinned: { rootId: "pinned", source: pinnedRoot },
        tracking: { rootId: "tracking", source: trackingRoot },
      } as const;

      await expect(resolveDependencyGraph([roots[firstKind], roots[secondKind]], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-mixed-${firstKind}`),
        previousLock: lock,
        lockedResolution: true,
      })).rejects.toThrow(/conflicting locked and refreshed snapshots/i);
    },
  );

  it.each([
    { firstKind: "pinned", secondKind: "tracking", concurrency: 1 },
    { firstKind: "tracking", secondKind: "pinned", concurrency: 1 },
    { firstKind: "pinned", secondKind: "tracking", concurrency: 4 },
    { firstKind: "tracking", secondKind: "pinned", concurrency: 4 },
  ] as const)(
    "skips optional mixed snapshots in $firstKind-first order at concurrency $concurrency",
    async ({ firstKind, secondKind, concurrency }) => {
      const workspace = await tempRoot();
      const pinnedRoot = join(workspace, "pinned-root");
      const trackingRoot = join(workspace, "tracking-root");
      const sharedRepo = join(workspace, "shared-repo");
      await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
      await writeOpenPack(sharedRepo, { name: "acme/optional-mixed", provides: [{ type: "rules", path: "rules" }] });
      await git(sharedRepo, ["init", "-b", "main"]);
      await git(sharedRepo, ["config", "user.name", "Test"]);
      await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v1"]);
      await writeOpenPack(pinnedRoot, {
        name: "acme/pinned-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "pinned", select: ["rules/existing.md"] } },
      });
      await writeOpenPack(trackingRoot, {
        name: "acme/tracking-root",
        requires: {
          shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", optional: true, select: ["rules/existing.md"] },
        },
      });
      const initial = await resolveDependencyGraph([
        { rootId: "pinned", source: pinnedRoot },
        { rootId: "tracking", source: trackingRoot },
      ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
      const lock = createGraphLock(initial);
      await writeText(join(sharedRepo, "rules", "added.md"), "# Added\n");
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v2"]);
      await writeOpenPack(trackingRoot, {
        name: "acme/tracking-root",
        requires: {
          shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", optional: true, select: ["rules/added.md"] },
        },
      });
      const roots = {
        pinned: { rootId: "pinned", source: pinnedRoot },
        tracking: { rootId: "tracking", source: trackingRoot },
      } as const;

      const warnings: string[] = [];
      const resolved = await resolveDependencyGraph([roots[firstKind], roots[secondKind]], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-optional-${firstKind}-${concurrency}`),
        previousLock: lock,
        lockedResolution: true,
        concurrency,
        warn: (message) => warnings.push(message),
      });
      const shared = resolved.nodes.find((node) => node.name === "acme/optional-mixed");
      expect(shared?.resolvedCommit).toBe(lock.canonical.nodes.find((node) => node.name === "acme/optional-mixed")?.resolvedCommit);
      expect(shared?.selected).toEqual(["rules/existing.md"]);
      expect(warnings).toEqual([expect.stringMatching(/optional dependency skipped: Conflicting locked and refreshed snapshots/)]);
    },
  );

  it("prioritizes a deeper required snapshot over a shallower optional refresh", async () => {
    const workspace = await tempRoot();
    const optionalRoot = join(workspace, "optional-root");
    const requiredRoot = join(workspace, "required-root");
    const middle = join(workspace, "middle");
    const sharedRepo = join(workspace, "shared-repo");
    await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
    await writeOpenPack(sharedRepo, { name: "acme/depth-priority", provides: [{ type: "rules", path: "rules" }] });
    await git(sharedRepo, ["init", "-b", "main"]);
    await git(sharedRepo, ["config", "user.name", "Test"]);
    await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v1"]);
    await writeOpenPack(optionalRoot, {
      name: "acme/optional-root",
      requires: {
        shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", optional: true, select: ["rules/existing.md"] },
      },
    });
    await writeOpenPack(middle, {
      name: "acme/middle",
      requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "pinned", select: ["rules/existing.md"] } },
    });
    await writeOpenPack(requiredRoot, {
      name: "acme/required-root",
      requires: { middle: { source: middle } },
    });
    const initial = await resolveDependencyGraph([
      { rootId: "optional", source: optionalRoot },
      { rootId: "required", source: requiredRoot },
    ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
    const lock = createGraphLock(initial);
    const lockedCommit = lock.canonical.nodes.find((node) => node.name === "acme/depth-priority")?.resolvedCommit;
    await writeText(join(sharedRepo, "rules", "added.md"), "# Added\n");
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v2"]);
    await writeOpenPack(optionalRoot, {
      name: "acme/optional-root",
      requires: {
        shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", optional: true, select: ["rules/added.md"] },
      },
    });

    const warnings: string[] = [];
    const resolved = await resolveDependencyGraph([
      { rootId: "optional", source: optionalRoot },
      { rootId: "required", source: requiredRoot },
    ], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
      warn: (message) => warnings.push(message),
    });

    const shared = resolved.nodes.find((node) => node.name === "acme/depth-priority");
    expect(shared?.resolvedCommit).toBe(lockedCommit);
    expect(shared?.selected).toEqual(["rules/existing.md"]);
    expect(warnings).toEqual([expect.stringMatching(/optional dependency skipped: Conflicting locked and refreshed snapshots/)]);
  });

  it.each([1, 4])("refreshes a shared tracking dependency closure after a later consumer enables updates at concurrency %s", async (concurrency) => {
    const workspace = await tempRoot();
    const stableRoot = join(workspace, "stable-root");
    const updatingRoot = join(workspace, "updating-root");
    const sharedRepo = join(workspace, "shared-repo");
    const leafRepo = join(workspace, "leaf-repo");
    await writeText(join(leafRepo, "rules", "leaf.md"), "# Leaf v1\n");
    await writeOpenPack(leafRepo, { name: "acme/leaf", provides: [{ type: "rules", path: "rules" }] });
    await git(leafRepo, ["init", "-b", "main"]);
    await git(leafRepo, ["config", "user.name", "Test"]);
    await git(leafRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(leafRepo, ["add", "-A"]);
    await git(leafRepo, ["commit", "-m", "v1"]);
    const leafV1 = (await git(leafRepo, ["rev-parse", "HEAD"])).trim();
    await writeOpenPack(sharedRepo, {
      name: "acme/shared-closure",
      requires: { leaf: { source: `git:file://${leafRepo}#main`, mode: "tracking", select: ["rules/leaf.md"] } },
    });
    await git(sharedRepo, ["init", "-b", "main"]);
    await git(sharedRepo, ["config", "user.name", "Test"]);
    await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v1"]);
    for (const [root, name] of [[stableRoot, "acme/stable-root"], [updatingRoot, "acme/updating-root"]] as const) {
      await writeOpenPack(root, {
        name,
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking" } },
      });
    }
    const initial = await resolveDependencyGraph([
      { rootId: "stable", source: stableRoot },
      { rootId: "updating", source: updatingRoot },
    ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first"), concurrency });
    const lock = createGraphLock(initial);
    await writeText(join(leafRepo, "rules", "leaf.md"), "# Leaf v2\n");
    await git(leafRepo, ["add", "-A"]);
    await git(leafRepo, ["commit", "-m", "v2"]);
    const leafV2 = (await git(leafRepo, ["rev-parse", "HEAD"])).trim();

    const resolved = await resolveDependencyGraph([
      { rootId: "stable", source: stableRoot },
      { rootId: "updating", source: updatingRoot, useLock: false },
    ], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, `cache-second-${concurrency}`),
      previousLock: lock,
      lockedResolution: true,
      concurrency,
    });

    expect(initial.nodes.find((node) => node.name === "acme/leaf")?.resolvedCommit).toBe(leafV1);
    expect(resolved.nodes.find((node) => node.name === "acme/leaf")?.resolvedCommit).toBe(leafV2);
  });

  it("refreshes a tracking root when selection changes from a subset to all artifacts", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "select-all-repo");
    await writeText(join(repo, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeOpenPack(repo, { name: "acme/select-all", provides: [{ type: "skills", path: "skills" }] });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const source = `git:file://${repo}#main`;
    const initial = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking", select: ["skills/existing"] }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "skills", "added", "SKILL.md"), "# Added\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);
    const latestCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const resolved = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking" }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(resolved.nodes[0]?.resolvedCommit).toBe(latestCommit);
    expect(resolved.roots[0]?.selected).toEqual(["skills/added", "skills/existing"]);
  });

  it("keeps a tracking root locked when it already selected all artifacts", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "locked-all-repo");
    await writeText(join(repo, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeOpenPack(repo, { name: "acme/locked-all", provides: [{ type: "skills", path: "skills" }] });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const lockedCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const source = `git:file://${repo}#main`;
    const initial = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking" }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "skills", "added", "SKILL.md"), "# Added\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);

    const resolved = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking" }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(resolved.nodes[0]?.resolvedCommit).toBe(lockedCommit);
    expect(resolved.roots[0]?.selected).toEqual(["skills/existing"]);
  });

  it("does not treat a pinned edge alias as an updateable tracking dependency", async () => {
    const workspace = await tempRoot();
    const pinnedRoot = join(workspace, "pinned-root");
    const trackingRoot = join(workspace, "tracking-root");
    const sharedRepo = join(workspace, "shared-repo");
    await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
    await writeOpenPack(sharedRepo, { name: "acme/shared-update-mode", provides: [{ type: "rules", path: "rules" }] });
    await git(sharedRepo, ["init", "-b", "main"]);
    await git(sharedRepo, ["config", "user.name", "Test"]);
    await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v1"]);
    await writeOpenPack(pinnedRoot, {
      name: "acme/pinned-update-root",
      requires: { pinnedAlias: { source: `git:file://${sharedRepo}#main`, mode: "pinned" } },
    });
    await writeOpenPack(trackingRoot, {
      name: "acme/tracking-update-root",
      requires: { trackingAlias: { source: `git:file://${sharedRepo}#main`, mode: "tracking" } },
    });
    const roots = [
      { rootId: "pinned", source: pinnedRoot },
      { rootId: "tracking", source: trackingRoot },
    ];
    const initial = await resolveDependencyGraph(roots, { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });

    await expect(resolveDependencyGraph(roots, {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: createGraphLock(initial),
      lockedResolution: true,
      dependencyUpdateSelectors: ["pinnedAlias"],
    })).rejects.toThrow(/Tracking dependency not found in graph lock: pinnedAlias/);
  });

  it("keeps the locked snapshot when an imported selection contracts to an inherited selector", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "semantic-contraction-repo");
    await writeText(join(repo, "skills", "inherited", "SKILL.md"), "# Inherited\n");
    await writeText(join(repo, "skills", "extra", "SKILL.md"), "# Extra\n");
    await writeOpenPack(repo, { name: "acme/semantic-contraction", provides: [{ type: "skills", path: "skills" }] });
    await writeJson(join(repo, ".agentwheel", "config.json"), {
      schemaVersion: 2,
      exports: { selections: { default: { select: ["skills/inherited"] } } },
      packages: [], profiles: {}, agents: {}, registry: {}, trust: {},
    });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const lockedCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const source = `git:file://${repo}#main`;
    const initial = await resolveDependencyGraph([{
      rootId: "root", source, mode: "tracking", selection: { export: "default", add: ["skills/extra"] },
    }], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "skills", "new", "SKILL.md"), "# New\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);

    const resolved = await resolveDependencyGraph([{
      rootId: "root", source, mode: "tracking", selection: { export: "default", add: ["skills/inherited"] },
    }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(resolved.nodes[0]?.resolvedCommit).toBe(lockedCommit);
    expect(resolved.roots[0]?.selected).toEqual(["skills/inherited"]);
  });

  it.each([
    { firstKind: "pinned", secondKind: "tracking", concurrency: 1 },
    { firstKind: "tracking", secondKind: "pinned", concurrency: 1 },
    { firstKind: "pinned", secondKind: "tracking", concurrency: 4 },
    { firstKind: "tracking", secondKind: "pinned", concurrency: 4 },
  ] as const)(
    "preserves shared pinned and tracking modes in $firstKind-first order at concurrency $concurrency",
    async ({ firstKind, secondKind, concurrency }) => {
      const workspace = await tempRoot();
      const pinnedRoot = join(workspace, "pinned-root");
      const trackingRoot = join(workspace, "tracking-root");
      const sharedRepo = join(workspace, "shared-repo");
      await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
      await writeOpenPack(sharedRepo, { name: "acme/shared-modes", provides: [{ type: "rules", path: "rules" }] });
      await git(sharedRepo, ["init", "-b", "main"]);
      await git(sharedRepo, ["config", "user.name", "Test"]);
      await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
      await git(sharedRepo, ["add", "-A"]);
      await git(sharedRepo, ["commit", "-m", "v1"]);
      await writeOpenPack(pinnedRoot, {
        name: "acme/pinned-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "pinned" } },
      });
      await writeOpenPack(trackingRoot, {
        name: "acme/tracking-root",
        requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking" } },
      });
      const roots = {
        pinned: { rootId: "pinned", source: pinnedRoot },
        tracking: { rootId: "tracking", source: trackingRoot },
      } as const;

      const graph = await resolveDependencyGraph([roots[firstKind], roots[secondKind]], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-modes-${firstKind}-${concurrency}`),
        concurrency,
      });
      const shared = graph.nodes.find((node) => node.name === "acme/shared-modes");
      const sharedEdges = graph.edges.filter((edge) => edge.to === shared?.id);

      expect(shared?.mode).toBe("tracking");
      expect(sharedEdges.map((edge) => edge.mode).sort()).toEqual(["pinned", "tracking"]);

      const direct = await resolveDependencyGraph([
        { rootId: "pinned", source: `git:file://${sharedRepo}#main`, mode: "pinned" },
        { rootId: "tracking", source: `git:file://${sharedRepo}#main`, mode: "tracking" },
      ], {
        workspaceRoot: workspace,
        cacheRoot: join(workspace, `cache-direct-modes-${firstKind}-${concurrency}`),
        concurrency,
      });
      expect(Object.fromEntries(direct.roots.map((root) => [root.rootId, root.mode]))).toEqual({
        pinned: "pinned",
        tracking: "tracking",
      });
    },
  );

  it("rejects mixed snapshots when the refreshed package name changes", async () => {
    const workspace = await tempRoot();
    const pinnedRoot = join(workspace, "pinned-root");
    const trackingRoot = join(workspace, "tracking-root");
    const sharedRepo = join(workspace, "shared-repo");
    await writeText(join(sharedRepo, "rules", "existing.md"), "# Existing\n");
    await writeOpenPack(sharedRepo, { name: "acme/original-name", provides: [{ type: "rules", path: "rules" }] });
    await git(sharedRepo, ["init", "-b", "main"]);
    await git(sharedRepo, ["config", "user.name", "Test"]);
    await git(sharedRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v1"]);
    await writeOpenPack(pinnedRoot, {
      name: "acme/pinned-root",
      requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "pinned", select: ["rules/existing.md"] } },
    });
    await writeOpenPack(trackingRoot, {
      name: "acme/tracking-root",
      requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/existing.md"] } },
    });
    const initial = await resolveDependencyGraph([
      { rootId: "pinned", source: pinnedRoot },
      { rootId: "tracking", source: trackingRoot },
    ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
    const lock = createGraphLock(initial);
    await writeText(join(sharedRepo, "rules", "added.md"), "# Added\n");
    await writeOpenPack(sharedRepo, { name: "acme/renamed", provides: [{ type: "rules", path: "rules" }] });
    await git(sharedRepo, ["add", "-A"]);
    await git(sharedRepo, ["commit", "-m", "v2"]);
    await writeOpenPack(trackingRoot, {
      name: "acme/tracking-root",
      requires: { shared: { source: `git:file://${sharedRepo}#main`, mode: "tracking", select: ["rules/added.md"] } },
    });

    await expect(resolveDependencyGraph([
      { rootId: "pinned", source: pinnedRoot },
      { rootId: "tracking", source: trackingRoot },
    ], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
      concurrency: 1,
    })).rejects.toThrow(/conflicting locked and refreshed snapshots/i);
  });

  it("rejects mixed snapshots for a manifestless source", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "plain-repo");
    await writeText(join(repo, "README.md"), "v1\n");
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const source = `git:file://${repo}#main`;
    const initial = await resolveDependencyGraph([
      { rootId: "pinned", source, mode: "pinned" },
      { rootId: "tracking", source, mode: "tracking" },
    ], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first"), concurrency: 1 });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "README.md"), "v2\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);

    await expect(resolveDependencyGraph([
      { rootId: "pinned", source, mode: "pinned" },
      { rootId: "tracking", source, mode: "tracking", useLock: false },
    ], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
      concurrency: 1,
    })).rejects.toThrow(/conflicting locked and refreshed snapshots/i);
  });

  it("refreshes a tracking dependency closure when a root changes source and selection", async () => {
    const workspace = await tempRoot();
    const oldRoot = join(workspace, "old-root");
    const newRoot = join(workspace, "new-root");
    const depRepo = join(workspace, "dep-repo");
    await writeText(join(oldRoot, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeText(join(newRoot, "skills", "added", "SKILL.md"), "# Added\n");
    await writeText(join(depRepo, "rules", "stable.md"), "# Stable v1\n");
    await writeOpenPack(depRepo, { name: "acme/closure-dep", provides: [{ type: "rules", path: "rules" }] });
    await git(depRepo, ["init", "-b", "main"]);
    await git(depRepo, ["config", "user.name", "Test"]);
    await git(depRepo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v1"]);
    for (const [path, item] of [[oldRoot, "existing"], [newRoot, "added"]] as const) {
      await writeOpenPack(path, {
        name: "acme/closure-root",
        requires: { dep: { source: `git:file://${depRepo}#main`, mode: "tracking", select: ["rules/stable.md"] } },
        provides: [{ type: "skills", path: "skills" }],
      });
    }
    const initial = await resolveDependencyGraph([{ rootId: "root", source: oldRoot, select: ["skills/existing"] }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(initial);
    await writeText(join(depRepo, "rules", "stable.md"), "# Stable v2\n");
    await git(depRepo, ["add", "-A"]);
    await git(depRepo, ["commit", "-m", "v2"]);
    const latestCommit = (await git(depRepo, ["rev-parse", "HEAD"])).trim();

    const refreshed = await resolveDependencyGraph([{ rootId: "root", source: newRoot, select: ["skills/added"] }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(refreshed.nodes.find((node) => node.name === "acme/closure-dep")?.resolvedCommit).toBe(latestCommit);
  });

  it("refreshes a tracking root when its imported selection expands", async () => {
    const workspace = await tempRoot();
    const repo = join(workspace, "selection-repo");
    await writeText(join(repo, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeOpenPack(repo, { name: "acme/selection-root", provides: [{ type: "skills", path: "skills" }] });
    await writeJson(join(repo, ".agentwheel", "config.json"), {
      schemaVersion: 2,
      exports: { selections: { default: { select: ["skills/existing"] } } },
      packages: [], profiles: {}, agents: {}, registry: {}, trust: {},
    });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const source = `git:file://${repo}#main`;
    const initial = await resolveDependencyGraph([{ rootId: "root", source, mode: "tracking", selection: { export: "default" } }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-first"),
    });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "skills", "added", "SKILL.md"), "# Added\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);
    const latestCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const refreshed = await resolveDependencyGraph([{
      rootId: "root",
      source,
      mode: "tracking",
      selection: { export: "default", add: ["skills/added"] },
    }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, "cache-second"),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(refreshed.nodes[0]?.resolvedCommit).toBe(latestCommit);
    expect(refreshed.roots[0]?.selected).toEqual(["skills/added", "skills/existing"]);
  });

  it.each([
    ["removed addition", ["skills/existing"], { add: ["skills/extra"] }, {}, ["skills/existing"]],
    ["added exclusion", ["skills/existing", "skills/extra"], {}, { exclude: ["skills/extra"] }, ["skills/existing"]],
  ] as const)("keeps the locked tracking snapshot when an imported selection is contracted by %s", async (_case, inherited, initialMods, nextMods, expected) => {
    const workspace = await tempRoot();
    const repo = join(workspace, "selection-repo");
    await writeText(join(repo, "skills", "existing", "SKILL.md"), "# Existing\n");
    await writeText(join(repo, "skills", "extra", "SKILL.md"), "# Extra\n");
    await writeOpenPack(repo, { name: "acme/selection-contraction", provides: [{ type: "skills", path: "skills" }] });
    await writeJson(join(repo, ".agentwheel", "config.json"), {
      schemaVersion: 2,
      exports: { selections: { default: { select: inherited } } },
      packages: [], profiles: {}, agents: {}, registry: {}, trust: {},
    });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test@users.noreply.github.com"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v1"]);
    const lockedCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const source = `git:file://${repo}#main`;
    const initialSelection = initialMods as { add?: readonly string[]; exclude?: readonly string[] };
    const nextSelection = nextMods as { add?: readonly string[]; exclude?: readonly string[] };
    const initial = await resolveDependencyGraph([{
      rootId: "root",
      source,
      mode: "tracking",
      selection: {
        export: "default",
        add: initialSelection.add ? [...initialSelection.add] : undefined,
        exclude: initialSelection.exclude ? [...initialSelection.exclude] : undefined,
      },
    }], { workspaceRoot: workspace, cacheRoot: join(workspace, "cache-first") });
    const lock = createGraphLock(initial);
    await writeText(join(repo, "skills", "new", "SKILL.md"), "# New\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "v2"]);

    const resolved = await resolveDependencyGraph([{
      rootId: "root",
      source,
      mode: "tracking",
      selection: {
        export: "default",
        add: nextSelection.add ? [...nextSelection.add] : undefined,
        exclude: nextSelection.exclude ? [...nextSelection.exclude] : undefined,
      },
    }], {
      workspaceRoot: workspace,
      cacheRoot: join(workspace, `cache-${_case.replace(" ", "-")}`),
      previousLock: lock,
      lockedResolution: true,
    });

    expect(resolved.nodes[0]?.resolvedCommit).toBe(lockedCommit);
    expect(resolved.roots[0]?.selected).toEqual(expected);
  });

  it("keeps optional tracking normalization failures non-blocking", async () => {
    const workspace = await tempRoot();
    const oldRoot = join(workspace, "old-root");
    const newRoot = join(workspace, "new-root");
    await writeOpenPack(oldRoot, { name: "acme/optional-root", provides: [{ type: "rules", path: "rules" }] });
    await writeText(join(oldRoot, "rules", "root.md"), "# Root\n");
    await writeOpenPack(newRoot, {
      name: "acme/optional-root",
      requires: { missing: { source: "../missing", mode: "tracking", optional: true } },
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeText(join(newRoot, "rules", "root.md"), "# Root\n");
    const initial = await resolveDependencyGraph([{ rootId: "root", source: oldRoot }], { workspaceRoot: workspace });
    const warnings: string[] = [];

    const refreshed = await resolveDependencyGraph([{ rootId: "root", source: newRoot }], {
      workspaceRoot: workspace,
      previousLock: createGraphLock(initial),
      lockedResolution: true,
      warn: (message) => warnings.push(message),
    });

    expect(refreshed.nodes.map((node) => node.name)).toEqual(["acme/optional-root"]);
    expect(warnings).toEqual([expect.stringMatching(/optional dependency skipped/)]);
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
