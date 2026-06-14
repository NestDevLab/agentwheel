import type { InstallPlan, PlanAction } from "../install/plan.js";
import { summarizePlan } from "../install/plan.js";
import type { GraphSourcePlanResult } from "../lifecycle/source-plan.js";
import type { GraphLock } from "../model/graph-lock.js";
import type { InstallManifest } from "../model/manifest.js";
import type { ResolvedGraph } from "../resolve/graph.js";

const labels: Record<PlanAction, string> = {
  create: "CREATE",
  update: "UPDATE",
  skip: "SKIP",
  remove: "REMOVE",
  keep: "KEEP",
  drift: "DRIFT",
  conflict: "CONFLICT",
  plugin: "PLUGIN",
  program: "PROGRAM",
};

const channelLabels = {
  managed: "MANAGED",
  overlay: "OVERLAY",
  addition: "ADDITION",
  override: "OVERRIDE",
  ejected: "EJECTED",
};

export function formatPlan(plan: InstallPlan): string {
  const lines = [`Plan for ${plan.adapter} at ${plan.targetRoot}`];
  if (plan.migrationReport) {
    const dropped = plan.migrationReport.dropped.length > 0 ? `; dropped unmanaged ${plan.migrationReport.dropped.join(", ")}` : "";
    lines.push(`MIGRATE  adopted ${plan.migrationReport.adopted} legacy entries${dropped}`);
  }
  for (const operation of sortedPlanOperations(plan.operations)) {
    const source = operation.sourcePath ? `${operation.sourcePath} -> ` : "";
    const command = operation.semanticCommand ? ` :: ${operation.semanticCommand.join(" ")}` : "";
    const blocked = operation.blockedReason ? `; ${operation.blockedReason}` : "";
    lines.push(`${labels[operation.action].padEnd(8)} ${channelLabels[operation.channel].padEnd(8)} ${operation.artifactType}/${operation.artifactName} ${source}${operation.relativeDestPath} (${operation.reason}${blocked})${command}`);
  }
  const summary = summarizePlan(plan);
  lines.push(
    `Summary: create ${summary.create}, update ${summary.update}, skip ${summary.skip}, remove ${summary.remove}, keep ${summary.keep}, drift ${summary.drift}, conflict ${summary.conflict}, plugin ${summary.plugin}`,
  );
  return lines.join("\n");
}

function sortedPlanOperations(operations: InstallPlan["operations"]): InstallPlan["operations"] {
  return [...operations].sort((a, b) => {
    const destructiveA = a.action === "remove" || a.action === "drift" || a.action === "conflict";
    const destructiveB = b.action === "remove" || b.action === "drift" || b.action === "conflict";
    if (destructiveA !== destructiveB) return destructiveA ? -1 : 1;
    return a.relativeDestPath.localeCompare(b.relativeDestPath);
  });
}

export function formatGraphPlan(result: GraphSourcePlanResult): string {
  const lines = [
    ...formatDependencyTree(result.graph),
    `LOCK    ${result.graphLockPath} (${result.graphLockDigest})`,
  ];
  if (result.recoveredPendingApply) {
    lines.push("RECOVER recovered pending apply journal before planning");
  }
  for (const warning of result.warnings) {
    lines.push(`WARN    ${warning}`);
  }
  if (result.newTransitiveSources.length > 0) {
    for (const source of result.newTransitiveSources) {
      lines.push(`TRUST   ${source}`);
    }
  }
  for (const edge of result.bundle.graphLock.canonical.includeEdges) {
    lines.push(`INCLUDE ${edge.fromNodeId} <- ${edge.toNodeId}:${edge.selector} via ${edge.alias} sha256:${edge.sourceHash.slice(0, 16)}`);
  }
  for (const decision of result.bundle.graphLock.canonical.namespacing) {
    lines.push(`NAMESPACE ${decision.graphNodeId}:${decision.type}/${decision.name} -> ${decision.type}/${decision.installName} (${decision.reason})`);
  }
  for (const decision of result.bundle.graphLock.canonical.overrides) {
    lines.push(`OVERRIDE ${decision.graphNodeId}:${decision.type}/${decision.name} replaces ${decision.overriddenGraphNodeId}:${decision.type}/${decision.name} via ${decision.rootId} (${decision.selector})`);
  }
  if (result.graphDiff.length > 0) {
    lines.push("Graph diff:");
    lines.push(...result.graphDiff);
  }
  lines.push(formatPlan(result.plan));
  return lines.join("\n");
}

export function formatDependencyTree(graph: ResolvedGraph): string[] {
  const lines = ["Dependency graph"];
  for (const raw of graph.rawNodes.sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id))) {
    const label = raw.depth === 0 ? "RESOLVE" : "HOIST";
    const selected = raw.node.selected.length > 0 ? formatSelected(raw.node.selected, raw.node.selectionReasons) : "<none>";
    const requiredBy = raw.node.requiredBy.length > 0 ? raw.node.requiredBy.join(",") : "<root>";
    lines.push(`${label.padEnd(7)} ${raw.node.id} source=${raw.node.normalizedSource} selected=[${selected}] requiredBy=[${requiredBy}]`);
  }
  for (const edge of graph.edges) {
    const selected = edge.selected.length > 0 ? edge.selected.join(",") : "<none>";
    lines.push(`EDGE    ${edge.from} --${edge.alias}--> ${edge.to} selected=[${selected}]`);
  }
  return lines;
}

export function formatLockDependencyTree(lock: GraphLock): string {
  const depths = lockNodeDepths(lock);
  const lines = ["Dependency graph"];
  for (const node of [...lock.canonical.nodes].sort((a, b) => (depths.get(a.id) ?? 99) - (depths.get(b.id) ?? 99) || a.id.localeCompare(b.id))) {
    const label = (depths.get(node.id) ?? 0) === 0 ? "RESOLVE" : "HOIST";
    const selected = node.selected.length > 0 ? formatSelected(node.selected, node.selectionReasons) : "<none>";
    const requiredBy = node.requiredBy.length > 0 ? node.requiredBy.join(",") : "<root>";
    lines.push(`${label.padEnd(7)} ${node.id} source=${node.normalizedSource} selected=[${selected}] requiredBy=[${requiredBy}]`);
  }
  for (const edge of lock.canonical.edges) {
    const selected = edge.selected.length > 0 ? edge.selected.join(",") : "<none>";
    lines.push(`EDGE    ${edge.from} --${edge.alias}--> ${edge.to} selected=[${selected}]`);
  }
  for (const decision of lock.canonical.namespacing) {
    lines.push(`NAMESPACE ${decision.graphNodeId}:${decision.type}/${decision.name} -> ${decision.type}/${decision.installName} (${decision.reason})`);
  }
  for (const decision of lock.canonical.overrides) {
    lines.push(`OVERRIDE ${decision.graphNodeId}:${decision.type}/${decision.name} replaces ${decision.overriddenGraphNodeId}:${decision.type}/${decision.name} via ${decision.rootId} (${decision.selector})`);
  }
  return lines.join("\n");
}

export function formatDepsWhy(lock: GraphLock, manifest: InstallManifest | undefined, query: string): string {
  const match = findWhyArtifact(lock, manifest, query);
  if (!match) {
    throw new Error(`No locked artifact or selection matches: ${query}`);
  }

  const node = lock.canonical.nodes.find((candidate) => candidate.id === match.graphNodeId);
  const lines = [`WHY ${match.logicalSelector}`];
  if (match.installedPath) lines.push(`PATH    ${match.installedPath}`);
  if (match.installName) lines.push(`INSTALL ${match.type}/${match.installName}`);
  lines.push(`NODE    ${match.graphNodeId}${node ? ` ${node.name}@${node.version}` : ""}`);
  for (const chain of ownerChains(lock, match.graphNodeId)) {
    lines.push(`OWNER   ${chain.join(" -> ")}`);
  }
  const reasons = node?.selectionReasons?.[`${match.type}/${match.name}`] ?? [];
  for (const reason of reasons) lines.push(`SELECT  ${reason}`);
  for (const edge of lock.canonical.includeEdges.filter((edge) => edge.toNodeId === match.graphNodeId && edge.selector === `${match.type}/${match.name}`)) {
    lines.push(`SELECT  included by ${edge.fromNodeId} via ${edge.alias}`);
  }
  const namespace = lock.canonical.namespacing.find((decision) =>
    decision.graphNodeId === match.graphNodeId && decision.type === match.type && decision.name === match.name);
  lines.push(namespace
    ? `NAME    ${namespace.reason}: ${namespace.type}/${namespace.name} -> ${namespace.type}/${namespace.installName}`
    : `NAME    plain: ${match.type}/${match.name}`);
  for (const override of lock.canonical.overrides.filter((decision) =>
    decision.graphNodeId === match.graphNodeId && decision.type === match.type && decision.name === match.name)) {
    lines.push(`OVERRIDE replaces ${override.overriddenGraphNodeId}:${override.type}/${override.name} via ${override.rootId}`);
  }
  return lines.join("\n");
}

function formatSelected(selected: string[], reasons?: Record<string, string[]>): string {
  return selected.map((selector) => {
    const notes = reasons?.[selector];
    return notes?.length ? `${selector} (${notes.join("; ")})` : selector;
  }).join(",");
}

function lockNodeDepths(lock: GraphLock): Map<string, number> {
  const depths = new Map<string, number>();
  const queue = lock.canonical.roots.map((root) => ({ id: root.graphNodeId, depth: 0 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const existing = depths.get(current.id);
    if (existing !== undefined && existing <= current.depth) continue;
    depths.set(current.id, current.depth);
    for (const edge of lock.canonical.edges.filter((edge) => edge.from === current.id)) {
      queue.push({ id: edge.to, depth: current.depth + 1 });
    }
  }
  return depths;
}

interface WhyMatch {
  graphNodeId: string;
  logicalSelector: string;
  type: string;
  name: string;
  installName?: string;
  installedPath?: string;
}

function findWhyArtifact(lock: GraphLock, manifest: InstallManifest | undefined, query: string): WhyMatch | undefined {
  const manifestEntry = manifest?.entries.find((entry) =>
    entry.path === query || entryLogicalSelector(entry) === query || `${entry.artifactType}/${entryInstallName(entry)}` === query);
  const logicalQuery = manifestEntry ? entryLogicalSelector(manifestEntry) : query;
  const artifact = lock.canonical.artifacts.find((item) =>
    item.logicalSelector === logicalQuery
    || `${item.graphNodeId}:${item.type}/${item.name}` === logicalQuery
    || `${item.type}/${item.installName}` === logicalQuery);
  if (artifact) {
    return {
      graphNodeId: artifact.graphNodeId,
      logicalSelector: artifact.logicalSelector,
      type: artifact.type,
      name: artifact.name,
      installName: artifact.installName,
      installedPath: manifestEntry?.path,
    };
  }

  const selectorMatch = /^(.+):(instructions|rules|skills|commands|subagents|mcp|hooks|settings|plugins|fragments)\/(.+)$/.exec(logicalQuery);
  if (!selectorMatch) return undefined;
  const [, nodeId, type, name] = selectorMatch;
  const node = lock.canonical.nodes.find((candidate) => candidate.id === nodeId || candidate.name === nodeId);
  if (!node?.selected.includes(`${type}/${name}`)) return undefined;
  return { graphNodeId: node.id, logicalSelector: `${node.id}:${type}/${name}`, type, name };
}

function entryLogicalSelector(entry: InstallManifest["entries"][number]): string {
  return "logicalSelector" in entry && entry.logicalSelector ? entry.logicalSelector : `${entry.artifactType}/${entry.artifactName}`;
}

function entryInstallName(entry: InstallManifest["entries"][number]): string {
  return "installName" in entry ? entry.installName : entry.artifactName;
}

function ownerChains(lock: GraphLock, nodeId: string): string[][] {
  const roots = new Map(lock.canonical.roots.map((root) => [root.graphNodeId, root.rootId]));
  const incoming = lock.canonical.edges.filter((edge) => edge.to === nodeId);
  if (roots.has(nodeId) || incoming.length === 0) return [[`workspace:${roots.get(nodeId) ?? nodeId}`, nodeId]];
  return incoming.flatMap((edge) => ownerChains(lock, edge.from).map((chain) => [...chain, `${edge.alias}:${nodeId}`]));
}
