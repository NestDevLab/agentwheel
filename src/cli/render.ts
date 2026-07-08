import type { PlanAction } from "../install/plan.js";
import type { PlanReport, PlanReportOperation, PlanReportTarget } from "./format.js";

export type ReportFormat = "json" | "mermaid" | "html";

export interface RenderHtmlOptions {
  assets?: "inline" | "linked";
}

type Health = "ok" | "pending" | "warn" | "bad";

interface EdgePlan {
  id: string;
  packageName: string;
  packageId: string;
  targetId: string;
  operationCount: number;
  health: Health;
}

export function renderReport(report: PlanReport, format: ReportFormat): string {
  if (format === "json") return renderJson(report);
  if (format === "mermaid") return renderMermaid(report);
  return renderHtml(report);
}

export function renderJson(report: PlanReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderMermaid(report: PlanReport): string {
  const packageNames = sortedPackageNames(report);
  const packageIds = new Map(packageNames.map((name, index) => [name, `pkg_${index}`]));
  const targetIds = new Map(report.targets.map((target, index) => [targetKey(target, index), `rt_${index}`]));
  const edges = mermaidEdges(report, packageIds, targetIds);
  const targetHealth = new Map(report.targets.map((target, index): [string, Health] => [
    `rt_${index}`,
    healthForOperations(target.operations),
  ]));
  const packageHealth = new Map(packageNames.map((name): [string, Health] => [
    packageIds.get(name)!,
    worstHealth(edges.filter((edge) => edge.packageName === name).map((edge) => edge.health)),
  ]));

  const lines = [
    "flowchart LR",
    "  classDef ok fill:#dff5e3,stroke:#2f7d4f,color:#173a25",
    "  classDef pending fill:#e5f0ff,stroke:#3367b0,color:#17345f",
    "  classDef warn fill:#fff3cd,stroke:#9a6a00,color:#4f3600",
    "  classDef bad fill:#fde2e1,stroke:#b42318,color:#5f1712",
  ];

  for (const [index, target] of report.targets.entries()) {
    lines.push(`  rt_${index}["${escapeMermaidLabel(`${target.adapter}/${target.installationType}`)}"]`);
  }
  for (const name of packageNames) {
    lines.push(`  ${packageIds.get(name)!}["${escapeMermaidLabel(name)}"]`);
  }
  for (const edge of edges) {
    const label = edge.operationCount === 1 ? "1 op" : `${edge.operationCount} ops`;
    lines.push(`  ${edge.packageId} ${edge.id}@-->|${label}| ${edge.targetId}`);
  }

  for (const [id, health] of [...targetHealth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  class ${id} ${health}`);
  }
  for (const [id, health] of [...packageHealth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  class ${id} ${health}`);
  }
  for (const edge of edges) {
    lines.push(`  class ${edge.id} ${edge.health}`);
  }

  return lines.join("\n");
}

export function renderHtml(report: PlanReport, options: RenderHtmlOptions = {}): string {
  const assets = options.assets ?? "inline";
  const mermaid = renderMermaid(report);
  const totals = reportTotals(report);
  const linkedScript = assets === "linked"
    ? "\n<script src=\"mermaid.js\"></script>\n<script>if (window.mermaid) { window.mermaid.initialize({ startOnLoad: true }); }</script>"
    : "";
  const targetSections = report.targets.map((target, index) => renderTargetSection(target, index)).join("\n");
  const warnings = report.warnings.length > 0
    ? `<section class="panel"><h2>Warnings</h2><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Agentwheel Plan Report</title>",
    `<style>${htmlStyles()}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header class=\"hero\">",
    "<h1>Agentwheel Plan Report</h1>",
    `<p>${totals.targets} targets, ${totals.operations} operations, ${totals.blockingTargets} blocking targets, ${report.warnings.length} warnings</p>`,
    "</header>",
    "<section class=\"totals\" aria-label=\"Plan totals\">",
    ...summaryItems(totals.summary).map(([name, value]) => `<div><span>${escapeHtml(name)}</span><strong>${value}</strong></div>`),
    "</section>",
    warnings,
    targetSections,
    "<details class=\"panel diagram\" open>",
    "<summary>Mermaid source</summary>",
    `<pre class=\"mermaid\">${escapeHtml(mermaid)}</pre>`,
    "</details>",
    "</main>",
    linkedScript,
    "</body>",
    "</html>",
  ].filter(Boolean).join("\n");
}

function renderTargetSection(target: PlanReportTarget, index: number): string {
  return [
    `<section class="panel target ${target.hasBlockingChanges ? "is-blocking" : ""}">`,
    "<header>",
    `<h2>${escapeHtml(target.adapter)}/${escapeHtml(target.installationType)}</h2>`,
    `<p>${escapeHtml(target.targetRoot)}</p>`,
    "</header>",
    "<div class=\"summary\">",
    ...summaryItems(target.summary).map(([name, value]) => `<span><b>${value}</b> ${escapeHtml(name)}</span>`),
    "</div>",
    "<table>",
    "<thead><tr><th>Action</th><th>Channel</th><th>Artifact</th><th>Path</th><th>Reason</th></tr></thead>",
    `<tbody>${target.operations.map((operation) => renderOperationRow(operation)).join("")}</tbody>`,
    "</table>",
    `<p class="digest">Target ${index + 1} lock: ${escapeHtml(target.graphLockDigest ?? "none")}</p>`,
    "</section>",
  ].join("\n");
}

function renderOperationRow(operation: PlanReportOperation): string {
  const artifact = `${operation.artifactType}/${operation.artifactName}`;
  return [
    `<tr class="health-${healthForAction(operation.action)}">`,
    `<td>${escapeHtml(operation.action)}</td>`,
    `<td>${escapeHtml(operation.channel)}</td>`,
    `<td>${escapeHtml(artifact)}</td>`,
    `<td><code>${escapeHtml(operation.relativeDestPath)}</code></td>`,
    `<td>${escapeHtml(operation.reason)}</td>`,
    "</tr>",
  ].join("");
}

function mermaidEdges(
  report: PlanReport,
  packageIds: Map<string, string>,
  targetIds: Map<string, string>,
): EdgePlan[] {
  const edgeGroups = new Map<string, { packageName: string; targetId: string; operations: PlanReportOperation[] }>();
  for (const [targetIndex, target] of report.targets.entries()) {
    const targetId = targetIds.get(targetKey(target, targetIndex))!;
    const operationsByPackage = new Map<string, PlanReportOperation[]>();
    for (const operation of target.operations) {
      const name = operation.packageName ?? "(unowned)";
      operationsByPackage.set(name, [...(operationsByPackage.get(name) ?? []), operation]);
    }
    for (const [packageName, operations] of operationsByPackage) {
      edgeGroups.set(`${packageName}\u0000${targetId}`, { packageName, targetId, operations });
    }
  }

  return [...edgeGroups.values()]
    .sort((a, b) => a.packageName.localeCompare(b.packageName) || a.targetId.localeCompare(b.targetId))
    .map((edge, index) => ({
      id: `edge_${index}`,
      packageName: edge.packageName,
      packageId: packageIds.get(edge.packageName)!,
      targetId: edge.targetId,
      operationCount: edge.operations.length,
      health: healthForOperations(edge.operations),
    }));
}

function sortedPackageNames(report: PlanReport): string[] {
  const names = new Set<string>();
  for (const target of report.targets) {
    for (const operation of target.operations) {
      names.add(operation.packageName ?? "(unowned)");
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function targetKey(target: PlanReportTarget, index: number): string {
  return `${index}\u0000${target.adapter}\u0000${target.installationType}\u0000${target.targetRoot}`;
}

function healthForOperations(operations: PlanReportOperation[]): Health {
  return worstHealth(operations.map((operation) => healthForAction(operation.action)));
}

function worstHealth(healths: Health[]): Health {
  return healths.sort((a, b) => healthRank(b) - healthRank(a))[0] ?? "ok";
}

function healthForAction(action: PlanAction): Health {
  if (action === "conflict" || action === "remove") return "bad";
  if (action === "drift") return "warn";
  if (action === "create" || action === "update" || action === "plugin" || action === "program") return "pending";
  return "ok";
}

function healthRank(health: Health): number {
  return { ok: 0, pending: 1, warn: 2, bad: 3 }[health];
}

function reportTotals(report: PlanReport) {
  const summary = {
    create: 0,
    update: 0,
    skip: 0,
    remove: 0,
    keep: 0,
    drift: 0,
    conflict: 0,
    plugin: 0,
  };
  let operations = 0;
  for (const target of report.targets) {
    operations += target.operations.length;
    for (const [name] of summaryItems(target.summary)) {
      summary[name] += target.summary[name];
    }
  }
  return {
    targets: report.targets.length,
    operations,
    blockingTargets: report.targets.filter((target) => target.hasBlockingChanges).length,
    summary,
  };
}

function summaryItems(summary: PlanReportTarget["summary"]): Array<[keyof PlanReportTarget["summary"], number]> {
  return [
    ["create", summary.create],
    ["update", summary.update],
    ["skip", summary.skip],
    ["remove", summary.remove],
    ["keep", summary.keep],
    ["drift", summary.drift],
    ["conflict", summary.conflict],
    ["plugin", summary.plugin],
  ];
}

function escapeMermaidLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "#quot;").replaceAll("\n", " ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlStyles(): string {
  return `
:root { color-scheme: light dark; --bg: #f7f8fb; --panel: #ffffff; --text: #1d2433; --muted: #617086; --line: #d8dee9; --ok: #e7f6ec; --pending: #e7f0ff; --warn: #fff4d8; --bad: #ffe6e4; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0; }
.hero { margin-bottom: 20px; }
h1, h2, p { margin: 0; }
h1 { font-size: 28px; line-height: 1.2; }
h2 { font-size: 18px; line-height: 1.3; }
.hero p, .target header p, .digest { color: var(--muted); margin-top: 6px; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; margin-bottom: 16px; }
.totals div, .summary span { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 8px 10px; }
.totals span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; }
.totals strong { display: block; font-size: 20px; margin-top: 2px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; overflow: auto; }
.target.is-blocking { border-color: #c23a31; }
.summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.summary span { font-size: 13px; }
table { width: 100%; border-collapse: collapse; min-width: 760px; }
th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; font-size: 13px; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
pre { white-space: pre-wrap; margin: 12px 0 0; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: color-mix(in srgb, var(--panel), var(--bg) 55%); }
summary { cursor: pointer; font-weight: 700; }
.health-ok { background: var(--ok); }
.health-pending { background: var(--pending); }
.health-warn { background: var(--warn); }
.health-bad { background: var(--bad); }
@media (prefers-color-scheme: dark) {
  :root { --bg: #11151d; --panel: #191f2b; --text: #edf1f7; --muted: #a6b1c2; --line: #323b4f; --ok: #173824; --pending: #172d4f; --warn: #44330d; --bad: #4d1d1a; }
}
`.trim();
}
