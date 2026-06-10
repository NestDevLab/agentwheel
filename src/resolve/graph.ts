import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Artifact } from "../model/artifact.js";
import type { GraphNodeId, ResolvedNode } from "../model/graph.js";
import type { GraphLock, GraphLockArtifact, GraphLockEdge, GraphLockRoot } from "../model/graph-lock.js";
import type { PackageManifest } from "../model/package.js";
import { readPackageManifest } from "../model/package.js";
import type { RegistryClient } from "../registry/client.js";
import { getSourceDriver } from "../source/index.js";
import type { ResolvedSource, SourceDriver } from "../source/types.js";
import { hashPath } from "../utils/fs.js";
import { artifactSelectorKey, normalizeArtifactSelectors } from "../model/selection.js";
import { normalizeDependencySource, type NormalizedDependencySource } from "./identity.js";

export interface GraphRootRequest {
  rootId?: string;
  source: string;
  select?: string[];
  mode?: "pinned" | "tracking";
  ref?: string;
}

export interface ResolveGraphOptions {
  workspaceRoot: string;
  cacheRoot?: string;
  concurrency?: number;
  registryClient?: Pick<RegistryClient, "resolve">;
  now?: () => Date;
}

export interface ResolvedGraphRoot {
  rootId: string;
  source: string;
  normalizedSource: string;
  graphNodeId: GraphNodeId;
  mode: "pinned" | "tracking";
  selected: string[];
}

export interface ResolvedGraphRawNode {
  node: ResolvedNode;
  resolved: ResolvedSource;
  artifacts: Artifact[];
  manifest?: PackageManifest;
  depth: number;
}

export interface ResolvedGraph {
  root: string;
  roots: ResolvedGraphRoot[];
  nodes: ResolvedNode[];
  rawNodes: ResolvedGraphRawNode[];
  edges: GraphLockEdge[];
  generatedAt: string;
}

interface Requirement {
  source: string;
  select?: string[];
  mode: "pinned" | "tracking";
  ref?: string;
  declaringPackageRoot: string;
  requiredBy: string;
  rootId?: string;
  alias?: string;
  parentId?: GraphNodeId;
  depth: number;
  optional: boolean;
  chain: string[];
  version?: string;
}

interface FetchedPackage {
  normalized: NormalizedDependencySource;
  driver: SourceDriver;
  resolved: ResolvedSource;
  manifest?: PackageManifest;
  artifacts: Artifact[];
  name: string;
  version: string;
  sourceHash: string;
}

interface NodeState {
  node: ResolvedNode;
  resolved: ResolvedSource;
  manifest?: PackageManifest;
  artifacts: Artifact[];
  requiredBy: Set<string>;
  selected: Set<string>;
  depth: number;
}

const cacheLocks = new Map<string, Promise<void>>();

export async function resolveDependencyGraph(
  roots: GraphRootRequest[],
  options: ResolveGraphOptions,
): Promise<ResolvedGraph> {
  if (roots.length === 0) throw new Error("At least one graph root is required.");

  const graphRoot = await mkdtemp(join(tmpdir(), "agentwheel-graph-"));
  const fetchCache = new Map<string, Promise<FetchedPackage>>();
  const nodesByKey = new Map<string, NodeState>();
  const nodeKeyByName = new Map<string, string>();
  const rootResults: ResolvedGraphRoot[] = [];
  const edgeMap = new Map<string, GraphLockEdge>();
  const queue: Requirement[] = roots.map((root, index) => {
    const rootId = root.rootId ?? `root-${index + 1}`;
    return {
      source: root.source,
      select: root.select,
      mode: root.mode ?? "pinned",
      ref: root.ref,
      declaringPackageRoot: options.workspaceRoot,
      requiredBy: `workspace:${rootId}`,
      rootId,
      depth: 0,
      optional: false,
      chain: [`workspace:${rootId}`],
    };
  });

  let iterations = 0;
  const cap = Math.max(64, roots.length * 64);
  while (queue.length > 0) {
    if (++iterations > cap) {
      throw new Error(`Dependency graph did not reach a fixed point after ${cap} iterations.`);
    }

    const batch = queue.splice(0, queue.length);
    const next = await mapLimit(batch, options.concurrency ?? 4, async (requirement) =>
      processRequirement(requirement, options, fetchCache, nodesByKey, nodeKeyByName, rootResults, edgeMap));
    queue.push(...next.flat());
  }

  const rawNodes = [...nodesByKey.values()]
    .sort((a, b) => a.node.id.localeCompare(b.node.id))
    .map((state) => materializeRawNode(state));
  detectDirectCollisions(rawNodes);

  return {
    root: graphRoot,
    roots: rootResults.sort((a, b) => a.rootId.localeCompare(b.rootId)),
    nodes: rawNodes.map((state) => state.node),
    rawNodes,
    edges: [...edgeMap.values()].sort((a, b) => `${a.from}:${a.alias}:${a.to}`.localeCompare(`${b.from}:${b.alias}:${b.to}`)),
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function createGraphLock(graph: ResolvedGraph, artifacts: GraphLockArtifact[] = [], targetFingerprint?: string): GraphLock {
  const roots: GraphLockRoot[] = graph.roots.map((root) => ({
    rootId: root.rootId,
    source: root.source,
    normalizedSource: root.normalizedSource,
    graphNodeId: root.graphNodeId,
    mode: root.mode,
    selected: root.selected,
  }));

  return {
    version: 1,
    generatedAt: graph.generatedAt,
    canonical: {
      targetFingerprint,
      roots,
      nodes: graph.nodes,
      edges: graph.edges,
      includeEdges: [],
      artifacts,
      plainNameIncumbents: [],
    },
  };
}

async function processRequirement(
  requirement: Requirement,
  options: ResolveGraphOptions,
  fetchCache: Map<string, Promise<FetchedPackage>>,
  nodesByKey: Map<string, NodeState>,
  nodeKeyByName: Map<string, string>,
  rootResults: ResolvedGraphRoot[],
  edgeMap: Map<string, GraphLockEdge>,
): Promise<Requirement[]> {
  try {
    const normalized = await normalizeDependencySource(requirement.source, {
      declaringPackageRoot: requirement.declaringPackageRoot,
      workspaceRoot: options.workspaceRoot,
      ref: requirement.ref,
      registryClient: options.registryClient,
    });
    const fetched = await fetchPackage(normalized, requirement.mode, options, fetchCache);
    const nodeKey = `${normalized.normalizedSource}\0${fetched.name}`;
    const existingNameKey = nodeKeyByName.get(fetched.name);
    if (existingNameKey && existingNameKey !== nodeKey) {
      const existing = nodesByKey.get(existingNameKey);
      throw new Error(
        `Incompatible duplicate package "${fetched.name}" from ${existing?.node.normalizedSource ?? existingNameKey} `
        + `and ${normalized.normalizedSource}. B1 does not auto-namespace duplicate package identities.`,
      );
    }
    nodeKeyByName.set(fetched.name, nodeKey);

    const selected = computeSelectedSelectors(fetched.artifacts, requirement.select, requirement.depth === 0, requirement.chain);
    let state = nodesByKey.get(nodeKey);
    const wasNew = !state;
    if (!state) {
      const id = graphNodeId(fetched.name, fetched.version, normalized.normalizedSource, fetched.resolved.resolvedCommit, fetched.sourceHash);
      state = {
        node: {
          id,
          name: fetched.name,
          version: fetched.version,
          source: fetched.resolved.source,
          normalizedSource: normalized.normalizedSource,
          driver: fetched.resolved.driver,
          requestedRef: fetched.resolved.requestedRef,
          resolvedCommit: fetched.resolved.resolvedCommit,
          sourceHash: fetched.sourceHash,
          mode: fetched.resolved.mode ?? requirement.mode,
          requiredBy: [],
          selected: [],
        },
        resolved: fetched.resolved,
        manifest: fetched.manifest,
        artifacts: fetched.artifacts,
        requiredBy: new Set(),
        selected: new Set(),
        depth: requirement.depth,
      };
      nodesByKey.set(nodeKey, state);
    }

    state.depth = Math.min(state.depth, requirement.depth);
    state.requiredBy.add(requirement.requiredBy);
    for (const selector of selected) state.selected.add(selector);
    refreshNode(state);

    if (requirement.depth === 0 && requirement.rootId) {
      upsertRoot(rootResults, {
        rootId: requirement.rootId,
        source: fetched.resolved.source,
        normalizedSource: normalized.normalizedSource,
        graphNodeId: state.node.id,
        mode: state.node.mode,
        selected: state.node.selected,
      });
    }

    if (requirement.parentId && requirement.alias) {
      const edgeKey = `${requirement.parentId}\0${requirement.alias}\0${state.node.id}`;
      edgeMap.set(edgeKey, {
        from: requirement.parentId,
        to: state.node.id,
        alias: requirement.alias,
        source: requirement.source,
        normalizedSource: normalized.normalizedSource,
        requestedRef: fetched.resolved.requestedRef,
        version: requirement.version,
        mode: requirement.mode,
        optional: requirement.optional,
        selected,
      });
    }

    if (!wasNew) return [];
    if (fetched.manifest?.schemaVersion !== 2) return [];

    return Object.entries(fetched.manifest.requires ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([alias, dependency]) => ({
        source: dependency.source,
        select: dependency.select,
        mode: dependency.mode ?? "pinned",
        ref: dependency.ref,
        declaringPackageRoot: fetched.resolved.resolvedPath,
        requiredBy: state.node.id,
        alias,
        parentId: state.node.id,
        depth: requirement.depth + 1,
        optional: dependency.optional ?? false,
        chain: [...requirement.chain, `${state.node.id}:${alias}`],
        version: dependency.version,
      }));
  } catch (error) {
    if (requirement.optional) return [];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nDependency chain: ${requirement.chain.join(" -> ")}`);
  }
}

async function fetchPackage(
  normalized: NormalizedDependencySource,
  mode: "pinned" | "tracking",
  options: ResolveGraphOptions,
  fetchCache: Map<string, Promise<FetchedPackage>>,
): Promise<FetchedPackage> {
  const key = `${normalized.driver}\0${normalized.normalizedSource}\0${mode}`;
  const existing = fetchCache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const driver = getSourceDriver(normalized.driver);
    const resolved = await driver.resolve(normalized.source, {
      cacheRoot: options.cacheRoot ?? join(options.workspaceRoot, ".agentwheel", "cache"),
      mode,
      ref: normalized.requestedRef,
    });
    const fetched = await withCachePathLock(resolved.resolvedPath, () => driver.fetch(resolved));
    const translated = await driver.translate(fetched);
    const exported = await driver.export(translated);
    const manifest = await readPackageManifest(exported.resolvedPath);
    const artifacts = await driver.list(exported);
    const name = manifest?.name ?? exported.packageName ?? basename(exported.resolvedPath);
    const version = manifest?.version ?? exported.packageVersion ?? "0.0.0";
    const sourceHash = exported.sourceHash ?? await hashPath(exported.resolvedPath);
    return {
      normalized,
      driver,
      resolved: {
        ...exported,
        packageName: name,
        packageVersion: version,
        sourceHash,
      },
      manifest,
      artifacts,
      name,
      version,
      sourceHash,
    };
  })();
  fetchCache.set(key, promise);
  return promise;
}

async function withCachePathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(path) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  cacheLocks.set(path, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (cacheLocks.get(path) === current) cacheLocks.delete(path);
  }
}

function computeSelectedSelectors(artifacts: Artifact[], select: string[] | undefined, isRoot: boolean, chain: string[]): string[] {
  if (isRoot && !select?.length) {
    return sortedUnique(artifacts.map(artifactSelectorKey));
  }

  const explicit = normalizeArtifactSelectors(select) ?? [];
  const available = new Set(artifacts.map(artifactSelectorKey));
  const missing = explicit.filter((selector) => !available.has(selector));
  if (missing.length > 0) {
    throw new Error(`Selected artifact not found in package: ${missing.join(", ")} (${chain.join(" -> ")})`);
  }

  const required = artifacts
    .filter((artifact) => artifact.required && artifact.type !== "fragments")
    .map(artifactSelectorKey);
  return sortedUnique([...explicit, ...required]);
}

function materializeRawNode(state: NodeState): ResolvedGraphRawNode {
  refreshNode(state);
  return {
    node: state.node,
    resolved: state.resolved,
    artifacts: state.artifacts,
    manifest: state.manifest,
    depth: state.depth,
  };
}

function refreshNode(state: NodeState): void {
  state.node.requiredBy = sortedUnique([...state.requiredBy]);
  state.node.selected = sortedUnique([...state.selected]);
}

function upsertRoot(roots: ResolvedGraphRoot[], root: ResolvedGraphRoot): void {
  const index = roots.findIndex((item) => item.rootId === root.rootId);
  if (index >= 0) roots[index] = root;
  else roots.push(root);
}

function detectDirectCollisions(nodes: ResolvedGraphRawNode[]): void {
  const bySelector = new Map<string, ResolvedGraphRawNode[]>();
  for (const node of nodes) {
    if (node.depth !== 1) continue;
    for (const selector of node.node.selected) {
      if (selector.startsWith("fragments/")) continue;
      const list = bySelector.get(selector) ?? [];
      list.push(node);
      bySelector.set(selector, list);
    }
  }

  for (const [selector, owners] of bySelector) {
    const uniqueOwners = [...new Map(owners.map((owner) => [owner.node.id, owner])).values()];
    if (uniqueOwners.length <= 1) continue;
    throw new Error(
      `Direct dependency artifact collision for ${selector}: `
      + `${uniqueOwners.map((owner) => `${owner.node.id} required by ${owner.node.requiredBy.join(", ")}`).join("; ")}. `
      + "Resolve by aliasing, deselecting one artifact, or overriding the dependency selection.",
    );
  }
}

function graphNodeId(name: string, version: string, normalizedSource: string, resolvedCommit: string | undefined, sourceHash: string): GraphNodeId {
  const digest = createHash("sha256")
    .update(normalizedSource)
    .update("\0")
    .update(resolvedCommit ?? sourceHash)
    .digest("hex")
    .slice(0, 12);
  return `${name}@${version}+${digest}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      out[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return out;
}
