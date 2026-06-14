import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import type { GraphLockArtifact, GraphLockIncludeEdge, GraphLockNamespacing, GraphLockOverride } from "../model/graph-lock.js";
import { artifactSelectorKey, filterArtifactsBySelection, normalizeArtifactSelectors } from "../model/selection.js";
import { expandMarkdownIncludes, type CrossPackageIncludeResolution } from "../compose/markdown.js";
import { applyCustomizations, applyFragmentCustomizations } from "../staging/customize.js";
import { stageResolvedArtifactsRaw } from "../staging/staging.js";
import { createGraphLock, type ResolvedGraph, type ResolvedGraphRawNode } from "./graph.js";
import { semverMajorOrVersion } from "./semver.js";

export interface GraphRenderTargetContext {
  workspaceRoot?: string;
  adapter?: AdapterConfig;
  targetFingerprint?: string;
}

export async function renderGraphForTarget(
  graph: ResolvedGraph,
  targetContext: GraphRenderTargetContext = {},
): Promise<ResolvedGraphBundle> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-render-"));
  const artifacts: ResolvedArtifact[] = [];
  const stagedNodes = new Map<string, StagedGraphNode>();
  const includeEdges = new Map<string, GraphLockIncludeEdge>();
  const ambiguousPackageNames = ambiguousGraphPackageNames(graph);

  for (const rawNode of graph.rawNodes) {
    if (rawNode.node.selected.length === 0) continue;
    const rawBundle = await stageResolvedArtifactsRaw(rawNode.resolved, rawNode.artifacts);
    const fragmentCustomized = targetContext.workspaceRoot && targetContext.adapter
      ? await applyFragmentCustomizations(rawBundle.artifacts, {
        workspaceRoot: targetContext.workspaceRoot,
        adapter: targetContext.adapter,
        stageRoot: rawBundle.root,
        packageName: rawNode.resolved.packageName,
        packageVersion: rawNode.resolved.packageVersion,
        graphNodeId: rawNode.node.id,
        packageNameAmbiguous: ambiguousPackageNames.has(rawNode.node.name),
      })
      : rawBundle.artifacts;
    stagedNodes.set(rawNode.node.id, {
      rawNode,
      root: rawBundle.root,
      artifacts: fragmentCustomized,
      artifactPaths: artifactPathMap(fragmentCustomized),
      artifactContent: await artifactContentMap(fragmentCustomized),
    });
  }

  const aliasEdges = aliasEdgeMap(graph);

  for (const staged of [...stagedNodes.values()].sort((a, b) => a.rawNode.node.id.localeCompare(b.rawNode.node.id))) {
    const rawNode = staged.rawNode;
    const expandedArtifacts = await expandMarkdownIncludes(staged.artifacts, staged.root, {
      nodeId: rawNode.node.id,
      originNodeId: rawNode.node.id,
      resolveCrossPackageInclude: async (request): Promise<CrossPackageIncludeResolution | undefined> => {
        const edge = aliasEdges.get(`${request.fromNodeId}\0${request.alias}`);
        if (!edge) {
          throw new Error(`Dependency alias not found in ${request.fromNodeId}: ${request.alias}`);
        }
        const target = stagedNodes.get(edge.to);
        if (!target) {
          if (request.optional) return undefined;
          throw new Error(`Dependency include target was not selected: ${edge.to}:${request.selector}`);
        }
        const sourcePath = target.artifactPaths.get(request.selector);
        if (!sourcePath) {
          if (request.optional) return undefined;
          throw new Error(`OpenPack include not found: ${edge.to}:${request.selector}`);
        }
        const sourceContent = target.artifactContent.get(request.selector);
        if (sourceContent === undefined) {
          throw new Error(`OpenPack include source is not a file: ${edge.to}:${request.selector}`);
        }
        const sourceHash = target.artifacts.find((artifact) => artifact.relativePath.replaceAll("\\", "/") === request.selector)?.hash
          ?? target.rawNode.artifacts.find((artifact) => artifact.relativePath.replaceAll("\\", "/") === request.selector)?.hash
          ?? sha256(sourceContent);
        const includeEdge = {
          fromNodeId: request.fromNodeId,
          alias: request.alias,
          toNodeId: edge.to,
          selector: request.selector,
          sourceHash,
        };
        includeEdges.set(`${includeEdge.fromNodeId}\0${includeEdge.alias}\0${includeEdge.toNodeId}\0${includeEdge.selector}\0${includeEdge.sourceHash}`, includeEdge);
        return {
          toNodeId: edge.to,
          packageRoot: target.root,
          artifactPaths: target.artifactPaths,
          sourcePath,
          sourceContent,
          sourceHash,
        };
      },
    });

    const selectedArtifacts = filterArtifactsBySelection(expandedArtifacts, rawNode.node.selected);
    const runtimeSelectedSet = new Set(normalizeArtifactSelectors(rawNode.node.selected) ?? []);
    const runtimeArtifacts = targetContext.adapter
      ? filterArtifactsByRuntime(selectedArtifacts, targetContext.adapter.name, runtimeSelectedSet)
      : selectedArtifacts;

    const renderedArtifacts = targetContext.workspaceRoot && targetContext.adapter
      ? await applyCustomizations(runtimeArtifacts, {
        workspaceRoot: targetContext.workspaceRoot,
        adapter: targetContext.adapter,
        stageRoot: staged.root,
        packageName: rawNode.resolved.packageName,
        packageVersion: rawNode.resolved.packageVersion,
        graphNodeId: rawNode.node.id,
        packageNameAmbiguous: ambiguousPackageNames.has(rawNode.node.name),
      })
      : runtimeArtifacts;

    const installableArtifacts = renderedArtifacts.filter((artifact) => rawNode.depth === 0 || artifact.type !== "fragments");
    artifacts.push(...installableArtifacts.map((artifact) => ({
      ...artifact,
      graphNodeId: rawNode.node.id,
      dependencyRole: dependencyRole(rawNode, artifact.type),
      installName: artifact.name,
      logicalSelector: `${rawNode.node.id}:${artifact.type}/${artifact.name}`,
      owners: [...rawNode.node.requiredBy].sort((a, b) => a.localeCompare(b)),
    } satisfies ResolvedArtifact)));
  }

  const { artifacts: namedArtifacts, namespacing, overrides } = assignInstallNames(graph, artifacts);
  const sortedArtifacts = namedArtifacts.sort((a, b) => a.logicalSelector.localeCompare(b.logicalSelector));
  return {
    root,
    nodes: graph.nodes,
    artifacts: sortedArtifacts,
    graphLock: createGraphLock(graph, sortedArtifacts.map(lockArtifactFor), targetContext.targetFingerprint, [...includeEdges.values()], namespacing, overrides),
  };
}

interface StagedGraphNode {
  rawNode: ResolvedGraphRawNode;
  root: string;
  artifacts: Artifact[];
  artifactPaths: Map<string, string>;
  artifactContent: Map<string, string | undefined>;
}

function aliasEdgeMap(graph: ResolvedGraph): Map<string, { to: string }> {
  return new Map(graph.edges.map((edge) => [`${edge.from}\0${edge.alias}`, { to: edge.to }]));
}

function ambiguousGraphPackageNames(graph: ResolvedGraph): Set<string> {
  const byName = groupBy(graph.nodes, (node) => node.name);
  return new Set([...byName.entries()].filter(([, nodes]) => nodes.length > 1).map(([name]) => name));
}

function artifactPathMap(artifacts: Artifact[]): Map<string, string> {
  return new Map(artifacts.map((artifact) => [artifact.relativePath.replaceAll("\\", "/"), artifact.stagedPath ?? artifact.sourcePath]));
}

async function artifactContentMap(artifacts: Artifact[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "file") continue;
    out.set(artifact.relativePath.replaceAll("\\", "/"), await readFile(artifact.stagedPath ?? artifact.sourcePath, "utf8"));
  }
  return out;
}

function filterArtifactsByRuntime(artifacts: Artifact[], adapterName: string, selectedSet: Set<string>): Artifact[] {
  return artifacts.filter((artifact) => {
    if (!artifact.runtimes?.length || artifact.runtimes.includes(adapterName)) return true;
    const selector = artifactSelectorKey(artifact);
    const reason = selectedSet.has(selector) ? "selected but not targeted" : "not targeted";
    console.warn(`skip (${reason}: runtimes=[${artifact.runtimes.join(",")}]) ${selector}`);
    return false;
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface WorkspaceAlias {
  rootId: string;
  rootNodeId: string;
  selector: string;
  installName: string;
  reachable: Set<string>;
}

interface WorkspaceOverride {
  rootId: string;
  selector: string;
  reachable: Set<string>;
}

function assignInstallNames(graph: ResolvedGraph, artifacts: ResolvedArtifact[]): { artifacts: ResolvedArtifact[]; namespacing: GraphLockNamespacing[]; overrides: GraphLockOverride[] } {
  const aliases = workspaceAliases(graph);
  validateAliasScopes(graph, artifacts, aliases);
  const decisions = new Map<string, GraphLockNamespacing>();
  const withAliases: ResolvedArtifact[] = artifacts.map((artifact) => {
    const alias = aliasForArtifact(artifact, graph, aliases);
    if (!alias) return artifact;
    const updated = { ...artifact, installName: alias };
    decisions.set(decisionKey(updated), namespaceDecision(updated, "alias"));
    return updated;
  });
  const { artifacts: withOverrides, overrides } = applyWorkspaceOverrides(graph, withAliases);

  const collisionGroups = [...groupBy(withOverrides, (artifact) => `${artifact.type}\0${artifact.installName}`).values()]
    .filter((group) => group.length > 1);
  const toRename = new Set<ResolvedArtifact>();
  for (const group of collisionGroups) {
    if (group.some((artifact) => decisions.has(decisionKey(artifact)))) throw installNameCollisionError(group);
    const pinned = group.filter((artifact) => artifact.dependencyRole !== "transitive");
    if (pinned.length > 1) throw installNameCollisionError(group);
    for (const artifact of group) {
      if (artifact.dependencyRole === "transitive") toRename.add(artifact);
    }
  }

  const used = new Map<string, ResolvedArtifact>();
  for (const artifact of withOverrides) {
    if (toRename.has(artifact)) continue;
    used.set(`${artifact.type}\0${artifact.installName}`, artifact);
  }

  const out = withOverrides.filter((artifact) => !toRename.has(artifact));
  for (const group of groupBy([...toRename], (artifact) => `${artifact.type}\0${artifact.name}`).values()) {
    const renamed = namespaceTransitiveGroup(group, used);
    for (const artifact of renamed) {
      decisions.set(decisionKey(artifact), namespaceDecision(artifact, "transitive-collision"));
      used.set(`${artifact.type}\0${artifact.installName}`, artifact);
      out.push(artifact);
    }
  }

  const finalInstallNames = new Map(out.map((artifact) => [decisionKey(artifact), artifact.installName]));
  const finalOverrides = overrides.map((override) => ({
    ...override,
    installName: finalInstallNames.get(`${override.graphNodeId}\0${override.type}\0${override.name}`) ?? override.installName,
  }));
  return { artifacts: out, namespacing: [...decisions.values()], overrides: finalOverrides };
}

function applyWorkspaceOverrides(graph: ResolvedGraph, artifacts: ResolvedArtifact[]): { artifacts: ResolvedArtifact[]; overrides: GraphLockOverride[] } {
  const directives = workspaceOverrides(graph);
  if (directives.length === 0) return { artifacts, overrides: [] };

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  let remaining = [...artifacts];
  const decisions: GraphLockOverride[] = [];

  for (const directive of directives) {
    const matched = remaining.filter((artifact) => overrideMatchesArtifact(directive.selector, artifact, nodeById.get(artifact.graphNodeId)));
    const losers = matched.filter((artifact) => !directive.reachable.has(artifact.graphNodeId));
    if (matched.length === 0) {
      throw new Error(`Workspace override ${directive.selector} from ${directive.rootId} did not match any rendered artifact.`);
    }
    if (losers.length === 0) {
      throw new Error(`Workspace override ${directive.selector} from ${directive.rootId} matched only artifacts inside the replacing root.`);
    }
    if (losers.length > 1) {
      throw new Error(`Workspace override ${directive.selector} from ${directive.rootId} matched multiple artifacts: ${losers.map((artifact) => artifact.logicalSelector).sort().join(", ")}`);
    }

    const loser = losers[0]!;
    const winners = remaining.filter((artifact) =>
      artifact !== loser
      && directive.reachable.has(artifact.graphNodeId)
      && artifact.type === loser.type
      && artifact.name === loser.name);
    if (winners.length === 0) {
      throw new Error(`Workspace override ${directive.selector} from ${directive.rootId} has no selected replacement for ${loser.type}/${loser.name}.`);
    }
    if (winners.length > 1) {
      throw new Error(`Workspace override ${directive.selector} from ${directive.rootId} has multiple selected replacements for ${loser.type}/${loser.name}: ${winners.map((artifact) => artifact.logicalSelector).sort().join(", ")}`);
    }

    const winner = winners[0]!;
    remaining = remaining.filter((artifact) => artifact !== loser);
    decisions.push({
      rootId: directive.rootId,
      selector: directive.selector,
      graphNodeId: winner.graphNodeId,
      overriddenGraphNodeId: loser.graphNodeId,
      type: winner.type,
      name: winner.name,
      installName: winner.installName,
    });
  }

  return { artifacts: remaining, overrides: decisions };
}

function namespaceTransitiveGroup(group: ResolvedArtifact[], used: Map<string, ResolvedArtifact>): ResolvedArtifact[] {
  const sorted = [...group].sort((a, b) => a.logicalSelector.localeCompare(b.logicalSelector));
  for (const level of [2, 3, 4] as const) {
    const candidates = sorted.map((artifact) => ({ artifact, installName: namespaceCandidate(artifact, level) }));
    const candidateKeys = candidates.map(({ artifact, installName }) => `${artifact.type}\0${installName}`);
    if (new Set(candidateKeys).size !== candidateKeys.length) continue;
    if (candidateKeys.some((key) => used.has(key))) continue;
    return candidates.map(({ artifact, installName }) => ({ ...artifact, installName }));
  }
  throw new Error(`Could not choose unique transitive namespace for ${sorted.map((artifact) => artifact.logicalSelector).join(", ")}`);
}

function namespaceCandidate(artifact: ResolvedArtifact, level: 2 | 3 | 4): string {
  const slug = packageSlug(artifact.packageName ?? artifact.graphNodeId.split("@")[0] ?? "package");
  if (level === 2) return `${slug}--${artifact.name}`;
  const version = versionFromGraphNodeId(artifact.graphNodeId);
  const versionPart = level === 3 ? semverMajorOrVersion(version) : `${version}+${artifact.graphNodeId.split("+").pop()?.slice(0, 8) ?? "source"}`;
  return `${slug}@${sanitizeInstallSegment(versionPart)}--${artifact.name}`;
}

function aliasForArtifact(artifact: ResolvedArtifact, graph: ResolvedGraph, aliases: WorkspaceAlias[]): string | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === artifact.graphNodeId);
  for (const alias of aliases) {
    if (!alias.reachable.has(artifact.graphNodeId)) continue;
    if (aliasMatchesArtifact(alias.selector, artifact, node)) return alias.installName;
  }
  return undefined;
}

function workspaceAliases(graph: ResolvedGraph): WorkspaceAlias[] {
  const aliases: WorkspaceAlias[] = [];
  for (const root of graph.roots) {
    const reachable = reachableNodeIds(graph, root.graphNodeId);
    for (const [selector, installName] of Object.entries(root.aliases ?? {})) {
      aliases.push({ rootId: root.rootId, rootNodeId: root.graphNodeId, selector, installName, reachable });
    }
  }
  return aliases;
}

function workspaceOverrides(graph: ResolvedGraph): WorkspaceOverride[] {
  const overrides: WorkspaceOverride[] = [];
  for (const root of graph.roots) {
    const reachable = reachableNodeIds(graph, root.graphNodeId);
    for (const selector of root.overrides ?? []) {
      overrides.push({ rootId: root.rootId, selector, reachable });
    }
  }
  return overrides;
}

function validateAliasScopes(graph: ResolvedGraph, artifacts: ResolvedArtifact[], aliases: WorkspaceAlias[]): void {
  for (const alias of aliases) {
    const matching = artifacts.filter((artifact) => {
      const node = graph.nodes.find((candidate) => candidate.id === artifact.graphNodeId);
      return aliasMatchesArtifact(alias.selector, artifact, node);
    });
    if (matching.length === 0 || matching.some((artifact) => alias.reachable.has(artifact.graphNodeId))) continue;
    throw new Error(
      `Workspace alias ${alias.selector} from ${alias.rootId} cannot rename artifacts outside that root's dependency graph: `
      + matching.map((artifact) => artifact.logicalSelector).sort().join(", "),
    );
  }
}

function aliasMatchesArtifact(selector: string, artifact: ResolvedArtifact, node: ResolvedGraph["nodes"][number] | undefined): boolean {
  const artifactSelector = `${artifact.type}/${artifact.name}`;
  return selector === `${artifact.graphNodeId}:${artifactSelector}`
    || (node !== undefined && selector === `${node.name}@${node.version}:${artifactSelector}`)
    || (node !== undefined && selector === `${node.name}:${artifactSelector}`);
}

function overrideMatchesArtifact(selector: string, artifact: ResolvedArtifact, node: ResolvedGraph["nodes"][number] | undefined): boolean {
  const sourceSeparator = selector.lastIndexOf("::");
  if (sourceSeparator >= 0) {
    const sourceSelector = selector.slice(0, sourceSeparator).trim();
    const artifactSelector = selector.slice(sourceSeparator + 2).trim();
    return artifactSelector === `${artifact.type}/${artifact.name}` && sourceMatchesArtifact(sourceSelector, node);
  }
  return aliasMatchesArtifact(selector, artifact, node);
}

function sourceMatchesArtifact(selector: string, node: ResolvedGraph["nodes"][number] | undefined): boolean {
  if (!node || selector.length === 0) return false;
  if (selector === node.source || selector === node.normalizedSource || selector === node.name || selector === node.id) return true;

  const normalized = node.normalizedSource.toLowerCase();
  const source = node.source.toLowerCase();
  const value = selector.toLowerCase();
  if (value === source || value === normalized || value === node.name.toLowerCase() || value === node.id.toLowerCase()) return true;

  const github = /^github:([^#]+?)(?:#(.+))?$/.exec(value);
  if (github) {
    const repo = github[1]!.replace(/\.git$/i, "");
    const ref = github[2];
    const prefix = `git:https://github.com/${repo}.git#`;
    return ref ? normalized.includes(`${prefix}${ref}`) : normalized.includes(prefix);
  }

  if (!value.includes(":") && value.includes("/")) {
    const repo = value.replace(/\.git$/i, "");
    return normalized.includes(`github.com/${repo}.git#`) || source.includes(`github.com/${repo}.git`);
  }

  return false;
}

function reachableNodeIds(graph: ResolvedGraph, rootNodeId: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [rootNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) {
      if (edge.from === id) queue.push(edge.to);
    }
  }
  return reachable;
}

function installNameCollisionError(group: ResolvedArtifact[]): Error {
  return new Error(`Install name collision for ${group[0]?.type}/${group[0]?.installName}: ${group.map((artifact) => artifact.logicalSelector).sort().join(" vs ")}`);
}

function namespaceDecision(artifact: ResolvedArtifact, reason: GraphLockNamespacing["reason"]): GraphLockNamespacing {
  return {
    graphNodeId: artifact.graphNodeId,
    type: artifact.type,
    name: artifact.name,
    installName: artifact.installName,
    reason,
  };
}

function decisionKey(artifact: ResolvedArtifact): string {
  return `${artifact.graphNodeId}\0${artifact.type}\0${artifact.name}`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const values = out.get(key(item)) ?? [];
    values.push(item);
    out.set(key(item), values);
  }
  return out;
}

function packageSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

function sanitizeInstallSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "") || "version";
}

function versionFromGraphNodeId(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  const plus = nodeId.lastIndexOf("+");
  if (at < 0 || plus < at) return "0.0.0";
  return nodeId.slice(at + 1, plus);
}

function dependencyRole(node: ResolvedGraphRawNode, type: string): ResolvedArtifact["dependencyRole"] {
  if (type === "fragments") return "fragment";
  if (node.depth === 0) return "root";
  if (node.depth === 1) return "direct";
  return "transitive";
}

function lockArtifactFor(artifact: ResolvedArtifact): GraphLockArtifact {
  return {
    graphNodeId: artifact.graphNodeId,
    dependencyRole: artifact.dependencyRole,
    type: artifact.type,
    name: artifact.name,
    installName: artifact.installName,
    logicalSelector: artifact.logicalSelector,
    owners: artifact.owners,
    relativePath: artifact.relativePath,
    kind: artifact.kind,
    hash: artifact.hash,
    channel: artifact.channel ?? "managed",
    composedFrom: artifact.composedFrom,
  };
}
