import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConfig } from "../src/model/adapter.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, readInstallManifest, writeInstallManifest, recoverPendingApply, type DesiredArtifact } from "../src/install/index.js";
import { mergeJsonUpdate, planJsonRetirement } from "../src/install/json-merge.js";
import { hashPath } from "../src/utils/fs.js";
import { localTransport } from "../src/transport/index.js";
import { acquireApplyLock, applyJournalPath } from "../src/install/transaction.js";
import type { MergeRemoval } from "../src/install/merge-removal.js";
import { formatPlan } from "../src/cli/format.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const adapter: AdapterConfig = { name: "fixture", targets: { settings: { local: { enabled: true, dest: ".runtime/settings.json", merge: "json-deep" } } } };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "json-retirement-")); roots.push(root);
  await mkdir(join(root, ".runtime"));
  const dest = join(root, ".runtime/settings.json");
  const source = join(root, "source.json");
  const user = { theme: "user", env: { USER: "keep" }, hooks: ["user-hook"], permissions: ["user-rule"] };
  await writeFile(dest, JSON.stringify(user));
  const artifact = async (content: unknown, packageName = "fixture/settings"): Promise<DesiredArtifact> => {
    await writeFile(source, JSON.stringify(content));
    return { type: "settings", name: "settings.json", sourcePath: source, stagedPath: source,
      relativePath: "settings/settings.json", kind: "file", hash: await hashPath(source), channel: "managed", packageName,
      meta: { logicalSelector: "settings/settings.json", owners: [packageName], dependencyRole: "root" } };
  };
  const options = { workspaceOwner: "workspace:fixture" };
  const update = async (content: unknown, packageName?: string) => {
    const previous = await readInstallManifest(root, adapter.name);
    const plan = await createCombinedInstallPlan([await artifact(content, packageName)], adapter, root, previous, undefined, options);
    return plan;
  };
  const get = async () => JSON.parse(await readFile(dest, "utf8"));
  return { root, dest, artifact, update, get, user };
}

describe("owned JSON contribution retirement", () => {
  it("retires recorded leaves in an existing settings file and preserves user arrays and other artifacts", async () => {
    const f = await fixture();
    const before = { retired: 1, shared: 2, env: { OLD: "owned", KEEP: "owned" }, hooks: ["managed-hook"], permissions: ["managed-rule"] };
    await applyCombinedInstallPlan(await f.update(before));
    const installed = await readInstallManifest(f.root, adapter.name);
    if (!installed || installed.version !== 2) throw new Error("expected current manifest");
    // A second state owns an overlapping path. Retirement must preserve it.
    await writeInstallManifest({ ...installed, stateKey: "fixture.local.foreign", entries: [{
      ...installed.entries[0]!, packageName: "fixture/other", owners: ["fixture/other"],
      workspaceOwner: "workspace:other", mergeRemoval: { shared: 2 },
    }] });
    const desired = { env: { KEEP: "owned" }, hooks: ["managed-hook"], permissions: ["managed-rule"] };
    const plan = await f.update(desired);
    expect(plan.operations[0]!.jsonRetirement?.remove.map((entry) => entry.path)).toEqual([["retired"], ["env", "OLD"]]);
    expect(formatPlan(plan)).toContain('retire ["env","OLD"]');
    expect(formatPlan(plan)).toContain('preserve ["shared"]: another artifact');
    await applyCombinedInstallPlan(plan);
    expect(await f.get()).toEqual({ ...f.user, shared: 2, env: { USER: "keep", KEEP: "owned" }, hooks: ["user-hook", "managed-hook"], permissions: ["user-rule", "managed-rule"] });
    const repeat = await f.update(desired);
    expect(repeat.operations[0]!.action).toBe("skip");
    await applyCombinedInstallPlan(repeat);
    expect((await f.get()).shared).toBe(2);
  });

  it("reports and relinquishes a retired value edited by the user, without deleting it", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ retired: "owned", keep: true }));
    await writeFile(f.dest, JSON.stringify({ ...await f.get(), retired: "user" }));
    const plan = await f.update({ keep: true });
    expect(formatPlan(plan)).toContain('preserve ["retired"]: value changed outside this artifact');
    await applyCombinedInstallPlan(plan);
    expect((await f.get()).retired).toBe("user");
    const state = await readInstallManifest(f.root, adapter.name);
    expect(state?.entries[0]?.mergeRemoval).not.toHaveProperty("retired");
    expect((await f.update({ keep: true })).operations[0]!.action).toBe("skip");
  });

  it("retains untracked and replacement-producer keys even if omitted", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ retired: 1 }));
    const plan = await f.update({ replacement: true }, "fixture/replacement");
    expect(plan.operations[0]!.jsonRetirement).toBeUndefined();
    await applyCombinedInstallPlan(plan);
    expect((await f.get()).retired).toBe(1);
    expect((await f.get()).theme).toBe("user");
    await applyCombinedInstallPlan(await f.update({ replacement: true }, "fixture/replacement"));
    expect((await f.get()).retired).toBe(1);
  });

  it("retires stale ownership even when a prior installer already saved the new source hash", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ retired: 1, keep: true }));
    const next = await f.artifact({ keep: true });
    const state = await readInstallManifest(f.root, adapter.name);
    if (!state || state.version !== 2) throw new Error("expected current manifest");
    state.entries[0]!.sourceHash = next.hash;
    await writeInstallManifest(state);
    const plan = await f.update({ keep: true });
    expect(plan.operations[0]!.action).toBe("update");
    await applyCombinedInstallPlan(plan);
    expect(await f.get()).not.toHaveProperty("retired");
  });

  it("preserves an empty owned object through an update, then retires it", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ empty: {}, sibling: 1 }));
    await applyCombinedInstallPlan(await f.update({ empty: {}, sibling: 2 }));
    const state = await readInstallManifest(f.root, adapter.name);
    expect(state?.entries[0]?.mergeRemoval).toHaveProperty("empty", {});
    await applyCombinedInstallPlan(await f.update({ sibling: 2 }));
    expect(await f.get()).not.toHaveProperty("empty");
  });

  it("protects another adapter's contribution and detects changes to that inventory", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ shared: 1, owned: 2 }));
    const installed = await readInstallManifest(f.root, adapter.name);
    if (!installed || installed.version !== 2) throw new Error("expected current manifest");
    const foreign = { ...installed, adapter: "other-adapter", stateKey: "other.local.foreign", entries: [{
      ...installed.entries[0]!, packageName: "fixture/other", owners: ["fixture/other"],
      workspaceOwner: "workspace:other", mergeRemoval: { shared: 1 } as MergeRemoval,
    }] };
    await writeInstallManifest(foreign);
    const plan = await f.update({});
    expect(plan.operations[0]!.jsonRetirement?.remove.map((entry) => entry.path)).toEqual([["owned"]]);
    foreign.entries[0]!.mergeRemoval = { shared: 1, owned: 2 };
    await writeInstallManifest(foreign);
    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/inventory changed/);
    const replanned = await f.update({});
    await applyCombinedInstallPlan(replanned);
    expect(await f.get()).toMatchObject({ shared: 1, owned: 2 });
  });

  it("serializes different adapters at a shared target", async () => {
    const f = await fixture();
    const lock = await acquireApplyLock(f.root, "first");
    try { await expect(acquireApplyLock(f.root, "second")).rejects.toThrow(/Apply lock already exists/); }
    finally { await lock.release(); }
    const second = await acquireApplyLock(f.root, "second");
    await second.release();
  });

  for (const phase of ["prepared", "committed"] as const) {
    it(`recovers JSON retirement after interruption at ${phase}`, async () => {
      const f = await fixture();
      await applyCombinedInstallPlan(await f.update({ retired: 1, keep: true }));
      const plan = await f.update({ keep: true });
      const failing = { ...localTransport,
        async writeJsonAtomic(path: string, value: unknown) {
          await localTransport.writeJsonAtomic(path, value);
          if (phase === "prepared" && path.endsWith(".apply-journal.json")) throw new Error("injected interruption");
        },
        async rm(path: string) {
          if (phase === "committed" && path.endsWith(".apply-journal.json")) throw new Error("injected interruption");
          await localTransport.rm(path);
        },
      };
      await expect(applyCombinedInstallPlan(plan, { transport: failing })).rejects.toThrow(/injected interruption/);
      await recoverPendingApply(f.root, adapter.name);
      expect(await f.get()).not.toHaveProperty("retired");
    });
  }

  it("refuses recovery after another adapter claims a retired path, without runtime writes", async () => {
    const f = await fixture();
    await applyCombinedInstallPlan(await f.update({ retired: 1, keep: true }));
    const plan = await f.update({ keep: true });
    const failing = { ...localTransport, async writeJsonAtomic(path: string, value: unknown) {
      await localTransport.writeJsonAtomic(path, value);
      if (path.endsWith(".apply-journal.json")) throw new Error("injected interruption");
    } };
    await expect(applyCombinedInstallPlan(plan, { transport: failing })).rejects.toThrow(/injected interruption/);
    const before = await readFile(f.dest, "utf8");
    const state = await readInstallManifest(f.root, adapter.name);
    if (!state || state.version !== 2) throw new Error("expected current manifest");
    await writeInstallManifest({ ...state, adapter: "foreign", stateKey: "foreign.local.fixture", entries: [{
      ...state.entries[0]!, mergeRemoval: { retired: 1 },
    }] });
    await expect(recoverPendingApply(f.root, adapter.name)).rejects.toThrow(/inventory changed before recovery/);
    expect(await readFile(f.dest, "utf8")).toBe(before);
    expect(await localTransport.pathExists(applyJournalPath(f.root, adapter.name))).toBe(true);
  });

  it("uses exact paths, compares objects independent of key order, and refuses post-plan edits", () => {
    const current = { "a.b": 1, nested: { retired: 2, user: 3 }, array: [{ b: 2, a: 1 }, "user"] };
    const source = { nested: {}, array: ["user"] };
    const { retirement } = planJsonRetirement(current, source, { "a.b": 1, nested: { retired: 2 } });
    expect(mergeJsonUpdate(current, source, retirement)).toEqual({ nested: { user: 3 }, array: current.array });
    expect(() => mergeJsonUpdate({ ...current, "a.b": 9 }, source, retirement)).toThrow(/changed since planning/);
    const changedArray = planJsonRetirement(current, {}, { array: [{ a: 1, b: 2 }] });
    expect(changedArray.retirement.remove).toEqual([]);
    expect(changedArray.retirement.preserved[0]!.path).toEqual(["array"]);
  });
});
