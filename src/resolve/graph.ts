import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { extractOpenPackIncludeSelectors, parseOpenPackIncludeSelector } from "../compose/markdown.js";
import type { Artifact, PackageItemRequire, PackageItemSuggest } from "../model/artifact.js";
import { artifactTypeSchema } from "../model/artifact.js";
import type { GraphNodeId, ResolvedNode } from "../model/graph.js";
import type { GraphLock, GraphLockArtifact, GraphLockEdge, GraphLockIncludeEdge, GraphLockNamespacing, GraphLockNode, GraphLockOverride, GraphLockRoot } from "../model/graph-lock.js";
import type { PackageManifest } from "../model/package.js";
import { readPackageManifest } from "../model/package.js";
import type { RegistryClient } from "../registry/client.js";
import { getSourceDriver } from "../source/index.js";
import type { ResolvedSource, SourceDriver } from "../source/types.js";
import { hashPath } from "../utils/fs.js";
import { artifactSelectorKey, normalizeArtifactSelectors } from "../model/selection.js";
import type { WorkspaceSelectionImport } from "../model/workspace.js";
import { resolveSelectionImport, type ResolvedSelectionImport } from "../model/workspace-composition.js";
import { normalizeDependencySource, type NormalizedDependencySource } from "./identity.js";
import { satisfiesVersionRange } from "./semver.js";

export interface GraphRootRequest {
  rootId?: string;
  source: string;
  select?: string[];
  selection?: WorkspaceSelectionImport;
  mode?: "pinned" | "tracking";
  ref?: string;
  aliases?: Record<string, string>;
  overrides?: string[];
  useLock?: boolean;
  includeSuggestions?: boolean;
  suggestionAliases?: string[];
}

export interface ResolveGraphOptions {
  workspaceRoot: string;
  cacheRoot?: string;
  concurrency?: number;
  registryClient?: Pick<RegistryClient, "resolve">;
  now?: () => Date;
  noDeps?: boolean;
  lockedResolution?: boolean;
  frozenLock?: boolean;
  offline?: boolean;
  previousLock?: GraphLock;
  warn?: (message: string) => void;
  runtime?: string;
  includeSuggestions?: boolean;
  suggestionAliases?: string[];
  dependencyUpdateSelectors?: string[];
}

export interface ResolvedGraphRoot {
  rootId: string;
  source: string;
  normalizedSource: string;
  graphNodeId: GraphNodeId;
  mode: "pinned" | "tracking";
  selected: string[];
  selectionImport?: ResolvedSelectionImport;
  aliases?: Record<string, string>;
  overrides?: string[];
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
  selection?: WorkspaceSelectionImport;
  mode: "pinned" | "tracking";
  ref?: string;
  declaringPackageRoot: string;
  requiredBy: string;
  rootId?: string;
  aliases?: Record<string, string>;
  overrides?: string[];
  alias?: string;
  parentId?: GraphNodeId;
  depth: number;
  optional: boolean;
  chain: string[];
  version?: string;
  integrity?: string;
  selectionReason?: string;
  useLock?: boolean;
  includeSuggestions?: boolean;
  suggestionAliases?: string[];
  updateClosure?: boolean;
}

type PackageManifestV2 = Extract<PackageManifest, { schemaVersion: 2 }>;
type PackageDependencies = NonNullable<PackageManifestV2["requires"]>;
type PackageDependency = PackageDependencies[string];
type PackageSuggestions = NonNullable<PackageManifestV2["suggests"]>;
type PackageSuggestion = PackageSuggestions[string];

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
  processedSuggestions: Set<string>;
  depth: number;
  fullPackageSelected: boolean;
  includeSuggestions: boolean;
  suggestionAliases: Set<string>;
  updateClosure: boolean;
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
  const rootResults: ResolvedGraphRoot[] = [];
  const edgeMap = new Map<string, GraphLockEdge>();
  assertDependencyUpdateSelectors(options.previousLock, options.dependencyUpdateSelectors);
  const queue: Requirement[] = roots.map((root, index) => {
    const rootId = root.rootId ?? `root-${index + 1}`;
    return {
      source: root.source,
      select: root.select,
      selection: root.selection,
      mode: root.mode ?? "pinned",
      ref: root.ref,
      declaringPackageRoot: options.workspaceRoot,
      requiredBy: `workspace:${rootId}`,
      rootId,
      aliases: root.aliases,
      overrides: root.overrides,
      useLock: root.useLock ?? options.lockedResolution,
      updateClosure: root.useLock === false,
      depth: 0,
      optional: false,
      chain: [`workspace:${rootId}`],
      includeSuggestions: root.includeSuggestions ?? options.includeSuggestions,
      suggestionAliases: sortedUnique([...(root.suggestionAliases ?? []), ...(options.suggestionAliases ?? [])]),
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
      processRequirement(requirement, options, fetchCache, nodesByKey, rootResults, edgeMap));
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

export function createGraphLock(
  graph: ResolvedGraph,
  artifacts: GraphLockArtifact[] = [],
  targetFingerprint?: string,
  includeEdges: GraphLockIncludeEdge[] = [],
  namespacing: GraphLockNamespacing[] = [],
  overrides: GraphLockOverride[] = [],
): GraphLock {
  const roots: GraphLockRoot[] = graph.roots.map((root) => ({
    rootId: root.rootId,
    source: root.source,
    normalizedSource: root.normalizedSource,
    graphNodeId: root.graphNodeId,
    mode: root.mode,
    selected: root.selected,
    aliases: root.aliases,
    overrides: root.overrides,
    selectionImport: root.selectionImport,
  }));

  return {
    version: 1,
    canonical: {
      targetFingerprint,
      roots,
      nodes: graph.nodes,
      edges: graph.edges,
      includeEdges,
      artifacts,
      namespacing,
      overrides,
      plainNameIncumbents: [],
    },
  };
}

async function processRequirement(
  requirement: Requirement,
  options: ResolveGraphOptions,
  fetchCache: Map<string, Promise<FetchedPackage>>,
  nodesByKey: Map<string, NodeState>,
  rootResults: ResolvedGraphRoot[],
  edgeMap: Map<string, GraphLockEdge>,
): Promise<Requirement[]> {
  try {
    const lockLabel = options.offline ? "Offline" : options.frozenLock ? "Frozen lock" : "Locked install";
    let lockedByReference = lockedNodeForRequirementReference(requirement, options, lockLabel);
    let normalized = lockedByReference
      ? normalizedSourceFromLockedNode(lockedByReference.node)
      : await normalizeDependencySource(requirement.source, {
          declaringPackageRoot: requirement.declaringPackageRoot,
          workspaceRoot: options.workspaceRoot,
          ref: requirement.ref,
          registryClient: options.registryClient,
        });
    if (lockedByReference && shouldCheckLockedRootSource(requirement)) {
      const declared = await normalizeDependencySource(requirement.source, {
        declaringPackageRoot: requirement.declaringPackageRoot,
        workspaceRoot: options.workspaceRoot,
        ref: requirement.ref,
        registryClient: options.registryClient,
      });
      if (lockedRootSourceDrifted(declared, lockedByReference.node)) {
        if (options.frozenLock || options.offline) {
          throw new Error(
            `${lockLabel} root '${requirement.rootId}' source differs from declared source:\n`
            + `- declared: ${declared.normalizedSource}\n`
            + `- locked: ${lockedByReference.node.normalizedSource}\n`
            + `Run without ${lockLabel === "Offline" ? "--offline" : "--frozen-lock"} first.`,
          );
        }
        lockedByReference = undefined;
        normalized = declared;
      }
    }
    const frozen = lockedByReference ?? lockedNodeForRequirement(normalized.normalizedSource, requirement, options, lockLabel);
    let fetched: FetchedPackage;
    try {
      fetched = await fetchPackage(normalized, requirement.mode, options, fetchCache, frozen?.requestedRef);
    } catch (error) {
      const usingLockedNode = frozen?.node !== undefined;
      if (!options.frozenLock && !options.offline && !usingLockedNode) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const label = frozen?.node ? `${frozen.node.id} (${normalized.normalizedSource})` : normalized.normalizedSource;
      throw new Error(`${lockLabel} cache missing or stale for locked graph node:\n- ${label}: ${message}`);
    }
    verifyIntegrity(requirement.integrity, fetched.sourceHash, `${fetched.name}@${fetched.version}`);
    if (!satisfiesVersionRange(fetched.version, requirement.version)) {
      throw new Error(`Package ${fetched.name}@${fetched.version} does not satisfy requested version ${requirement.version}`);
    }
    const nodeKey = `${normalized.normalizedSource}\0${fetched.name}`;

    let selectionImport = requirement.selection
      ? await resolveSelectionImport(fetched.resolved.resolvedPath, fetched.resolved.driver, requirement.selection)
      : undefined;
    const selected = computeSelectedSelectors(
      fetched.artifacts,
      selectionImport?.effective ?? requirement.select,
      requirement.depth === 0,
      requirement.chain,
    );
    if (selectionImport) selectionImport = { ...selectionImport, effective: selected };
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
        processedSuggestions: new Set(),
        depth: requirement.depth,
        fullPackageSelected: false,
        includeSuggestions: false,
        suggestionAliases: new Set(),
        updateClosure: false,
      };
      nodesByKey.set(nodeKey, state);
    }

    state.depth = Math.min(state.depth, requirement.depth);
    state.fullPackageSelected = state.fullPackageSelected || (requirement.select === undefined && !requirement.selection);
    state.includeSuggestions = state.includeSuggestions || requirement.includeSuggestions === true;
    state.updateClosure = state.updateClosure || requirement.updateClosure === true;
    for (const alias of requirement.suggestionAliases ?? []) state.suggestionAliases.add(alias);
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
        aliases: requirement.aliases,
        overrides: requirement.overrides,
        selectionImport,
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
  const suggestions = fetched.manifest.suggests ?? {};
  const dependencyEntries = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  const suggestionEntries = Object.entries(suggestions).sort(([a], [b]) => a.localeCompare(b));
  const suggestionOptions = suggestionOptionsForState(state, options);
  const requirements: Requirement[] = [];

  if (options.noDeps) {
    warnNoDepsOnce(state, [...dependencyEntries.map(([alias]) => alias), ...suggestionEntries.map(([alias]) => alias)], options.warn);
  } else {
    for (const [alias, dependency] of dependencyEntries) {
      if (state.processedPackageAliases.has(alias)) continue;
      if (!dependency.select?.length && !(state.fullPackageSelected && dependency.select === undefined)) continue;
      state.processedPackageAliases.add(alias);
      if (!dependencyTargetsRuntime(dependency.runtimes, options.runtime, state.node.id, alias, options.warn)) continue;
      requirements.push(dependencyRequirement(state, fetched, alias, dependency, dependency.select, chain, options));
    }
    for (const [alias, suggestion] of suggestionEntries) {
      if (state.processedSuggestions.has(alias)) continue;
      if (!shouldIncludeSuggestionAlias(alias, suggestionOptions, state.fullPackageSelected)) continue;
      if (!suggestion.select?.length && !(state.fullPackageSelected && suggestion.select === undefined) && !explicitSuggestionAlias(alias, suggestionOptions)) continue;
      state.processedSuggestions.add(alias);
      if (!dependencyTargetsRuntime(suggestion.runtimes, options.runtime, state.node.id, alias, options.warn)) continue;
      requirements.push(suggestionRequirement(state, fetched, alias, suggestion, suggestion.select, chain, suggestionOptions));
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
            options,
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

      for (const suggestion of artifact.suggests ?? []) {
        const parsed = parseArtifactSuggestion(suggestion);
        if (!shouldIncludeSuggestionAlias(parsed.alias, suggestionOptions, true)) continue;
        if (!requirementTargetsRuntime(parsed.runtimes, options.runtime, `${state.node.id}:${parentSelector} -> ${parsed.raw}`, options.warn)) continue;
        if (options.noDeps) {
          warnNoDepsOnce(state, [parsed.alias], options.warn);
          continue;
        }
        const packageSuggestion = suggestionForAlias(suggestions, state.node.id, parsed.alias);
        if (!dependencyTargetsRuntime(packageSuggestion.runtimes, options.runtime, state.node.id, parsed.alias, options.warn)) continue;
        requirements.push(suggestionRequirement(
          state,
          fetched,
          parsed.alias,
          packageSuggestion,
          combinedSelectors(packageSuggestion.select, parsed.select),
          chain,
          suggestionOptions,
          parsed.optional || shouldTreatSuggestionAsOptional(parsed.alias, packageSuggestion, suggestionOptions),
          `suggested by ${parentSelector}`,
        ));
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
          options,
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
  options: ResolveGraphOptions,
  optional = dependency.optional ?? false,
  selectionReason?: string,
): Requirement {
  const updateClosure = state.updateClosure || dependencyUpdateEdgeSelected(state.node.id, alias, options);
  return {
    source: dependency.source,
    select,
    mode: dependency.mode ?? "pinned",
    ref: dependency.ref,
    useLock: dependency.mode !== "tracking" || (options.lockedResolution === true && !updateClosure),
    updateClosure,
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
    includeSuggestions: state.includeSuggestions,
    suggestionAliases: sortedUnique([...state.suggestionAliases]),
  };
}

function suggestionRequirement(
  state: NodeState,
  fetched: FetchedPackage,
  alias: string,
  suggestion: PackageSuggestion,
  select: string[] | undefined,
  chain: string[],
  options: ResolveGraphOptions,
  optional = shouldTreatSuggestionAsOptional(alias, suggestion, options),
  selectionReason?: string,
): Requirement {
  return dependencyRequirement(
    state,
    fetched,
    alias,
    suggestion,
    select,
    chain,
    options,
    optional,
    selectionReason,
  );
}

function assertDependencyUpdateSelectors(lock: GraphLock | undefined, selectors: string[] | undefined): void {
  for (const selector of sortedUnique(selectors ?? [])) {
    if (!lock) throw new Error(`Dependency update '${selector}' requires an existing graph lock.`);
    const matches = matchingDependencyUpdateEdges(lock, selector);
    const nodeIds = new Set(matches.map((edge) => edge.to));
    if (nodeIds.size === 0) throw new Error(`Tracking dependency not found in graph lock: ${selector}`);
    if (nodeIds.size > 1) {
      throw new Error(`Dependency update selector is ambiguous: ${selector}. Use an exact node id or source.`);
    }
  }
}

function dependencyUpdateEdgeSelected(parentId: string, alias: string, options: ResolveGraphOptions): boolean {
  const lock = options.previousLock;
  if (!lock) return false;
  const selectedNodeIds = new Set((options.dependencyUpdateSelectors ?? []).flatMap((selector) =>
    matchingDependencyUpdateEdges(lock, selector).map((edge) => edge.to)));
  return lock.canonical.edges.some((edge) =>
    edge.from === parentId && edge.alias === alias && selectedNodeIds.has(edge.to));
}

function matchingDependencyUpdateEdges(lock: GraphLock, selector: string): GraphLockEdge[] {
  const nodes = new Map(lock.canonical.nodes.map((node) => [node.id, node]));
  return lock.canonical.edges.filter((edge) => {
    const node = nodes.get(edge.to);
    if (!node || node.mode !== "tracking") return false;
    return selector === edge.alias
      || selector === edge.source
      || selector === edge.normalizedSource
      || selector === node.id
      || selector === node.name
      || selector === node.source
      || selector === node.normalizedSource;
  });
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

function suggestionForAlias(
  suggestions: PackageSuggestions,
  nodeId: string,
  alias: string,
): PackageSuggestion {
  const suggestion = suggestions[alias];
  if (!suggestion) {
    throw new Error(`Suggestion alias not found in ${nodeId}: ${alias}`);
  }
  return suggestion;
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

interface ParsedArtifactSuggestion {
  raw: string;
  alias: string;
  select?: string[];
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

function parseArtifactSuggestion(suggestion: PackageItemSuggest): ParsedArtifactSuggestion {
  if (typeof suggestion === "string") {
    return {
      raw: suggestion,
      alias: suggestion,
      optional: false,
    };
  }
  return {
    raw: suggestion.alias,
    alias: suggestion.alias,
    select: suggestion.select,
    optional: suggestion.optional === true,
    runtimes: suggestion.runtimes,
  };
}

function shouldIncludeSuggestionAlias(alias: string, options: ResolveGraphOptions, includeWhenAllSuggestions: boolean): boolean {
  const aliases = new Set(options.suggestionAliases ?? []);
  if (aliases.has(alias)) return true;
  return options.includeSuggestions === true && includeWhenAllSuggestions;
}

function suggestionOptionsForState(state: NodeState, options: ResolveGraphOptions): ResolveGraphOptions {
  return {
    ...options,
    includeSuggestions: state.includeSuggestions || options.includeSuggestions === true,
    suggestionAliases: sortedUnique([...(options.suggestionAliases ?? []), ...state.suggestionAliases]),
  };
}

function explicitSuggestionAlias(alias: string, options: ResolveGraphOptions): boolean {
  return (options.suggestionAliases ?? []).includes(alias);
}

function shouldTreatSuggestionAsOptional(alias: string, suggestion: PackageSuggestion, options: ResolveGraphOptions): boolean {
  if (suggestion.optional === true) return true;
  return options.includeSuggestions === true && !(options.suggestionAliases ?? []).includes(alias);
}

function combinedSelectors(base: string[] | undefined, extra: string[] | undefined): string[] | undefined {
  const values = [...(base ?? []), ...(extra ?? [])];
  return values.length > 0 ? sortedUnique(values) : undefined;
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
  const hardLockedCheckout = options.frozenLock === true || options.offline === true;
  const key = `${normalized.driver}\0${normalized.normalizedSource}\0${mode}\0${refOverride ?? ""}\0${hardLockedCheckout ? "hard-locked" : "mutable"}`;
  const existing = fetchCache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const driver = getSourceDriver(normalized.driver);
    const resolved = await driver.resolve(normalized.source, {
      cacheRoot: options.cacheRoot ?? join(options.workspaceRoot, ".agentwheel", "cache"),
      mode,
      ref: refOverride ?? normalized.requestedRef,
      frozenLock: hardLockedCheckout,
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

function lockedNodeForRequirement(
  normalizedSource: string,
  requirement: Requirement,
  options: ResolveGraphOptions,
  label: string,
): FrozenNodeMatch | undefined {
  const hard = options.frozenLock === true || options.offline === true;
  if (!hard && !requirement.useLock) return undefined;
  if (!options.previousLock) {
    if (hard) throw new Error(`${label} requires an existing graph lock before resolving ${normalizedSource}.`);
    return undefined;
  }
  const matches = options.previousLock.canonical.nodes.filter((node) => node.normalizedSource === normalizedSource);
  if (matches.length === 0) {
    if (hard) throw new Error(`${label} cannot resolve new source: ${normalizedSource}. Run without ${label === "Offline" ? "--offline" : "--frozen-lock"} first.`);
    return undefined;
  }
  if (matches.length > 1) {
    if (!hard) return undefined;
    throw new Error(`${label} has multiple nodes for ${normalizedSource}; cannot choose a cached source deterministically.`);
  }
  const node = matches[0]!;
  return {
    node,
    requestedRef: node.driver === "git" ? node.resolvedCommit ?? node.requestedRef : node.requestedRef,
  };
}

function lockedNodeForRequirementReference(
  requirement: Requirement,
  options: ResolveGraphOptions,
  label: string,
): FrozenNodeMatch | undefined {
  const hard = options.frozenLock === true || options.offline === true;
  if (!hard && !requirement.useLock) return undefined;
  if (!options.previousLock) {
    if (hard) throw new Error(`${label} requires an existing graph lock before resolving ${requirement.source}.`);
    return undefined;
  }

  let nodeId: string | undefined;
  let description: string | undefined;
  if (requirement.depth === 0 && requirement.rootId) {
    const root = options.previousLock.canonical.roots.find((candidate) => candidate.rootId === requirement.rootId);
    nodeId = root?.graphNodeId;
    description = `root ${requirement.rootId}`;
  } else if (requirement.parentId && requirement.alias) {
    const edge = options.previousLock.canonical.edges.find((candidate) =>
      candidate.from === requirement.parentId && candidate.alias === requirement.alias);
    nodeId = edge?.to;
    description = `dependency ${requirement.parentId}:${requirement.alias}`;
  }

  if (!nodeId) {
    if (hard && description) {
      throw new Error(`${label} cannot resolve new locked ${description}. Run without ${label === "Offline" ? "--offline" : "--frozen-lock"} first.`);
    }
    return undefined;
  }

  const node = options.previousLock.canonical.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`${label} graph lock is missing node ${nodeId} for ${description ?? requirement.source}.`);
  }
  return {
    node,
    requestedRef: node.driver === "git" ? node.resolvedCommit ?? node.requestedRef : node.requestedRef,
  };
}

function shouldCheckLockedRootSource(requirement: Requirement): boolean {
  if (!requirement.useLock) return false;
  if (requirement.depth !== 0 || !requirement.rootId) return false;
  return isExplicitNonRegistrySource(requirement.source);
}

function isExplicitNonRegistrySource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed === "~"
    || trimmed.startsWith("~/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.startsWith("/")
    || trimmed.startsWith("local:")
    || trimmed.startsWith("github:")
    || trimmed.startsWith("git:")
    || trimmed.startsWith("skillkit:")
    || trimmed.startsWith("vercel:")
    || trimmed.startsWith("mcp-registry:")
    || trimmed.startsWith("clawhub:");
}

function lockedRootSourceDrifted(declared: NormalizedDependencySource, locked: GraphLockNode): boolean {
  return declared.normalizedSource !== locked.normalizedSource
    || declared.requestedRef !== locked.requestedRef;
}

function normalizedSourceFromLockedNode(node: GraphLockNode): NormalizedDependencySource {
  return {
    source: node.source,
    normalizedSource: node.normalizedSource,
    driver: node.driver as NormalizedDependencySource["driver"],
    requestedRef: node.requestedRef,
  };
}

function lockedNodeForSource(normalizedSource: string, lock: GraphLock | undefined, label: string): FrozenNodeMatch {
  if (!lock) {
    throw new Error(`${label} requires an existing graph lock before resolving ${normalizedSource}.`);
  }
  const matches = lock.canonical.nodes.filter((node) => node.normalizedSource === normalizedSource);
  if (matches.length === 0) {
    throw new Error(`${label} cannot resolve new source: ${normalizedSource}. Run without ${label === "Offline" ? "--offline" : "--frozen-lock"} first.`);
  }
  if (matches.length > 1) {
    throw new Error(`${label} has multiple nodes for ${normalizedSource}; cannot choose a cached source deterministically.`);
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
  if (isRoot && select === undefined) {
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

export function graphNodeId(name: string, version: string, normalizedSource: string, resolvedCommit: string | undefined, sourceHash: string): GraphNodeId {
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
