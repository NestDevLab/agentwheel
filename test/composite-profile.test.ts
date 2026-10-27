import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceConfigSchema } from "../src/model/workspace.js";
import { assertNoCompositeCycle, collectCompositeMembers, memberCommandArgs } from "../src/profile/members.js";

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
    const argsPath = join(root, "member-args.json");
    await mkdir(memberRoot, { recursive: true });
    await writeFile(cliEntry, [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify(${JSON.stringify(memberReport(memberRoot))}));`,
      "",
    ].join("\n"), "utf8");

    const members = await collectCompositeMembers({
      cliVersion: "0.14.13",
      cliEntry,
      workspaceRoot: root,
      profileName: "cluster",
      profileTtlSeconds: 86_400,
      members: [{
        id: "leaf",
        workspace: memberRoot,
        profile: "standalone",
        fleet: "example-fleet",
        transport: "local",
      }],
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
    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "--no-update-check",
      "status",
      "--fleet",
      "example-fleet",
      "--profile",
      "standalone",
      "--json",
      "--refresh",
    ]);
  });

  it("passes an explicit named fleet to every member command", () => {
    const member = {
      id: "leaf",
      workspace: "/srv/fleet-control",
      profile: "all",
      fleet: "example-fleet",
      transport: "local" as const,
    };

    expect(memberCommandArgs(member, ["status", "--profile", "all", "--json"]))
      .toEqual(["--no-update-check", "status", "--fleet", "example-fleet", "--profile", "all", "--json"]);
    expect(memberCommandArgs(member, ["install", "--profile", "all", "--dry-run"]))
      .toEqual(["--no-update-check", "install", "--fleet", "example-fleet", "--profile", "all", "--dry-run"]);
  });

  it("validates optional named-fleet member selectors", () => {
    const base = { schemaVersion: 1 as const, packages: [], registry: {}, trust: {}, agents: {} };
    const config = workspaceConfigSchema.parse({
      ...base,
      profiles: {
        cluster: {
          members: [{ id: "leaf", workspace: ".", profile: "all", fleet: "example-fleet" }],
        },
      },
    });

    expect(config.profiles.cluster).toMatchObject({
      members: [{ fleet: "example-fleet" }],
    });
    expect(() => workspaceConfigSchema.parse({
      ...base,
      profiles: {
        cluster: {
          members: [{ id: "leaf", workspace: ".", profile: "all", fleet: "invalid fleet" }],
        },
      },
    })).toThrow();
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
