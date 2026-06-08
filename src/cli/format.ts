import type { InstallPlan, PlanAction } from "../install/plan.js";
import { summarizePlan } from "../install/plan.js";

const labels: Record<PlanAction, string> = {
  create: "CREATE",
  update: "UPDATE",
  skip: "SKIP",
  remove: "REMOVE",
  drift: "DRIFT",
  conflict: "CONFLICT",
  plugin: "PLUGIN",
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
  for (const operation of plan.operations) {
    const source = operation.sourcePath ? `${operation.sourcePath} -> ` : "";
    const command = operation.semanticCommand ? ` :: ${operation.semanticCommand.join(" ")}` : "";
    lines.push(`${labels[operation.action].padEnd(8)} ${channelLabels[operation.channel].padEnd(8)} ${operation.artifactType}/${operation.artifactName} ${source}${operation.relativeDestPath} (${operation.reason})${command}`);
  }
  const summary = summarizePlan(plan);
  lines.push(
    `Summary: create ${summary.create}, update ${summary.update}, skip ${summary.skip}, remove ${summary.remove}, drift ${summary.drift}, conflict ${summary.conflict}, plugin ${summary.plugin}`,
  );
  return lines.join("\n");
}
