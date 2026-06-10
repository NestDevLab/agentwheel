import type { InstallPlan, PlanAction } from "../install/plan.js";
import { summarizePlan } from "../install/plan.js";
import type { GraphSourcePlanResult } from "../lifecycle/source-plan.js";
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
  for (const operation of plan.operations) {
    const source = operation.sourcePath ? `${operation.sourcePath} -> ` : "";
    const command = operation.semanticCommand ? ` :: ${operation.semanticCommand.join(" ")}` : "";
    lines.push(`${labels[operation.action].padEnd(8)} ${channelLabels[operation.channel].padEnd(8)} ${operation.artifactType}/${operation.artifactName} ${source}${operation.relativeDestPath} (${operation.reason})${command}`);
  }
  const summary = summarizePlan(plan);
  lines.push(
    `Summary: create ${summary.create}, update ${summary.update}, skip ${summary.skip}, remove ${summary.remove}, keep ${summary.keep}, drift ${summary.drift}, conflict ${summary.conflict}, plugin ${summary.plugin}`,
  );
  return lines.join("\n");
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
  lines.push(formatPlan(result.plan));
  return lines.join("\n");
}

export function formatDependencyTree(graph: ResolvedGraph): string[] {
  const lines = ["Dependency graph"];
  for (const raw of graph.rawNodes.sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id))) {
    const label = raw.depth === 0 ? "RESOLVE" : "HOIST";
    const selected = raw.node.selected.length > 0 ? raw.node.selected.join(",") : "<none>";
    const requiredBy = raw.node.requiredBy.length > 0 ? raw.node.requiredBy.join(",") : "<root>";
    lines.push(`${label.padEnd(7)} ${raw.node.id} source=${raw.node.normalizedSource} selected=[${selected}] requiredBy=[${requiredBy}]`);
  }
  for (const edge of graph.edges) {
    const selected = edge.selected.length > 0 ? edge.selected.join(",") : "<none>";
    lines.push(`EDGE    ${edge.from} --${edge.alias}--> ${edge.to} selected=[${selected}]`);
  }
  return lines;
}
