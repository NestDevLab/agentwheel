import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mutationPolicyForWorkspace } from "../src/mutation/coordinator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const commit = (id: string, allow = false) => ({ reason: "required", journal: "required", revisioning: {
  mode: "commit-after-verify", allowNoCommitOverride: allow, reasonInCommit: "full",
  provider: { kind: "git", id, protocolVersion: 1 },
} });
async function config(root: string, value: object) {
  await mkdir(join(root, ".agentwheel"), { recursive: true });
  await writeFile(join(root, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4, packages: [{ name: "example-pack", source: "./pack", driver: "local", mode: "pinned" }], ...value }));
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-fleet-policy-")); roots.push(root);
  const home = join(root, "home"), fleet = join(root, "fleet"), nested = join(fleet, "profiles", "example");
  await config(home, { fleets: { example: { root: fleet, requiredPackages: ["example-pack"] } } });
  await config(fleet, { fleetId: "example", mutationPolicy: commit("fleet") });
  await config(nested, { schemaVersion: 1 });
  return { root, home, fleet, nested };
}
describe("authenticated containing Fleet mutation policy", () => {
  it("inherits the existing Fleet policy for a legacy nested workspace and new child directory", async () => {
    const f = await fixture();
    const expected = await mutationPolicyForWorkspace(f.fleet, f.home);
    expect(await mutationPolicyForWorkspace(f.nested, f.home)).toEqual(expected);
    expect(await mutationPolicyForWorkspace(join(f.nested, "new"), f.home)).toEqual(expected);
    expect(expected?.revisioning).toMatchObject({ provider: { id: "fleet" }, allowNoCommitOverride: false });
  });
  it("uses the explicit most-specific provider, while reason, journal and no-commit stay monotone", async () => {
    const f = await fixture();
    await config(f.home, { fleets: { example: { root: f.fleet, requiredPackages: ["example-pack"] } }, mutationPolicy: commit("home", true) });
    await config(f.nested, { mutationPolicy: { ...commit("nested", true), reason: "optional" } });
    expect(await mutationPolicyForWorkspace(f.nested, f.home)).toMatchObject({ reason: "required", journal: "required",
      revisioning: { provider: { id: "nested" }, allowNoCommitOverride: false } });
    await config(f.nested, { mutationPolicy: { reason: "optional", journal: "off", revisioning: { mode: "off" } } });
    expect(await mutationPolicyForWorkspace(f.nested, f.home)).toMatchObject({ reason: "required", journal: "required",
      revisioning: { provider: { id: "fleet" }, allowNoCommitOverride: false } });
  });
  it("keeps unrelated workspaces and HOME semantics unchanged", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside"); await config(outside, { schemaVersion: 1 });
    expect(await mutationPolicyForWorkspace(outside, f.home)).toBeUndefined();
    expect(await mutationPolicyForWorkspace(f.home, f.home)).toBeUndefined();
    await config(f.home, { mutationPolicy: commit("home") });
    expect(await mutationPolicyForWorkspace(outside, f.home)).toMatchObject({ revisioning: { provider: { id: "home" } } });
  });
  it.each(["overlap", "contract"])("refuses %s instead of selecting a convenient policy", async (kind) => {
    const f = await fixture();
    if (kind === "overlap") {
      await config(f.nested, { fleetId: "second" });
      await config(f.home, { fleets: { example: { root: f.fleet, requiredPackages: ["example-pack"] }, second: { root: f.nested, requiredPackages: ["example-pack"] } } });
    } else await config(f.fleet, { fleetId: "different", mutationPolicy: commit("fleet") });
    await expect(mutationPolicyForWorkspace(f.nested, f.home)).rejects.toThrow(/multiple registered fleets|mismatch/);
  });
});
