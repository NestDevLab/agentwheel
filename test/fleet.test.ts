import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import {
  listRegisteredFleets,
  registerFleet,
  resolveWorkspaceScope,
  showRegisteredFleet,
} from "../src/model/fleet.js";
import { readMergedWorkspaceConfig, readWorkspaceConfig, workspaceConfigSchema } from "../src/model/workspace.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("named fleet config and resolution", () => {
  it("reads v1/v2 and accepts v3/v4 with optional fleet identity and home registry", () => {
    expect(workspaceConfigSchema.parse({ schemaVersion: 1 }).schemaVersion).toBe(1);
    expect(workspaceConfigSchema.parse({ schemaVersion: 2 }).schemaVersion).toBe(2);
    const parsed = workspaceConfigSchema.parse({
      schemaVersion: 3,
      fleetId: "delivery",
      fleets: {
        delivery: { root: "/srv/fleets/delivery", requiredPackages: ["core"] },
      },
    });
    expect(parsed.schemaVersion).toBe(3);
    if (parsed.schemaVersion !== 3) throw new Error("expected v3 fixture");
    expect(parsed.fleetId).toBe("delivery");
    expect(parsed.fleets.delivery?.requiredPackages).toEqual(["core"]);
    expect(workspaceConfigSchema.parse({ schemaVersion: 4, fleetId: "delivery" }).schemaVersion).toBe(4);
  });

  it.each([3, 4] as const)("registers and selects schema-v%s fleet state", async (schemaVersion) => {
    const home = await tempRoot(`agentwheel-fleet-v${schemaVersion}-home-`);
    const fleet = await tempRoot(`agentwheel-fleet-v${schemaVersion}-root-`);
    await writeConfig(home, { schemaVersion: 2 });
    await writeConfig(fleet, {
      schemaVersion,
      fleetId: "delivery",
      packages: [pkg("core")],
      ...(schemaVersion === 4 ? {
        mutationPolicy: { reason: "optional", journal: "off", revisioning: { mode: "off" } },
      } : {}),
    });

    await registerFleet({ id: "delivery", root: fleet, requiredPackages: ["core"], globalRoot: home });
    await expect(resolveWorkspaceScope({ fleet: "delivery", globalRoot: home })).resolves.toMatchObject({
      kind: "fleet",
      root: fleet,
      fleetId: "delivery",
      config: { schemaVersion },
    });
  });

  it("isolates desired state while inheriting only global registry and trust", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const local = await tempRoot("agentwheel-fleet-local-");
    await writeConfig(home, {
      schemaVersion: 2,
      packages: [pkg("home")],
      agents: { home: { adapter: "codex", root: home } },
      profiles: { home: { runtimes: [{ adapter: "codex" }] } },
      exports: { selections: { home: { select: ["skills/home"] } } },
      registry: { sources: ["https://registry.example/index.json"] },
      trust: { allow: ["github:example/*"] },
    });
    await writeConfig(local, {
      schemaVersion: 2,
      packages: [pkg("local")],
      agents: { local: { adapter: "claude", root: local } },
      profiles: { local: { runtimes: [{ adapter: "claude" }] } },
      exports: { selections: { local: { select: ["skills/local"] } } },
    });

    const merged = await readMergedWorkspaceConfig(local, { globalRoot: home });
    expect(merged.packages.map((entry) => entry.name)).toEqual(["local"]);
    expect(Object.keys(merged.agents)).toEqual(["local"]);
    expect(Object.keys(merged.profiles)).toEqual(["local"]);
    expect(merged.schemaVersion).toBe(2);
    expect(Object.keys("exports" in merged && merged.exports ? merged.exports.selections : {})).toEqual(["local"]);
    expect(merged.registry.sources).toEqual(["https://registry.example/index.json"]);
    expect(merged.trust.allow).toEqual(["github:example/*"]);
  });

  it("resolves explicit user, nearest local, and registered fleet without home fallback", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const local = await tempRoot("agentwheel-fleet-local-");
    const child = join(local, "nested", "child");
    const fleet = await tempRoot("agentwheel-fleet-root-");
    await mkdir(child, { recursive: true });
    await writeConfig(local, { schemaVersion: 2, packages: [pkg("local")] });
    await writeConfig(fleet, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
    await writeConfig(home, {
      schemaVersion: 3,
      packages: [pkg("home")],
      fleets: { delivery: { root: fleet, requiredPackages: ["core"] } },
    });

    await expect(resolveWorkspaceScope({ cwd: child, globalRoot: home })).resolves.toMatchObject({ kind: "local", root: local });
    await expect(resolveWorkspaceScope({ cwd: child, local: true, globalRoot: home })).resolves.toMatchObject({ kind: "local", root: local });
    await expect(resolveWorkspaceScope({ cwd: child, user: true, globalRoot: home })).resolves.toMatchObject({ kind: "user", root: home });
    await expect(resolveWorkspaceScope({ cwd: child, fleet: "delivery", globalRoot: home })).resolves.toMatchObject({ kind: "fleet", root: fleet, fleetId: "delivery" });

    const empty = await tempRoot("agentwheel-fleet-empty-");
    await expect(resolveWorkspaceScope({ cwd: empty, globalRoot: home })).rejects.toThrow(/--user.*--local.*--fleet.*init/s);
    await expect(resolveWorkspaceScope({ cwd: empty, local: true, globalRoot: home })).resolves.toMatchObject({
      kind: "local",
      root: empty,
      config: { schemaVersion: 1, packages: [] },
    });
  });

  it("allows fleet identity only through a registered --fleet selection", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const fleet = await tempRoot("agentwheel-fleet-root-");
    await writeConfig(fleet, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
    await writeConfig(home, {
      schemaVersion: 3,
      fleets: { delivery: { root: fleet, requiredPackages: ["core"] } },
    });

    await expect(resolveWorkspaceScope({ cwd: fleet, globalRoot: home })).rejects.toThrow(/fleet.*--fleet/i);
    await expect(resolveWorkspaceScope({ cwd: fleet, local: true, globalRoot: home })).rejects.toThrow(/fleet.*--fleet/i);
    await expect(resolveWorkspaceScope({ fleet: "delivery", globalRoot: home })).resolves.toMatchObject({
      kind: "fleet",
      root: fleet,
      fleetId: "delivery",
    });

    await writeConfig(home, { schemaVersion: 3, fleetId: "misplaced", packages: [pkg("home")] });
    await expect(resolveWorkspaceScope({ user: true, globalRoot: home })).rejects.toThrow(/user.*fleet.*--fleet/i);
  });

  it("rejects ambiguous selectors and invalid fleet registrations", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const fleet = await tempRoot("agentwheel-fleet-root-");
    await writeConfig(home, { schemaVersion: 2 });
    await writeConfig(fleet, { schemaVersion: 3, fleetId: "other", packages: [pkg("core")] });

    await expect(resolveWorkspaceScope({ cwd: fleet, user: true, local: true, globalRoot: home })).rejects.toThrow(/one workspace selector/i);
    await expect(registerFleet({ id: "delivery", root: fleet, requiredPackages: ["core"], globalRoot: home })).rejects.toThrow(/fleetId.*delivery.*other/i);

    await writeConfig(fleet, { schemaVersion: 3, fleetId: "delivery", packages: [] });
    await expect(registerFleet({ id: "delivery", root: fleet, requiredPackages: ["core"], globalRoot: home })).rejects.toThrow(/required package.*core/i);

    await writeConfig(fleet, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
    const link = `${fleet}-link`;
    roots.push(link);
    await symlink(fleet, link);
    await expect(registerFleet({ id: "delivery", root: link, requiredPackages: ["core"], globalRoot: home })).rejects.toThrow(/canonical|symlink/i);
  });

  it("registers atomically, upgrades only home to the current schema, and preserves prior fields", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const fleet = await tempRoot("agentwheel-fleet-root-");
    await writeConfig(home, { schemaVersion: 1, packages: [pkg("home")], bootstrapSkills: false });
    await writeConfig(fleet, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });

    const registered = await registerFleet({ id: "delivery", root: fleet, requiredPackages: ["core"], globalRoot: home });
    expect(registered.root).toBe(await realpath(fleet));
    const saved = await readWorkspaceConfig(home);
    expect(saved).toMatchObject({ schemaVersion: 4, bootstrapSkills: false });
    expect(saved.packages.map((entry) => entry.name)).toEqual(["home"]);
    expect(await listRegisteredFleets({ globalRoot: home })).toEqual([registered]);
    expect(await showRegisteredFleet("delivery", { globalRoot: home })).toEqual(registered);
    await expect(registerFleet({ id: "delivery", root: fleet, requiredPackages: ["core"], globalRoot: home })).rejects.toThrow(/already registered/i);
  });

  it("canonicalizes existing registry aliases and rejects duplicate canonical roots", async () => {
    const home = await tempRoot("agentwheel-fleet-home-");
    const existing = await tempRoot("agentwheel-fleet-existing-");
    const delivery = await tempRoot("agentwheel-fleet-delivery-");
    const alias = `${existing}-alias`;
    roots.push(alias);
    await symlink(existing, alias);
    await writeConfig(existing, { schemaVersion: 3, fleetId: "primary", packages: [pkg("core")] });
    await writeConfig(delivery, { schemaVersion: 3, fleetId: "delivery", packages: [pkg("core")] });
    await writeConfig(home, {
      schemaVersion: 3,
      fleets: { primary: { root: alias, requiredPackages: ["core"] } },
    });

    await expect(registerFleet({ id: "duplicate", root: existing, requiredPackages: ["core"], globalRoot: home }))
      .rejects.toThrow(/already registered as 'primary'/i);

    await registerFleet({ id: "delivery", root: delivery, requiredPackages: ["core"], globalRoot: home });
    const saved = await readWorkspaceConfig(home);
    if (saved.schemaVersion !== 4) throw new Error("expected schema v4 registry");
    expect(saved.fleets.primary?.root).toBe(await realpath(existing));
  });

  it("keeps the bounded 0.17 parser fail-closed before planning a v3 config", async () => {
    const root = await tempRoot("agentwheel-legacy-parser-");
    const configPath = join(root, "config.json");
    const marker = join(root, "planned");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 3, fleetId: "delivery" }), "utf8");
    const fixture = resolve("test/fixtures/compat/agentwheel-0.17-parser.mjs");
    await expect(execFileAsync(process.execPath, [fixture, configPath, marker])).rejects.toThrow(/0\.17.*rejects schemaVersion 3/s);
    await expect(stat(marker)).rejects.toThrow();
  });
});

function pkg(name: string) {
  return { name, source: `/packages/${name}`, driver: "local", adapter: "codex", mode: "pinned" } as const;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeConfig(root: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, ".agentwheel"), { recursive: true });
  await writeFile(join(root, ".agentwheel", "config.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
