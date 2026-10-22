import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the service/account and target I/O boundary is injected. Workspace scope,
// registration, named-agent routing, adapters and emitted commands use the CLI.
const boundary = vi.hoisted(() => ({ plan: vi.fn(), transport: vi.fn(), identity: vi.fn() }));
vi.mock("../src/lifecycle/ownership-retire-stale.js", async (original) => ({
  ...await original<typeof import("../src/lifecycle/ownership-retire-stale.js")>(),
  planRetireStaleOwnership: boundary.plan,
}));
vi.mock("../src/transport/index.js", async (original) => ({
  ...await original<typeof import("../src/transport/index.js")>(), transportForTarget: boundary.transport,
}));
vi.mock("../src/transport/run-as-identity.js", async (original) => ({
  ...await original<typeof import("../src/transport/run-as-identity.js")>(), resolveRunAsIdentity: boundary.identity,
}));
const roots: string[] = [];
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(async () => {
  process.argv = argv; process.exitCode = exitCode;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-retire-cli-")); roots.push(root);
  const fleet = join(root, "fleet"), nested = join(fleet, "profiles", "service"), home = join(root, "home");
  const rootTarget = join(root, "root-target"), serviceTarget = join(root, "service-target");
  for (const path of [fleet, nested, home]) await mkdir(join(path, ".agentwheel"), { recursive: true });
  const pack = { name: "fixture", source: "./pack", driver: "local", mode: "pinned", adapter: "openclaw" };
  const base = { schemaVersion: 4, packages: [pack], profiles: {} };
  await writeFile(join(fleet, ".agentwheel/config.json"), JSON.stringify({ ...base, fleetId: "delivery", agents: {
    service: { adapter: "openclaw", root: rootTarget, transport: "local", installationType: "user" },
  } }));
  await writeFile(join(nested, ".agentwheel/config.json"), JSON.stringify({ ...base, agents: {
    service: { adapter: "openclaw", root: serviceTarget, transport: "local-run-as", runAs: "fixture-service", installationType: "user" },
  }, profiles: { service: { runtimes: [{ agent: "service" }] } } }));
  await writeFile(join(home, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4, fleets: { delivery: { root: fleet, requiredPackages: ["fixture"] } } }));
  boundary.identity.mockImplementation((user: string, path: string) => ({ user, uid: 12345, gid: 12345, root: path, home: path }));
  boundary.transport.mockImplementation(target => ({ kind: target.transport, description: "injected CLI boundary" }));
  boundary.plan.mockImplementation(async request => ({ adapter: request.adapter, installationType: request.installationType, targetRoot: request.targetRoot,
    source: { stateKey: request.sourceStateKey, revision: "a".repeat(64), owner: "fixture-source", manifestPath: "fixture-source" },
    destination: { stateKey: request.destinationStateKey, revision: "b".repeat(64), owner: "fixture-destination", workspaceRoot: request.toWorkspaceRoot, fleetId: request.toFleetId, manifestPath: "fixture-destination" },
    manifestInventoryRevision: "c".repeat(64), planDigest: "d".repeat(64), selected: [] }));
  vi.stubEnv("HOME", home); vi.stubEnv("AGENTWHEEL_NO_UPDATE_CHECK", "1");
  async function run(scope: string[], cwd = nested, destination = fleet) {
    vi.resetModules();
    const output: string[] = [], errors: string[] = [];
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
    vi.spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
    process.exitCode = undefined;
    process.argv = [process.execPath, "agentwheel", "--no-update-check", "ownership", "retire-stale",
      "--from-workspace-root", join(root, "old-workspace"), "--to-workspace-root", destination,
      "--source-state-key", "openclaw.user.source", "--destination-state-key", "openclaw.user.destination", ...scope, "--json"];
    await import("../src/cli/index.js");
    return { code: process.exitCode, errors: errors.join("\n"), output: output.join("\n") };
  }
  return { root, fleet, nested, home, rootTarget, serviceTarget, run };
}

describe("retire-stale destination Fleet and target workspace scope", () => {
  it("routes a nested --local target through its run-as boundary and preserves all scope/CAS arguments", async () => {
    const f = await fixture(); const before = await readFile(join(f.fleet, ".agentwheel/config.json"));
    const result = await f.run(["--local", "--to-fleet", "delivery", "--agent", "service"]);
    expect(result.errors).toBe(""); expect(result.code).toBeUndefined();
    expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: f.nested, targetRoot: f.serviceTarget, transport: "local-run-as" }));
    expect(boundary.plan).toHaveBeenCalledWith(expect.objectContaining({ targetRoot: f.serviceTarget, toWorkspaceRoot: f.fleet, toFleetId: "delivery" }));
    const { applyCommand } = JSON.parse(result.output);
    for (const arg of ["--local", "--to-fleet delivery", "--agent service", "--destination-state-key openclaw.user.destination", "--plan-digest", "--expected-source-revision", "--expected-destination-revision", "--expected-inventory-revision", "--apply"]) expect(applyCommand).toContain(arg);
    expect(applyCommand).not.toContain("--fleet delivery");
    expect(await readFile(join(f.fleet, ".agentwheel/config.json"))).toEqual(before);
  });
  it("preserves --profile in a nested target's emitted native apply command", async () => {
    const f = await fixture(); const result = await f.run(["--local", "--to-fleet", "delivery", "--profile", "service"]);
    expect(result.errors).toBe(""); expect(JSON.parse(result.output).applyCommand).toContain("--local --profile service");
  });
  it("preserves an explicit --user target workspace contained in the destination Fleet", async () => {
    const f = await fixture(); const user = join(f.fleet, "user-workspace");
    await mkdir(join(user, ".agentwheel"), { recursive: true });
    const config = JSON.parse(await readFile(join(f.nested, ".agentwheel/config.json"), "utf8"));
    config.fleets = { delivery: { root: f.fleet, requiredPackages: ["fixture"] } };
    await writeFile(join(user, ".agentwheel/config.json"), JSON.stringify(config)); vi.stubEnv("HOME", user);
    const result = await f.run(["--user", "--to-fleet", "delivery", "--agent", "service"]);
    expect(result.errors).toBe(""); expect(JSON.parse(result.output).applyCommand).toContain("--user --agent service");
    expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: user, transport: "local-run-as" }));
  });
  it("requires an explicit destination qualification when no legacy Fleet scope is selected", async () => {
    const f = await fixture(); const result = await f.run(["--local", "--agent", "service"]);
    expect(result.code).toBe(1); expect(result.errors).toContain("requires --to-fleet");
    expect(boundary.transport).not.toHaveBeenCalled(); expect(boundary.plan).not.toHaveBeenCalled();
  });
  it("retains legacy --fleet root selection and its local transport", async () => {
    const f = await fixture(); const result = await f.run(["--fleet", "delivery", "--agent", "service"]);
    expect(result.errors).toBe(""); expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: f.fleet, targetRoot: f.rootTarget, transport: "local" }));
    expect(JSON.parse(result.output).applyCommand).toContain("--fleet delivery");
    expect(JSON.parse(result.output).applyCommand).not.toContain("--to-fleet");
  });
  it.each(["outside", "prefix-sibling", "symlink", "replaced-fleet-root", "fleet-contract-drift", "wrong-root", "unknown-fleet", "foreign-fleet"])("rejects %s before creating target transport or calling the lifecycle", async kind => {
    const f = await fixture(); let cwd = f.nested, destination = f.fleet;
    let args = ["--local", "--to-fleet", "delivery", "--agent", "service"];
    if (kind === "outside" || kind === "prefix-sibling" || kind === "symlink") {
      const outside = kind === "prefix-sibling" ? `${f.fleet}-outside` : join(f.root, "outside"); await mkdir(join(outside, ".agentwheel"), { recursive: true });
      await writeFile(join(outside, ".agentwheel/config.json"), await readFile(join(f.nested, ".agentwheel/config.json")));
      cwd = outside;
      if (kind === "symlink") { cwd = join(f.fleet, "escaped"); await symlink(outside, cwd, "dir"); }
    }
    if (kind === "replaced-fleet-root") {
      const replacement = join(f.root, "replacement");
      await mkdir(join(replacement, "profiles", "service", ".agentwheel"), { recursive: true });
      await writeFile(join(replacement, "profiles/service/.agentwheel/config.json"), await readFile(join(f.nested, ".agentwheel/config.json")));
      await rm(f.fleet, { recursive: true }); await symlink(replacement, f.fleet, "dir");
    }
    if (kind === "fleet-contract-drift") {
      const path = join(f.fleet, ".agentwheel/config.json");
      const config = JSON.parse(await readFile(path, "utf8")); config.fleetId = "changed";
      await writeFile(path, JSON.stringify(config));
    }
    if (kind === "wrong-root") destination = f.nested;
    if (kind === "unknown-fleet") args = ["--local", "--to-fleet", "missing", "--agent", "service"];
    if (kind === "foreign-fleet") {
      const foreign = join(f.root, "foreign"); await mkdir(join(foreign, ".agentwheel"), { recursive: true });
      const config = JSON.parse(await readFile(join(f.fleet, ".agentwheel/config.json"), "utf8")); config.fleetId = "foreign";
      await writeFile(join(foreign, ".agentwheel/config.json"), JSON.stringify(config));
      const configPath = join(f.home, ".agentwheel/config.json"); const home = JSON.parse(await readFile(configPath, "utf8")); home.fleets.foreign = { root: foreign, requiredPackages: ["fixture"] }; await writeFile(configPath, JSON.stringify(home));
      args = ["--fleet", "foreign", "--to-fleet", "delivery", "--agent", "service"];
    }
    const result = await f.run(args, cwd, destination);
    expect(result.code).toBe(1); expect(result.errors).toMatch(/does not belong|registered at|Unknown fleet|canonical|fleetId mismatch/);
    expect(boundary.identity).not.toHaveBeenCalled();
    expect(boundary.transport).not.toHaveBeenCalled(); expect(boundary.plan).not.toHaveBeenCalled();
  });
});
