import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import type { GraphLockArtifact, GraphLockIncludeEdge } from "../model/graph-lock.js";
import { artifactSelectorKey, filterArtifactsBySelection, normalizeArtifactSelectors } from "../model/selection.js";
import { expandMarkdownIncludes, type CrossPackageIncludeResolution } from "../compose/markdown.js";
import { applyCustomizations, applyFragmentCustomizations } from "../staging/customize.js";
import { stageResolvedArtifactsRaw } from "../staging/staging.js";
import { createGraphLock, type ResolvedGraph, type ResolvedGraphRawNode } from "./graph.js";

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

  for (const rawNode of graph.rawNodes) {
    if (rawNode.node.selected.length === 0) continue;
    const rawBundle = await stageResolvedArtifactsRaw(rawNode.resolved, rawNode.artifacts);
    const fragmentCustomized = targetContext.workspaceRoot && targetContext.adapter
      ? await applyFragmentCustomizations(rawBundle.artifacts, {
        workspaceRoot: targetContext.workspaceRoot,
        adapter: targetContext.adapter,
        stageRoot: rawBundle.root,
        packageName: rawNode.resolved.packageName,
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

  const sortedArtifacts = artifacts.sort((a, b) => a.logicalSelector.localeCompare(b.logicalSelector));
  return {
    root,
    nodes: graph.nodes,
    artifacts: sortedArtifacts,
    graphLock: createGraphLock(graph, sortedArtifacts.map(lockArtifactFor), targetContext.targetFingerprint, [...includeEdges.values()]),
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
