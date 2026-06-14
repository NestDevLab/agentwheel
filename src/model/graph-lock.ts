import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { artifactTypeSchema, composedFromEntrySchema, fileKindSchema } from "./artifact.js";

export const graphLockNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  normalizedSource: z.string().min(1),
  driver: z.string().min(1),
  requestedRef: z.string().min(1).optional(),
  resolvedCommit: z.string().min(1).optional(),
  sourceHash: z.string().min(16),
  mode: z.enum(["pinned", "tracking"]),
  requiredBy: z.array(z.string().min(1)),
  selected: z.array(z.string().min(1)),
  selectionReasons: z.record(z.string(), z.array(z.string().min(1))).optional(),
});

export const graphLockRootSchema = z.object({
  rootId: z.string().min(1),
  source: z.string().min(1),
  normalizedSource: z.string().min(1),
  graphNodeId: z.string().min(1),
  mode: z.enum(["pinned", "tracking"]),
  selected: z.array(z.string().min(1)),
  aliases: z.record(z.string(), z.string().min(1)).optional(),
  overrides: z.array(z.string().min(1)).optional(),
});

export const graphLockEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  alias: z.string().min(1),
  source: z.string().min(1),
  normalizedSource: z.string().min(1),
  requestedRef: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  mode: z.enum(["pinned", "tracking"]),
  optional: z.boolean().default(false),
  selected: z.array(z.string().min(1)),
});

export const graphLockIncludeEdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  alias: z.string().min(1),
  toNodeId: z.string().min(1),
  selector: z.string().min(1),
  sourceHash: z.string().min(16),
});

export const graphLockArtifactSchema = z.object({
  graphNodeId: z.string().min(1),
  dependencyRole: z.enum(["root", "direct", "transitive", "fragment"]),
  type: artifactTypeSchema,
  name: z.string().min(1),
  installName: z.string().min(1),
  logicalSelector: z.string().min(1),
  owners: z.array(z.string().min(1)),
  relativePath: z.string().min(1),
  kind: fileKindSchema,
  hash: z.string().min(16),
  channel: z.enum(["managed", "overlay", "addition", "override", "ejected"]).default("managed"),
  composedFrom: z.array(composedFromEntrySchema).optional(),
});

export const graphLockPlainNameIncumbentSchema = z.object({
  adapter: z.string().min(1),
  targetFingerprint: z.string().min(1),
  type: artifactTypeSchema,
  name: z.string().min(1),
  graphNodeId: z.string().min(1),
});

export const graphLockNamespacingSchema = z.object({
  graphNodeId: z.string().min(1),
  type: artifactTypeSchema,
  name: z.string().min(1),
  installName: z.string().min(1),
  reason: z.enum(["alias", "transitive-collision"]),
});

export const graphLockOverrideSchema = z.object({
  rootId: z.string().min(1),
  selector: z.string().min(1),
  graphNodeId: z.string().min(1),
  overriddenGraphNodeId: z.string().min(1),
  type: artifactTypeSchema,
  name: z.string().min(1),
  installName: z.string().min(1),
});

export const graphLockCanonicalSchema = z.object({
  targetFingerprint: z.string().min(1).optional(),
  roots: z.array(graphLockRootSchema),
  nodes: z.array(graphLockNodeSchema),
  edges: z.array(graphLockEdgeSchema),
  includeEdges: z.array(graphLockIncludeEdgeSchema).default([]),
  artifacts: z.array(graphLockArtifactSchema).default([]),
  namespacing: z.array(graphLockNamespacingSchema).default([]),
  overrides: z.array(graphLockOverrideSchema).default([]),
  plainNameIncumbents: z.array(graphLockPlainNameIncumbentSchema).default([]),
});

export const graphLockSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime().optional(),
  canonical: graphLockCanonicalSchema,
});

export type GraphLockNode = z.infer<typeof graphLockNodeSchema>;
export type GraphLockRoot = z.infer<typeof graphLockRootSchema>;
export type GraphLockEdge = z.infer<typeof graphLockEdgeSchema>;
export type GraphLockIncludeEdge = z.infer<typeof graphLockIncludeEdgeSchema>;
export type GraphLockArtifact = z.infer<typeof graphLockArtifactSchema>;
export type GraphLockPlainNameIncumbent = z.infer<typeof graphLockPlainNameIncumbentSchema>;
export type GraphLockNamespacing = z.infer<typeof graphLockNamespacingSchema>;
export type GraphLockOverride = z.infer<typeof graphLockOverrideSchema>;
export type GraphLockCanonical = z.infer<typeof graphLockCanonicalSchema>;
export type GraphLock = z.infer<typeof graphLockSchema>;

export async function readGraphLock(path: string): Promise<GraphLock> {
  return canonicalizeGraphLock(graphLockSchema.parse(JSON.parse(await readFile(path, "utf8"))));
}

export async function writeGraphLock(path: string, lock: GraphLock): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, stringifyGraphLock(lock), "utf8");
  await rename(temp, path);
}

export function stringifyGraphLock(lock: GraphLock): string {
  return `${stableStringify(canonicalizeGraphLock(lock))}\n`;
}

export function canonicalGraphLockJson(lock: GraphLock): string {
  return `${stableStringify(canonicalizeGraphLock(lock).canonical)}\n`;
}

export function canonicalizeGraphLock(lock: GraphLock): GraphLock {
  const parsed = graphLockSchema.parse(lock);
  return {
    version: 1,
    canonical: {
      targetFingerprint: parsed.canonical.targetFingerprint,
      roots: [...parsed.canonical.roots]
        .map((root) => ({
          ...root,
          selected: sortedUnique(root.selected),
          overrides: root.overrides ? sortedUnique(root.overrides) : undefined,
        }))
        .sort((a, b) => `${a.rootId}:${a.graphNodeId}`.localeCompare(`${b.rootId}:${b.graphNodeId}`)),
      nodes: [...parsed.canonical.nodes]
        .map((node) => ({
          ...node,
          requiredBy: sortedUnique(node.requiredBy),
          selected: sortedUnique(node.selected),
          selectionReasons: canonicalSelectionReasons(node.selectionReasons),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...parsed.canonical.edges]
        .map((edge) => ({ ...edge, selected: sortedUnique(edge.selected) }))
        .sort((a, b) => `${a.from}:${a.alias}:${a.to}`.localeCompare(`${b.from}:${b.alias}:${b.to}`)),
      includeEdges: [...parsed.canonical.includeEdges]
        .sort((a, b) => `${a.fromNodeId}:${a.alias}:${a.toNodeId}:${a.selector}`.localeCompare(`${b.fromNodeId}:${b.alias}:${b.toNodeId}:${b.selector}`)),
      artifacts: [...parsed.canonical.artifacts]
        .map((artifact) => ({ ...artifact, owners: sortedUnique(artifact.owners) }))
        .sort((a, b) => a.logicalSelector.localeCompare(b.logicalSelector)),
      namespacing: [...parsed.canonical.namespacing]
        .sort((a, b) => `${a.type}:${a.installName}:${a.graphNodeId}:${a.name}`.localeCompare(`${b.type}:${b.installName}:${b.graphNodeId}:${b.name}`)),
      overrides: [...parsed.canonical.overrides]
        .sort((a, b) => `${a.type}:${a.installName}:${a.graphNodeId}:${a.overriddenGraphNodeId}`.localeCompare(`${b.type}:${b.installName}:${b.graphNodeId}:${b.overriddenGraphNodeId}`)),
      plainNameIncumbents: [...parsed.canonical.plainNameIncumbents]
        .sort((a, b) => `${a.adapter}:${a.targetFingerprint}:${a.type}:${a.name}`.localeCompare(`${b.adapter}:${b.targetFingerprint}:${b.type}:${b.name}`)),
    },
  };
}

function canonicalSelectionReasons(reasons: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!reasons) return undefined;
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(reasons).sort((a, b) => a.localeCompare(b))) {
    out[key] = sortedUnique(reasons[key] ?? []);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function computeTargetFingerprint(parts: unknown): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value), null, 2);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = stableValue(item);
  }
  return out;
}
