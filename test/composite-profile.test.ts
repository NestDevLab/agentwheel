import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceConfigSchema } from "../src/model/workspace.js";
import { assertNoCompositeCycle, collectCompositeMembers } from "../src/profile/members.js";

describe("composite profiles", () => {
  it("rejects mixed profiles, duplicate member ids, and cycles", () => {
    const base = { schemaVersion: 1 as const, packages: [], registry: {}, trust: {}, agents: {} };
    expect(() => workspaceConfigSchema.parse({
      ...base,
      profiles: { invalid: { runtimes: [{ adapter: "codex" }], members: [{ id: "one", workspace: ".", profile: "leaf" }] } },
    })).toThrow();
    expect(() => workspaceConfigSchema.parse({
      ...base,
      profiles: {
        invalid: {
          members: [
            { id: "same", workspace: ".", profile: "leaf" },
            { id: "same", workspace: ".", profile: "other" },
          ],
        },
      },
    })).toThrow(/unique/i);
    expect(() => assertNoCompositeCycle("/tmp/example", "cluster", ["/tmp/example#cluster"]))
      .toThrow(/cycle/i);
  });

  it("accepts a compatible member status protocol and preserves package versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentwheel-composite-"));
    const memberRoot = join(root, "member");
    const cliEntry = join(root, "member-cli.mjs");
    await mkdir(memberRoot, { recursive: true });
    await writeFile(cliEntry, `process.stdout.write(JSON.stringify(${JSON.stringify(memberReport(memberRoot))}));\n`, "utf8");

    const members = await collectCompositeMembers({
      cliVersion: "0.14.13",
      cliEntry,
      workspaceRoot: root,
      profileName: "cluster",
      profileTtlSeconds: 86_400,
      members: [{ id: "leaf", workspace: memberRoot, profile: "standalone", transport: "local" }],
      refresh: true,
    });

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      id: "leaf",
      health: "PASS",
      agentwheelVersion: "0.14.13",
      stale: false,
    });
    expect(members[0]?.report?.targets[0]?.packages[0]).toMatchObject({
      name: "example",
      installed: "1.2.3",
      locked: "1.2.3",
      latestAllowed: "1.2.3",
      latestOverall: "2.0.0",
      policy: "^1.0.0",
    });
  });
});

function memberReport(workspace: string) {
  return {
    schemaVersion: 1,
    command: "status",
    agentwheelVersion: "0.14.13",
    generatedAt: "2026-07-23T00:00:00.000Z",
    workspace,
    profile: "standalone",
    health: "PASS",
    repository: {
      available: true,
      branch: "main",
      head: "0123456789abcdef",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
    },
    targets: [{
      adapter: "codex",
      installationType: "local",
      targetRoot: workspace,
      health: "PASS",
      manifestRevision: "0123456789abcdef",
      manifestEntryCount: 1,
      graphLockPath: join(workspace, ".agentwheel", "graph-lock.json"),
      packageCount: 1,
      artifactCount: 1,
      pendingCount: 0,
      driftCount: 0,
      conflictCount: 0,
      packages: [{
        name: "example",
        source: "git:example",
        mode: "tracking",
        policy: "^1.0.0",
        installed: "1.2.3",
        locked: "1.2.3",
        latestAllowed: "1.2.3",
        latestOverall: "2.0.0",
        availability: "FRESH",
        checkedAt: "2026-07-23T00:00:00.000Z",
        updateAvailableAllowed: false,
        updateAvailableOverall: true,
      }],
      artifacts: [{
        selector: "example@1.2.3:skills/example",
        type: "skills",
        name: "example",
        installName: "example",
        packageName: "example",
        packageVersion: "1.2.3",
        hash: "0123456789abcdef",
        installed: true,
      }],
    }],
    members: [],
  };
}
