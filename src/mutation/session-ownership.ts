import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import { runProcess } from "./process.js";

const safeSingleLineSchema = z.string().max(4096).refine(
  (value) => !/[\r\n\u0000-\u001f\u007f]/u.test(value),
  { message: "must be a single printable line" },
);
const opaqueRefSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
const graphNodeStatusSchema = z.enum(["active", "waiting", "blocked", "quiet", "closed"]);
const graphNodeSchema = z.object({
  id: safeSingleLineSchema.pipe(z.string().min(1)),
  agent: safeSingleLineSchema.pipe(z.string().min(1)),
  tmuxTarget: safeSingleLineSchema,
  roleProfile: safeSingleLineSchema.optional().default(""),
  title: safeSingleLineSchema.optional().default(""),
  summary: safeSingleLineSchema.optional().default(""),
  status: graphNodeStatusSchema,
  domains: z.array(safeSingleLineSchema).optional().default([]),
  runtimeUuid: z.string().uuid().nullable().optional().default(null),
  refs: z.array(opaqueRefSchema).optional().default([]),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
}).passthrough();
const sessionGraphSchema = z.object({
  schema: z.literal("agent-mesh.session-graph.v1"),
  generatedAt: z.string().datetime(),
  nodes: z.array(graphNodeSchema),
}).passthrough();

const liveStatuses = new Set(["active", "waiting", "blocked"]);
const runtimeUuidSchema = z.string().uuid();

export interface SessionOwnerFacts {
  nodeId: string;
  sessionId: string;
  agent: string;
  runtimeUuid: string | null;
  status: z.infer<typeof graphNodeStatusSchema>;
  domains: string[];
  createdAt: string;
  summary: string;
  title: string;
}

export type SessionOwnership =
  | { kind: "unique"; owner: SessionOwnerFacts }
  | { kind: "ambiguous"; candidates: SessionOwnerFacts[] }
  | { kind: "unknown"; reason: "missing-graph" | "malformed-graph" | "no-live-match" | "only-inactive-matches" };
type UnknownReason = Extract<SessionOwnership, { kind: "unknown" }>["reason"];

export interface MutationLockOwnerFacts {
  operationId?: string;
  pid?: number;
  runtimeUuid?: string;
  createdAt?: string;
}

export function agentMeshGraphPath(): string {
  if (process.env.AGENT_MESH_GRAPH_PATH) return resolve(process.env.AGENT_MESH_GRAPH_PATH);
  const stateRoot = process.env.XDG_STATE_HOME
    ? resolve(process.env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  return join(stateRoot, "agent-mesh", "graph", "graph.json");
}

export function agentwheelResourceRef(gitCommonDir: string, repositoryRelativePath: string): string {
  const commonDir = resolve(gitCommonDir);
  const normalizedPath = normalizeRepositoryRelativePath(repositoryRelativePath);
  const digest = createHash("sha256")
    .update(commonDir)
    .update("\0")
    .update(normalizedPath)
    .digest("hex");
  return `agentwheel-resource:${digest}`;
}

export async function resourceRefsForRepositoryPaths(
  repositoryRoot: string,
  paths: Iterable<string>,
): Promise<Map<string, string>> {
  const result = await runProcess("git", [
    "-C",
    repositoryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const gitCommonDir = result.stdout.toString("utf8").trim();
  if (!gitCommonDir || !isAbsolute(gitCommonDir)) {
    throw new Error("Git did not return an absolute common directory for ownership diagnostics.");
  }
  return new Map([...paths].map((path) => [path, agentwheelResourceRef(gitCommonDir, path)]));
}

export async function lookupResourceOwners(refs: Iterable<string>): Promise<Map<string, SessionOwnership>> {
  const requested = [...new Set(refs)];
  const graph = await readSessionGraph();
  if (!graph.ok) {
    return new Map(requested.map((ref) => [ref, { kind: "unknown", reason: graph.reason }]));
  }
  return new Map(requested.map((ref) => [ref, ownershipForNodes(
    graph.nodes.filter((node) => node.refs.includes(ref)),
  )]));
}

export async function lookupRuntimeOwner(runtimeUuid: string): Promise<SessionOwnership> {
  const graph = await readSessionGraph();
  if (!graph.ok) return { kind: "unknown", reason: graph.reason };
  const normalized = runtimeUuid.toLowerCase();
  return ownershipForNodes(graph.nodes.filter((node) => node.runtimeUuid?.toLowerCase() === normalized));
}

export async function describeDirtyPathOwnership(repositoryRoot: string, paths: string[]): Promise<string> {
  let refs: Map<string, string>;
  try {
    refs = await resourceRefsForRepositoryPaths(repositoryRoot, paths);
  } catch {
    return unknownNextAction("resource identity could not be computed");
  }
  const ownership = await lookupResourceOwners(refs.values());
  return paths.map((path) => {
    const match = ownership.get(refs.get(path)!);
    if (match?.kind === "unique") {
      return `${path}: belongs to ${describeSession(match.owner)}. Wait for that session's handoff or ask the rollout coordinator before retrying.`;
    }
    if (match?.kind === "ambiguous") {
      return `${path}: owner unknown because multiple live sessions claim this resource. Candidates: ${match.candidates.map(describeSession).join("; ")}. Ask the rollout coordinator to disambiguate the candidates before retrying; do not remove the safety block.`;
    }
    return `${path}: ${unknownNextAction(reasonText(match?.kind === "unknown" ? match.reason : "no-live-match"))}`;
  }).join(" ");
}

export async function describeMutationLockOwner(owner: MutationLockOwnerFacts | undefined): Promise<string> {
  if (!owner) {
    return unknownNextAction("the lock owner metadata is missing or malformed");
  }
  const facts = [
    owner.operationId ? `operation ${owner.operationId}` : undefined,
    owner.pid !== undefined ? `pid ${owner.pid}` : undefined,
    owner.runtimeUuid ? `runtime UUID ${owner.runtimeUuid}` : undefined,
    owner.createdAt ? `lock created at ${owner.createdAt}` : undefined,
  ].filter(Boolean).join(", ");
  if (!owner.runtimeUuid) {
    return `Lock owner facts: ${facts || "none"}. ${unknownNextAction("no runtime UUID was recorded")}`;
  }
  const match = await lookupRuntimeOwner(owner.runtimeUuid);
  if (match.kind === "unique") {
    return `Lock owner facts: ${facts}. Correlated to ${describeSession(match.owner)}. Wait for that session's handoff or ask the rollout coordinator before retrying.`;
  }
  if (match.kind === "ambiguous") {
    return `Lock owner facts: ${facts}. Owner unknown because the runtime UUID matches multiple live sessions. Candidates: ${match.candidates.map(describeSession).join("; ")}. Ask the rollout coordinator to disambiguate before retrying; do not remove the lock.`;
  }
  return `Lock owner facts: ${facts}. ${unknownNextAction(reasonText(match.reason))}`;
}

export function runtimeUuidForCurrentProcess(): string | undefined {
  for (const name of ["AGENT_MESH_RUNTIME_UUID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) {
    const value = process.env[name]?.trim();
    if (value && runtimeUuidSchema.safeParse(value).success) return value.toLowerCase();
  }
  return undefined;
}

function ownershipForNodes(nodes: Array<z.infer<typeof graphNodeSchema>>): SessionOwnership {
  const live = nodes.filter((node) => liveStatuses.has(node.status)).map(sessionFacts);
  if (live.length === 1) return { kind: "unique", owner: live[0]! };
  if (live.length > 1) return { kind: "ambiguous", candidates: live.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) };
  if (nodes.length > 0) return { kind: "unknown", reason: "only-inactive-matches" };
  return { kind: "unknown", reason: "no-live-match" };
}

async function readSessionGraph(): Promise<
  | { ok: true; nodes: Array<z.infer<typeof graphNodeSchema>> }
  | { ok: false; reason: "missing-graph" | "malformed-graph" }
> {
  let raw: string;
  try {
    raw = await readFile(agentMeshGraphPath(), "utf8");
  } catch (error) {
    if (isMissing(error)) return { ok: false, reason: "missing-graph" };
    return { ok: false, reason: "malformed-graph" };
  }
  try {
    const graph = sessionGraphSchema.parse(JSON.parse(raw));
    return { ok: true, nodes: graph.nodes };
  } catch {
    return { ok: false, reason: "malformed-graph" };
  }
}

function sessionFacts(node: z.infer<typeof graphNodeSchema>): SessionOwnerFacts {
  return {
    nodeId: node.id,
    sessionId: node.tmuxTarget || node.runtimeUuid || node.id,
    agent: node.agent,
    runtimeUuid: node.runtimeUuid,
    status: node.status,
    domains: [...node.domains],
    createdAt: node.createdAt,
    summary: node.summary,
    title: node.title,
  };
}

function describeSession(owner: SessionOwnerFacts): string {
  const context = owner.summary || owner.title || owner.domains.join(", ");
  return `session ${owner.sessionId}, ${owner.status} since ${owner.createdAt}${context ? ` on ${context}` : ""}`;
}

function unknownNextAction(reason: string): string {
  return `Owner unknown because ${reason}. Inspect the Agent Mesh session graph or ask the rollout coordinator to identify or clear the owner before retrying; do not remove the safety block based on this diagnostic.`;
}

function reasonText(reason: UnknownReason): string {
  switch (reason) {
    case "missing-graph": return "the Agent Mesh graph projection is missing";
    case "malformed-graph": return "the Agent Mesh graph projection is malformed";
    case "only-inactive-matches": return "only quiet or closed session claims were found";
    case "no-live-match": return "no live session claim matches this resource";
  }
}

function normalizeRepositoryRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new Error("Ownership paths must be normalized repository-relative paths.");
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Ownership paths must be normalized repository-relative paths.");
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
