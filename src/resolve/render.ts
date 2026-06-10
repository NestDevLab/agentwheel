import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import type { ResolvedArtifact, ResolvedGraphBundle } from "../model/graph.js";
import type { GraphLockArtifact } from "../model/graph-lock.js";
import { stageResolvedArtifactsRaw, renderStagedBundle } from "../staging/staging.js";
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

  for (const rawNode of graph.rawNodes) {
    if (rawNode.node.selected.length === 0) continue;

    const rawBundle = await stageResolvedArtifactsRaw(rawNode.resolved, rawNode.artifacts);
    const rendered = await renderStagedBundle(rawBundle, {
      workspaceRoot: targetContext.workspaceRoot,
      adapter: targetContext.adapter,
      select: rawNode.node.selected,
    });

    artifacts.push(...rendered.artifacts.map((artifact) => ({
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
    graphLock: createGraphLock(graph, sortedArtifacts.map(lockArtifactFor), targetContext.targetFingerprint),
  };
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
