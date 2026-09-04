import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentwheelResourceRef,
  describeDirtyPathOwnership,
  lookupResourceOwners,
  resourceRefsForRepositoryPaths,
} from "../src/mutation/session-ownership.js";
import {
  acquireMutationLock,
  MutationLockContentionError,
} from "../src/mutation/receipts.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalGraphPath = process.env.AGENT_MESH_GRAPH_PATH;
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;

afterEach(async () => {
  restoreEnv("AGENT_MESH_GRAPH_PATH", originalGraphPath);
  restoreEnv("AGENTWHEEL_MUTATION_STATE_ROOT", originalStateRoot);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("Agent Mesh ownership diagnostics", () => {
  it("derives the opaque identity from the Git common directory, NUL, and normalized repository path", () => {
    const commonDir = resolve("/tmp/example-repository/.git");
    const path = ".agentwheel/config.json";
    const expected = createHash("sha256").update(commonDir).update("\0").update(path).digest("hex");
    expect(agentwheelResourceRef(commonDir, path)).toBe(`agentwheel-resource:${expected}`);
    expect(() => agentwheelResourceRef(commonDir, "../private/config.json")).toThrow(/normalized repository-relative/i);
  });

  it("keeps the identity stable across linked Git worktrees", async () => {
    const root = await tempRoot("agentwheel-linked-worktrees-");
    const primary = join(root, "primary");
    const linked = join(root, "linked");
    await mkdir(primary);
    await execFileAsync("git", ["-C", primary, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", primary, "config", "user.name", "Agentwheel Test"]);
    await execFileAsync("git", ["-C", primary, "config", "user.email", "agentwheel@example.test"]);
    await writeFile(join(primary, "config.json"), "{}\n", "utf8");
    await execFileAsync("git", ["-C", primary, "add", "config.json"]);
    await execFileAsync("git", ["-C", primary, "commit", "-m", "initial"]);
    await execFileAsync("git", ["-C", primary, "worktree", "add", "--detach", linked]);

    const primaryRef = (await resourceRefsForRepositoryPaths(primary, ["config.json"])).get("config.json");
    const linkedRef = (await resourceRefsForRepositoryPaths(linked, ["config.json"])).get("config.json");
    expect(linkedRef).toBe(primaryRef);
  });

  it("names one exact live owner with start time and rollout context", async () => {
    const repo = await gitRepo();
    const ref = (await resourceRefsForRepositoryPaths(repo, [".agentwheel/config.json"]))
      .get(".agentwheel/config.json")!;
    await writeGraph([node({
      id: "node-owner",
      tmuxTarget: "mesh-codex-rollout",
      runtimeUuid: "11111111-1111-4111-8111-111111111111",
      refs: [ref],
      summary: "the rollout",
    })]);

    const diagnostic = await describeDirtyPathOwnership(repo, [".agentwheel/config.json"]);
    expect(diagnostic).toContain("belongs to session mesh-codex-rollout, active since 2026-09-04T14:32:00.000Z on the rollout");
    expect(diagnostic).toContain("Wait for that session's handoff");
  });

  it("keeps owner unknown and lists candidates when duplicate live refs exist", async () => {
    const ref = "agentwheel-resource:" + "a".repeat(64);
    await writeGraph([
      node({ id: "node-a", tmuxTarget: "session-a", refs: [ref] }),
      node({ id: "node-b", tmuxTarget: "session-b", refs: [ref], status: "waiting" }),
    ]);

    const result = (await lookupResourceOwners([ref])).get(ref)!;
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous owner");
    expect(result.candidates.map((candidate) => candidate.sessionId)).toEqual(["session-a", "session-b"]);

    const repo = await gitRepo();
    const actualRef = (await resourceRefsForRepositoryPaths(repo, [".agentwheel/config.json"]))
      .get(".agentwheel/config.json")!;
    await writeGraph([
      node({ id: "node-a", tmuxTarget: "session-a", refs: [actualRef] }),
      node({ id: "node-b", tmuxTarget: "session-b", refs: [actualRef], status: "blocked" }),
    ]);
    const diagnostic = await describeDirtyPathOwnership(repo, [".agentwheel/config.json"]);
    expect(diagnostic).toMatch(/owner unknown.*Candidates: session session-a.*session session-b/i);
    expect(diagnostic).toContain("Ask the rollout coordinator to disambiguate");
    expect(diagnostic).toContain("do not remove the safety block");
  });

  it("does not name quiet or closed claims as live owners", async () => {
    const ref = "agentwheel-resource:" + "b".repeat(64);
    await writeGraph([
      node({ id: "node-quiet", tmuxTarget: "stale-session", refs: [ref], status: "quiet" }),
      node({ id: "node-closed", tmuxTarget: "closed-session", refs: [ref], status: "closed" }),
    ]);
    expect((await lookupResourceOwners([ref])).get(ref)).toEqual({
      kind: "unknown",
      reason: "only-inactive-matches",
    });
  });

  it("keeps missing and malformed graph projections actionable", async () => {
    const graphRoot = await tempRoot("agentwheel-missing-graph-");
    process.env.AGENT_MESH_GRAPH_PATH = join(graphRoot, "missing.json");
    const ref = "agentwheel-resource:" + "c".repeat(64);
    expect((await lookupResourceOwners([ref])).get(ref)).toEqual({ kind: "unknown", reason: "missing-graph" });

    await writeFile(process.env.AGENT_MESH_GRAPH_PATH, "{not-json\n", "utf8");
    expect((await lookupResourceOwners([ref])).get(ref)).toEqual({ kind: "unknown", reason: "malformed-graph" });

    const repo = await gitRepo();
    const diagnostic = await describeDirtyPathOwnership(repo, [".agentwheel/config.json"]);
    expect(diagnostic).toMatch(/Owner unknown.*graph projection is malformed/i);
    expect(diagnostic).toContain("Inspect the Agent Mesh session graph");
    expect(diagnostic).toContain("do not remove the safety block");
  });

  it("exposes structured lock owner facts and correlates an exact runtime UUID", async () => {
    const repositoryRoot = await tempRoot("agentwheel-lock-repo-");
    const stateRoot = await tempRoot("agentwheel-lock-state-");
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = stateRoot;
    const runtimeUuid = "22222222-2222-4222-8222-222222222222";
    await writeGraph([node({
      id: "node-lock-owner",
      tmuxTarget: "mesh-codex-lock-owner",
      runtimeUuid,
      refs: [],
      summary: "the rollout",
    })]);
    const digest = createHash("sha256").update(resolve(repositoryRoot)).digest("hex");
    const lockPath = join(stateRoot, "locks", `${digest}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1,
      operationId: "rollout-install",
      pid: process.pid,
      runtimeUuid,
      repositoryRoot,
      createdAt: "2026-09-04T14:32:00.000Z",
    })}\n`, "utf8");

    let caught: unknown;
    try {
      await acquireMutationLock(repositoryRoot, "contender");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MutationLockContentionError);
    const contention = caught as MutationLockContentionError;
    expect(contention.owner).toEqual(expect.objectContaining({
      operationId: "rollout-install",
      pid: process.pid,
      runtimeUuid,
      createdAt: "2026-09-04T14:32:00.000Z",
    }));
    expect(contention.message).toContain("Correlated to session mesh-codex-lock-owner");
    expect(contention.message).toContain("Wait for that session's handoff");
  });
});

async function writeGraph(nodes: unknown[]): Promise<void> {
  const root = await tempRoot("agentwheel-session-graph-");
  const path = join(root, "graph.json");
  process.env.AGENT_MESH_GRAPH_PATH = path;
  await writeFile(path, `${JSON.stringify({
    schema: "agent-mesh.session-graph.v1",
    generatedAt: "2026-09-04T14:33:00.000Z",
    nodes,
    edges: [],
  })}\n`, "utf8");
}

function node(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "node-default",
    agent: "codex",
    tmuxTarget: "mesh-codex-default",
    roleProfile: "developer",
    title: "Fleet rollout",
    summary: "",
    status: "active",
    domains: ["nestdevlab"],
    runtimeUuid: null,
    refs: [],
    createdAt: "2026-09-04T14:32:00.000Z",
    lastSeenAt: "2026-09-04T14:33:00.000Z",
    ...overrides,
  };
}

async function gitRepo(): Promise<string> {
  const repo = await tempRoot("agentwheel-owner-repo-");
  await execFileAsync("git", ["-C", repo, "init", "-b", "main"]);
  await mkdir(join(repo, ".agentwheel"), { recursive: true });
  await writeFile(join(repo, ".agentwheel", "config.json"), "{}\n", "utf8");
  return repo;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
