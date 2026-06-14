import type { GraphLock, GraphLockIncludeEdge, GraphLockNamespacing, GraphLockNode, GraphLockOverride } from "../model/graph-lock.js";

export function diffGraphLocks(previous: GraphLock | undefined, next: GraphLock): string[] {
  if (!previous) return [];
  return [
    ...diffNodes(previous.canonical.nodes, next.canonical.nodes),
    ...diffIncludeEdges(previous.canonical.includeEdges, next.canonical.includeEdges),
    ...diffNamespacing(previous.canonical.namespacing, next.canonical.namespacing),
    ...diffOverrides(previous.canonical.overrides, next.canonical.overrides),
  ];
}

function diffNodes(previous: GraphLockNode[], next: GraphLockNode[]): string[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const nextById = new Map(next.map((node) => [node.id, node]));
  const previousByStable = new Map(previous.map((node) => [stableNodeKey(node), node]));
  const nextByStable = new Map(next.map((node) => [stableNodeKey(node), node]));
  const movedOldIds = new Set<string>();
  const movedNewIds = new Set<string>();
  const lines: string[] = [];

  for (const [key, oldNode] of previousByStable) {
    const newNode = nextByStable.get(key);
    if (!newNode) continue;
    if (
      oldNode.id === newNode.id
      && oldNode.version === newNode.version
      && oldNode.resolvedCommit === newNode.resolvedCommit
      && oldNode.sourceHash === newNode.sourceHash
    ) {
      continue;
    }
    movedOldIds.add(oldNode.id);
    movedNewIds.add(newNode.id);
    lines.push(`MOVED node ${oldNode.id} -> ${newNode.id}${nodeChangeDetails(oldNode, newNode)}`);
  }

  for (const node of next) {
    if (!previousById.has(node.id) && !movedNewIds.has(node.id)) {
      lines.push(`ADDED node ${node.id} source=${node.normalizedSource}`);
    }
  }
  for (const node of previous) {
    if (!nextById.has(node.id) && !movedOldIds.has(node.id)) {
      lines.push(`REMOVED node ${node.id} source=${node.normalizedSource}`);
    }
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

function diffIncludeEdges(previous: GraphLockIncludeEdge[], next: GraphLockIncludeEdge[]): string[] {
  const previousByKey = new Map(previous.map((edge) => [includeEdgeKey(edge), edge]));
  const nextByKey = new Map(next.map((edge) => [includeEdgeKey(edge), edge]));
  const lines: string[] = [];
  for (const [key, edge] of nextByKey) {
    if (!previousByKey.has(key)) lines.push(`ADDED include ${formatIncludeEdge(edge)}`);
  }
  for (const [key, edge] of previousByKey) {
    if (!nextByKey.has(key)) lines.push(`REMOVED include ${formatIncludeEdge(edge)}`);
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

function diffNamespacing(previous: GraphLockNamespacing[], next: GraphLockNamespacing[]): string[] {
  const previousByKey = new Map(previous.map((decision) => [namespaceKey(decision), decision]));
  const nextByKey = new Map(next.map((decision) => [namespaceKey(decision), decision]));
  const lines: string[] = [];
  for (const [key, decision] of nextByKey) {
    const old = previousByKey.get(key);
    if (!old) {
      lines.push(`ADDED namespace ${formatNamespace(decision)}`);
    } else if (old.installName !== decision.installName || old.reason !== decision.reason) {
      lines.push(`CHANGED namespace ${decision.graphNodeId}:${decision.type}/${decision.name} ${old.installName} -> ${decision.installName} (${old.reason} -> ${decision.reason})`);
    }
  }
  for (const [key, decision] of previousByKey) {
    if (!nextByKey.has(key)) lines.push(`REMOVED namespace ${formatNamespace(decision)}`);
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

function diffOverrides(previous: GraphLockOverride[], next: GraphLockOverride[]): string[] {
  const previousByKey = new Map(previous.map((decision) => [overrideKey(decision), decision]));
  const nextByKey = new Map(next.map((decision) => [overrideKey(decision), decision]));
  const lines: string[] = [];
  for (const [key, decision] of nextByKey) {
    const old = previousByKey.get(key);
    if (!old) {
      lines.push(`ADDED override ${formatOverride(decision)}`);
    } else if (old.graphNodeId !== decision.graphNodeId || old.installName !== decision.installName) {
      lines.push(`CHANGED override ${decision.selector} ${old.graphNodeId}:${old.type}/${old.name} -> ${decision.graphNodeId}:${decision.type}/${decision.name}`);
    }
  }
  for (const [key, decision] of previousByKey) {
    if (!nextByKey.has(key)) lines.push(`REMOVED override ${formatOverride(decision)}`);
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

function stableNodeKey(node: GraphLockNode): string {
  return `${node.normalizedSource}\0${node.name}`;
}

function nodeChangeDetails(oldNode: GraphLockNode, newNode: GraphLockNode): string {
  const details: string[] = [];
  if (oldNode.version !== newNode.version) details.push(`version ${oldNode.version} -> ${newNode.version}`);
  if (oldNode.resolvedCommit !== newNode.resolvedCommit) details.push(`commit ${oldNode.resolvedCommit ?? "<none>"} -> ${newNode.resolvedCommit ?? "<none>"}`);
  if (oldNode.sourceHash !== newNode.sourceHash) details.push(`sourceHash ${short(oldNode.sourceHash)} -> ${short(newNode.sourceHash)}`);
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function includeEdgeKey(edge: GraphLockIncludeEdge): string {
  return `${edge.fromNodeId}\0${edge.alias}\0${edge.toNodeId}\0${edge.selector}\0${edge.sourceHash}`;
}

function formatIncludeEdge(edge: GraphLockIncludeEdge): string {
  return `${edge.fromNodeId} <- ${edge.toNodeId}:${edge.selector} via ${edge.alias} sha256:${short(edge.sourceHash)}`;
}

function namespaceKey(decision: GraphLockNamespacing): string {
  return `${decision.graphNodeId}\0${decision.type}\0${decision.name}`;
}

function overrideKey(decision: GraphLockOverride): string {
  return `${decision.rootId}\0${decision.selector}\0${decision.overriddenGraphNodeId}\0${decision.type}\0${decision.name}`;
}

function formatNamespace(decision: GraphLockNamespacing): string {
  return `${decision.graphNodeId}:${decision.type}/${decision.name} -> ${decision.type}/${decision.installName} (${decision.reason})`;
}

function formatOverride(decision: GraphLockOverride): string {
  return `${decision.graphNodeId}:${decision.type}/${decision.name} replaces ${decision.overriddenGraphNodeId}:${decision.type}/${decision.name} via ${decision.rootId} (${decision.selector})`;
}

function short(hash: string): string {
  return hash.slice(0, 12);
}
