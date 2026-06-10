import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { extractOpenPackIncludeSelectors, parseOpenPackIncludeSelector } from "../compose/markdown.js";
import type { Artifact, PackageItemRequire } from "../model/artifact.js";
import { artifactTypeSchema } from "../model/artifact.js";
import type { GraphNodeId, ResolvedNode } from "../model/graph.js";
import type { GraphLock, GraphLockArtifact, GraphLockEdge, GraphLockIncludeEdge, GraphLockNode, GraphLockRoot } from "../model/graph-lock.js";
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
  noDeps?: boolean;
  frozenLock?: boolean;
  previousLock?: GraphLock;
  warn?: (message: string) => void;
  runtime?: string;
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
  integrity?: string;
  selectionReason?: string;
}

type PackageManifestV2 = Extract<PackageManifest, { schemaVersion: 2 }>;
type PackageDependencies = NonNullable<PackageManifestV2["requires"]>;
type PackageDependency = PackageDependencies[string];

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

interface FrozenNodeMatch {
  node: GraphLockNode;
  requestedRef?: string;
}

interface NodeState {
  node: ResolvedNode;
  resolved: ResolvedSource;
  manifest?: PackageManifest;
  artifacts: Artifact[];
  requiredBy: Set<string>;
  selected: Set<string>;
  selectionReasons: Map<string, Set<string>>;
  processedNeeds: Set<string>;
  processedPackageAliases: Set<string>;
  depth: number;
  fullPackageSelected: boolean;
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
  const selectedByNodeId = new Map(rawNodes.map((raw) => [raw.node.id, raw.node.selected]));
  for (const root of rootResults) {
    root.selected = selectedByNodeId.get(root.graphNodeId) ?? root.selected;
  }
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

export function createGraphLock(graph: ResolvedGraph, artifacts: GraphLockArtifact[] = [], targetFingerprint?: string, includeEdges: GraphLockIncludeEdge[] = []): GraphLock {
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
      includeEdges,
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
    const frozen = options.frozenLock ? lockedNodeForSource(normalized.normalizedSource, options.previousLock) : undefined;
    const fetched = await fetchPackage(normalized, requirement.mode, options, fetchCache, frozen?.requestedRef);
    verifyIntegrity(requirement.integrity, fetched.sourceHash, `${fetched.name}@${fetched.version}`);
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
        selectionReasons: new Map(),
        processedNeeds: new Set(),
        processedPackageAliases: new Set(),
        depth: requirement.depth,
        fullPackageSelected: false,
      };
      nodesByKey.set(nodeKey, state);
    }

    state.depth = Math.min(state.depth, requirement.depth);
    state.fullPackageSelected = state.fullPackageSelected || requirement.select === undefined;
    state.requiredBy.add(requirement.requiredBy);
    for (const selector of selected) addSelectedSelector(state, selector, requirement.selectionReason);
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
      const previous = edgeMap.get(edgeKey);
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
        selected: sortedUnique([...(previous?.selected ?? []), ...selected]),
      });
    }

    return await collectDependencyNeeds(state, fetched, options, requirement.chain);
  } catch (error) {
    if (requirement.optional) {
      const message = error instanceof Error ? error.message : String(error);
      options.warn?.(`optional dependency skipped: ${message}`);
      return [];
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nDependency chain: ${requirement.chain.join(" -> ")}`);
  }
}

async function collectDependencyNeeds(
  state: NodeState,
  fetched: FetchedPackage,
  options: ResolveGraphOptions,
  chain: string[],
): Promise<Requirement[]> {
  if (fetched.manifest?.schemaVersion !== 2) return [];

  const dependencies = fetched.manifest.requires ?? {};
  const dependencyEntries = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  const requirements: Requirement[] = [];

  if (options.noDeps) {
    warnNoDepsOnce(state, dependencyEntries.map(([alias]) => alias), options.warn);
  } else {
    for (const [alias, dependency] of dependencyEntries) {
      if (state.processedPackageAliases.has(alias)) continue;
      if (!dependency.select?.length && !(state.fullPackageSelected && dependency.select === undefined)) continue;
      state.processedPackageAliases.add(alias);
      if (!dependencyTargetsRuntime(dependency.runtimes, options.runtime, state.node.id, alias, options.warn)) continue;
      requirements.push(dependencyRequirement(state, fetched, alias, dependency, dependency.select, chain));
    }
  }

  const artifactsBySelector: Map<string, Artifact> = new Map(fetched.artifacts.map((artifact) => [artifactSelectorKey(artifact), artifact]));
  const artifactsByRelativePath: Map<string, Artifact> = new Map(fetched.artifacts.map((artifact) => [artifact.relativePath.replaceAll("\\", "/"), artifact]));

  while (true) {
    const pending = [...state.selected]
      .filter((selector) => !state.processedNeeds.has(selector))
      .sort((a, b) => a.localeCompare(b));
    if (pending.length === 0) break;

    for (const parentSelector of pending) {
      state.processedNeeds.add(parentSelector);
      const artifact = artifactsBySelector.get(parentSelector);
      if (!artifact) continue;
      if (!artifactTargetsRuntime(artifact.runtimes, options.runtime, state.node.id, parentSelector, options.warn)) continue;

      for (const requirement of artifact.requires ?? []) {
        const parsed = parseArtifactRequirement(requirement);
        if (!requirementTargetsRuntime(parsed.runtimes, options.runtime, `${state.node.id}:${parentSelector} -> ${parsed.raw}`, options.warn)) continue;
        if (parsed.alias) {
          if (options.noDeps) {
            warnNoDepsOnce(state, [parsed.alias], options.warn);
            continue;
          }
          const dependency = dependencyForAlias(dependencies, state.node.id, parsed.alias);
          if (!dependencyTargetsRuntime(dependency.runtimes, options.runtime, state.node.id, parsed.alias, options.warn)) continue;
          requirements.push(dependencyRequirement(
            state,
            fetched,
            parsed.alias,
            dependency,
            sortedUnique([...(dependency.select ?? []), parsed.selector]),
            chain,
            parsed.optional || dependency.optional === true,
            `required by ${parentSelector}`,
          ));
          continue;
        }

        if (!artifactsBySelector.has(parsed.selector)) {
          if (parsed.optional) {
            options.warn?.(`optional artifact requirement skipped: ${parsed.selector} required by ${state.node.id}:${parentSelector}`);
            continue;
          }
          throw new Error(`Artifact requirement not found in ${state.node.id}: ${parsed.selector} required by ${parentSelector}`);
        }
        addSelectedSelector(state, parsed.selector, `required by ${parentSelector}`);
      }

      for (const include of await collectIncludeNeeds(artifact, artifactsByRelativePath)) {
        if (!include.alias) continue;
        if (options.noDeps) {
          warnNoDepsOnce(state, [include.alias], options.warn);
          continue;
        }
        const dependency = dependencyForAlias(dependencies, state.node.id, include.alias);
        if (!dependencyTargetsRuntime(dependency.runtimes, options.runtime, state.node.id, include.alias, options.warn)) continue;
        requirements.push(dependencyRequirement(
          state,
          fetched,
          include.alias,
          dependency,
          sortedUnique([...(dependency.select ?? []), include.selector]),
          chain,
          include.optional || dependency.optional === true,
        ));
      }
      refreshNode(state);
    }
  }

  refreshNode(state);
  return requirements;
}

function dependencyRequirement(
  state: NodeState,
  fetched: FetchedPackage,
  alias: string,
  dependency: PackageDependency,
  select: string[] | undefined,
  chain: string[],
  optional = dependency.optional ?? false,
  selectionReason?: string,
): Requirement {
  return {
    source: dependency.source,
    select,
    mode: dependency.mode ?? "pinned",
    ref: dependency.ref,
    declaringPackageRoot: fetched.resolved.resolvedPath,
    requiredBy: state.node.id,
    alias,
    parentId: state.node.id,
    depth: state.depth + 1,
    optional,
    chain: [...chain, `${state.node.id}:${alias}`],
    version: dependency.version,
    integrity: dependency.integrity,
    selectionReason,
  };
}

function dependencyForAlias(
  dependencies: PackageDependencies,
  nodeId: string,
  alias: string,
): PackageDependency {
  const dependency = dependencies[alias];
  if (!dependency) {
    throw new Error(`Dependency alias not found in ${nodeId}: ${alias}`);
  }
  return dependency;
}

function warnNoDepsOnce(state: NodeState, aliases: string[], warn?: (message: string) => void): void {
  const unique = sortedUnique(aliases.filter(Boolean));
  if (unique.length === 0 || state.processedPackageAliases.has("__noDepsWarned")) return;
  state.processedPackageAliases.add("__noDepsWarned");
  warn?.(`--no-deps ignored dependencies for ${state.node.id}: ${unique.join(", ")}`);
}

interface ParsedArtifactRequirement {
  raw: string;
  selector: string;
  alias?: string;
  optional: boolean;
  runtimes?: string[];
}

function parseArtifactRequirement(requirement: PackageItemRequire): ParsedArtifactRequirement {
  const raw = typeof requirement === "string" ? requirement : requirement.selector;
  const parsed = parseDependencySelector(raw);
  return {
    raw,
    selector: parsed.selector,
    alias: parsed.alias,
    optional: typeof requirement === "string" ? false : requirement.optional === true,
    runtimes: typeof requirement === "string" ? undefined : requirement.runtimes,
  };
}

function parseDependencySelector(value: string): { alias?: string; selector: string } {
  const cleaned = value.trim();
  const slash = cleaned.indexOf("/");
  const colon = cleaned.indexOf(":");
  let alias: string | undefined;
  let selector = cleaned;
  if (colon >= 0 && (slash < 0 || colon < slash)) {
    alias = cleaned.slice(0, colon);
    if (!alias || alias.includes("/")) {
      throw new Error(`Invalid dependency selector alias: ${value}`);
    }
    selector = cleaned.slice(colon + 1);
  }
  const selectorSlash = selector.indexOf("/");
  if (selectorSlash <= 0 || selectorSlash === selector.length - 1) {
    throw new Error(`Invalid dependency selector: ${value}. Expected type/name or alias:type/name.`);
  }
  const type = selector.slice(0, selectorSlash);
  const parsedType = artifactTypeSchema.safeParse(type);
  if (!parsedType.success) {
    throw new Error(`Invalid dependency selector type: ${type}`);
  }
  if (selector.includes("\\") || selector.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new Error(`Invalid dependency selector path: ${value}`);
  }
  return { alias, selector: `${parsedType.data}/${selector.slice(selectorSlash + 1)}` };
}

interface IncludeNeed {
  alias?: string;
  selector: string;
  optional: boolean;
}

async function collectIncludeNeeds(artifact: Artifact, artifactsByRelativePath: Map<string, Artifact>): Promise<IncludeNeed[]> {
  const needs: IncludeNeed[] = [];
  const scanned = new Set<string>();
  const stack = await markdownFilesForArtifact(artifact);
  for (const entry of artifact.compose ?? []) {
    await collectIncludeSelector(entry.include, entry.optional === true, artifactsByRelativePath, scanned, stack, needs);
  }

  while (stack.length > 0) {
    const file = stack.shift()!;
    if (scanned.has(file)) continue;
    scanned.add(file);
    const content = await readFile(file, "utf8");
    for (const include of extractOpenPackIncludeSelectors(content)) {
      await collectIncludeSelector(include.raw, include.optional, artifactsByRelativePath, scanned, stack, needs);
    }
  }

  return uniqueIncludeNeeds(needs);
}

async function collectIncludeSelector(
  raw: string,
  optional: boolean,
  artifactsByRelativePath: Map<string, Artifact>,
  scanned: Set<string>,
  stack: string[],
  needs: IncludeNeed[],
): Promise<void> {
  const parsed = parseOpenPackIncludeSelector(raw);
  if (parsed.alias) {
    needs.push({ alias: parsed.alias, selector: parsed.selector, optional });
    return;
  }
  const artifact = artifactsByRelativePath.get(parsed.selector);
  if (!artifact) {
    if (optional) return;
    throw new Error(`OpenPack include not found: ${parsed.selector}`);
  }
  for (const file of await markdownFilesForArtifact(artifact)) {
    if (!scanned.has(file)) stack.push(file);
  }
}

function artifactTargetsRuntime(
  runtimes: string[] | undefined,
  runtime: string | undefined,
  nodeId: string,
  selector: string,
  warn?: (message: string) => void,
): boolean {
  if (!runtimes?.length || !runtime || runtimes.includes(runtime)) return true;
  warn?.(`skip artifact ${nodeId}:${selector} (not targeted: runtimes=[${runtimes.join(",")}])`);
  return false;
}

function requirementTargetsRuntime(
  runtimes: string[] | undefined,
  runtime: string | undefined,
  label: string,
  warn?: (message: string) => void,
): boolean {
  if (!runtimes?.length || !runtime || runtimes.includes(runtime)) return true;
  warn?.(`skip requirement ${label} (not targeted: runtimes=[${runtimes.join(",")}])`);
  return false;
}

async function markdownFilesForArtifact(artifact: Artifact): Promise<string[]> {
  const root = artifact.sourcePath;
  const stats = await stat(root);
  if (stats.isFile()) return extname(root).toLowerCase() === ".md" ? [root] : [];
  if (!stats.isDirectory()) return [];
  return listMarkdownFiles(root);
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function addSelectedSelector(state: NodeState, selector: string, reason?: string): void {
  state.selected.add(selector);
  if (!reason) return;
  const reasons = state.selectionReasons.get(selector) ?? new Set<string>();
  reasons.add(reason);
  state.selectionReasons.set(selector, reasons);
}

function uniqueIncludeNeeds(needs: IncludeNeed[]): IncludeNeed[] {
  const byKey = new Map(needs.map((need) => [`${need.alias ?? ""}\0${need.selector}\0${need.optional}`, need]));
  return [...byKey.values()].sort((a, b) => `${a.alias ?? ""}:${a.selector}:${a.optional}`.localeCompare(`${b.alias ?? ""}:${b.selector}:${b.optional}`));
}

function dependencyTargetsRuntime(
  runtimes: string[] | undefined,
  runtime: string | undefined,
  nodeId: string,
  alias: string,
  warn?: (message: string) => void,
): boolean {
  if (!runtimes?.length || !runtime || runtimes.includes(runtime)) return true;
  warn?.(`skip dependency ${nodeId}:${alias} (not targeted: runtimes=[${runtimes.join(",")}])`);
  return false;
}

async function fetchPackage(
  normalized: NormalizedDependencySource,
  mode: "pinned" | "tracking",
  options: ResolveGraphOptions,
  fetchCache: Map<string, Promise<FetchedPackage>>,
  refOverride?: string,
): Promise<FetchedPackage> {
  const key = `${normalized.driver}\0${normalized.normalizedSource}\0${mode}\0${refOverride ?? ""}\0${options.frozenLock ? "frozen" : ""}`;
  const existing = fetchCache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const driver = getSourceDriver(normalized.driver);
    const resolved = await driver.resolve(normalized.source, {
      cacheRoot: options.cacheRoot ?? join(options.workspaceRoot, ".agentwheel", "cache"),
      mode,
      ref: refOverride ?? normalized.requestedRef,
      frozenLock: options.frozenLock,
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

function lockedNodeForSource(normalizedSource: string, lock: GraphLock | undefined): FrozenNodeMatch {
  if (!lock) {
    throw new Error(`Frozen lock requires an existing graph lock before resolving ${normalizedSource}.`);
  }
  const matches = lock.canonical.nodes.filter((node) => node.normalizedSource === normalizedSource);
  if (matches.length === 0) {
    throw new Error(`Frozen lock cannot resolve new source: ${normalizedSource}. Run without --frozen-lock first.`);
  }
  if (matches.length > 1) {
    throw new Error(`Frozen lock has multiple nodes for ${normalizedSource}; cannot choose a cached source deterministically.`);
  }
  const node = matches[0]!;
  return {
    node,
    requestedRef: node.driver === "git" ? node.resolvedCommit ?? node.requestedRef : node.requestedRef,
  };
}

function verifyIntegrity(integrity: string | undefined, sourceHash: string, label: string): void {
  if (!integrity) return;
  const expected = integrity.replace(/^sha256[-:]/i, "");
  if (expected !== sourceHash) {
    throw new Error(`Integrity mismatch for ${label}: expected ${integrity}, got sha256-${sourceHash}`);
  }
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
  const selectionReasons: Record<string, string[]> = {};
  for (const [selector, reasons] of [...state.selectionReasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    selectionReasons[selector] = sortedUnique([...reasons]);
  }
  state.node.selectionReasons = Object.keys(selectionReasons).length > 0 ? selectionReasons : undefined;
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
