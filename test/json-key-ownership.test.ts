import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyCombinedInstallPlan, recoverPendingApply, uninstall } from "../src/install/apply.js";
import type { DesiredArtifact } from "../src/install/desired.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { createCombinedInstallPlan } from "../src/install/plan.js";
import { createUninstallPlan } from "../src/install/uninstall.js";
import { adapterSchema } from "../src/model/adapter.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const path = ".openclaw/openclaw.json";
const adapter = adapterSchema.parse({
  name: "openclaw",
  targets: { settings: { user: { dest: path, root: "target", merge: "openclaw-json-deep", mergeOwnership: "keys" } } },
});
const topic = (value: object) => ({ channels: { telegram: { groups: { "-10012345": { topics: { "85": value } } } } } });
const baselineTopic = { skills: ["supplies"], systemPrompt: "Previous wording", ingest: true };
const baseline = { agents: { list: [{ id: "fixture", workspace: "/fixture" }] }, mcp: { servers: { fixture: {} } }, ...topic(baselineTopic) };

async function withFixture(run: (root: string, sourceRoot: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-json-keys-"));
  try {
    const sourceRoot = join(root, "sources");
    await mkdir(sourceRoot);
    await mkdir(join(root, ".openclaw"));
    await writeFile(join(root, path), JSON.stringify(baseline, null, 2) + "\n");
    await run(root, sourceRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const transport = { ...localTransport, execFile: async () => "validated" };
const scope = (owner: string) => ({ installationType: "user", stateKey: "openclaw.user." + owner, workspaceOwner: "workspace-root:/fixture/" + owner });

async function settings(sourceRoot: string, owner: string, data: object): Promise<DesiredArtifact> {
  const name = owner + ".json";
  const sourcePath = join(sourceRoot, name);
  await writeFile(sourcePath, JSON.stringify(data));
  return { type: "settings", name, kind: "file", sourcePath, relativePath: "settings/" + name, channel: "managed", hash: await hashPath(sourcePath), meta: { dependencyRole: "root", owners: [owner] } };
}

async function makePlan(root: string, artifact: DesiredArtifact, owner: string, transportOverride = transport) {
  const options = scope(owner);
  const manifest = await readInstallManifest(root, "openclaw", transportOverride, options);
  return createCombinedInstallPlan([artifact], adapter, root, manifest, transportOverride, { ...options, baseRevision: manifest?.revision ?? null });
}

it("applies Keep, updates a disjoint topic contribution, then restores exactly the previous values", () => withFixture(async (root, sourceRoot) => {
  const supplies = await settings(sourceRoot, "supplies", topic({ ingest: true }));
  await applyCombinedInstallPlan(await makePlan(root, supplies, "supplies"), { transport });
  const keep = await settings(sourceRoot, "keep", {
    ...topic({ skills: ["supplies", "keep"], systemPrompt: "New wording" }),
    plugins: { entries: { keep: { enabled: true } } },
  });
  const installed = await applyCombinedInstallPlan(await makePlan(root, keep, "keep"), { transport });
  const again = await makePlan(root, keep, "keep");
  expect(again.operations[0].action).toBe("skip");
  const suppliesUpdate = await settings(sourceRoot, "supplies", topic({ ingest: false }));
  await applyCombinedInstallPlan(await makePlan(root, suppliesUpdate, "supplies"), { transport });
  const current = async () => JSON.parse(await readFile(join(root, path), "utf8"));
  expect(await current()).toEqual({ ...baseline, ...topic({ ...baselineTopic, ingest: false, skills: ["supplies", "keep"], systemPrompt: "New wording" }), plugins: { entries: { keep: { enabled: true } } } });
  const rollback = await createUninstallPlan(installed, transport);
  await uninstall(rollback, { transport });
  expect(await current()).toEqual({ ...baseline, ...topic({ ...baselineTopic, ingest: false }) });
  expect(await readInstallManifest(root, "openclaw", transport, scope("keep"))).toBeUndefined();
}));

it("rejects same-key claims and whole-file legacy claims without changing the file", () => withFixture(async (root, sourceRoot) => {
  const keep = await settings(sourceRoot, "keep", topic({ skills: ["supplies", "keep"] }));
  const first = await applyCombinedInstallPlan(await makePlan(root, keep, "keep"), { transport });
  const before = await readFile(join(root, path));
  const other = await settings(sourceRoot, "other", topic({ skills: ["other"] }));
  await expect(makePlan(root, other, "other")).rejects.toThrow("overlaps another install state");
  if (first.version !== 2) throw new Error("missing v2 fixture");
  const legacy = scope("legacy");
  await writeInstallManifest({
    ...first, ...legacy,
    entries: first.entries.map((entry) => ({ ...entry, keyOwnership: undefined, workspaceOwner: legacy.workspaceOwner })),
  });
  await expect(createUninstallPlan(first, transport)).rejects.toThrow("whole-file or legacy claim");
  await expect(makePlan(root, keep, "keep")).rejects.toThrow("whole-file or legacy claim");
  expect(await readFile(join(root, path))).toEqual(before);
}));

it("recovers a landed keyed write after interruption before the receipt", () => withFixture(async (root, sourceRoot) => {
  const keep = await settings(sourceRoot, "keep", topic({ systemPrompt: "New wording" }));
  const faulty = {
    ...transport,
    atomicCopy: async (...args: Parameters<typeof localTransport.atomicCopy>) => {
      await localTransport.atomicCopy(...args);
      if (args[1] === join(root, path)) throw new Error("interrupted after write");
    },
  };
  const plan = await makePlan(root, keep, "keep");
  await expect(applyCombinedInstallPlan(plan, { transport: faulty })).rejects.toThrow("interrupted after write");
  const manifest = await recoverPendingApply(root, "openclaw", transport, scope("keep"));
  expect(manifest?.entries[0]?.keyOwnership?.[0]).toMatchObject({ value: "New wording", previous: "Previous wording" });
  expect((await makePlan(root, keep, "keep")).operations[0].action).toBe("skip");
}));
