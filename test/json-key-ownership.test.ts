import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { applyCombinedInstallPlan, recoverPendingApply, uninstall } from "../src/install/apply.js";
import { applyOpenClawKeyMigration, planOpenClawKeyMigration } from "../src/lifecycle/openclaw-key-migration.js";
import type { InstallManifestEntry } from "../src/model/manifest.js";
import type { DesiredArtifact } from "../src/install/desired.js";
import type { MergeRemoval } from "../src/install/merge-removal.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { createCombinedInstallPlan } from "../src/install/plan.js";
import { installManifestPath } from "../src/install/paths.js";
import { abortApplyJournal, applyBackupDir, applyJournalPath, readApplyJournal } from "../src/install/transaction.js";
import { createOwnershipUninstallPlan, createUninstallPlan } from "../src/install/uninstall.js";
import { adapterSchema } from "../src/model/adapter.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const path = ".openclaw/openclaw.json";
const adapter = adapterSchema.parse({
  name: "openclaw",
  targets: { settings: { user: { dest: path, root: "target", merge: "openclaw-json-keys" } } },
});
const topic = (value: MergeRemoval) => ({ channels: { telegram: { groups: { "-10012345": { topics: { "85": value } } } } } });
const baselineTopic = { skills: ["supplies"], systemPrompt: "Previous wording", ingest: true };
const baseline = { agents: { list: [{ id: "fixture", workspace: "/fixture" }] }, mcp: { servers: { fixture: {} } }, ...topic(baselineTopic) };

async function withFixture(run: (root: string, sourceRoot: string) => Promise<void>) {
  const fixture = await mkdtemp(join(tmpdir(), "agentwheel-json-keys-"));
  const root = join(fixture, "runtime");
  const sourceRoot = join(fixture, "sources");
  try {
    await mkdir(sourceRoot);
    await mkdir(join(root, ".openclaw"), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(baseline, null, 2) + "\n");
    await run(root, sourceRoot);
  } finally {
    await rm(fixture, { recursive: true, force: true });
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

async function makePlan(root: string, artifact: DesiredArtifact, owner: string, transportOverride = transport, workspaceOwner = scope(owner).workspaceOwner) {
  const options = { ...scope(owner), workspaceOwner };
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
    entries: first.entries.map((entry) => ({ ...entry, keyOwnership: undefined, mergeStrategy: "openclaw-json-deep", workspaceOwner: legacy.workspaceOwner })),
  });
  await expect(createUninstallPlan(first, transport)).rejects.toThrow("whole-file or legacy claim");
  await expect(makePlan(root, keep, "keep")).rejects.toThrow("whole-file or legacy claim");
  expect(await readFile(join(root, path))).toEqual(before);
}));

it.each(["install", "uninstall"] as const)("keeps an interrupted keyed %s journal private and recoverable", (mode) => withFixture(async (root, sourceRoot) => {
  const keep = await settings(sourceRoot, "keep", topic({ systemPrompt: "New wording" }));
  const faulty = {
    ...transport,
    atomicCopy: async (...args: Parameters<typeof localTransport.atomicCopy>) => {
      await localTransport.atomicCopy(...args);
      if (args[1] === join(root, path)) throw new Error("interrupted after write");
    },
  };
  const plan = await makePlan(root, keep, "keep");
  if (mode === "install") {
    await expect(applyCombinedInstallPlan(plan, { transport: faulty })).rejects.toThrow("interrupted after write");
  } else {
    const installed = await applyCombinedInstallPlan(plan, { transport });
    await expect(uninstall(await createUninstallPlan(installed, transport), { transport: faulty }))
      .rejects.toThrow("interrupted after write");
  }
  const journalPath = applyJournalPath(root, "openclaw", scope("keep"));
  const backupPath = join(applyBackupDir(root, "openclaw", scope("keep")), "0");
  const [journalBytes, backupBytes, runtimeBytes] = await Promise.all([
    readFile(journalPath), readFile(backupPath), readFile(join(root, path)),
  ]);
  const journal = await readApplyJournal(root, "openclaw", transport, scope("keep"));
  expect(journal?.metadataGuards).toBeUndefined();
  expect(journal?.metadataAudit).toBeUndefined();
  expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
  await expect(abortApplyJournal(root, "openclaw", transport, scope("keep"))).rejects.toThrow("must be recovered and verified");
  await expect(stat(join(root, ".agentwheel", "archive"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(journalPath)).toEqual(journalBytes);
  expect(await readFile(backupPath)).toEqual(backupBytes);
  expect(await readFile(join(root, path))).toEqual(runtimeBytes);
  const manifest = await recoverPendingApply(root, "openclaw", transport, scope("keep"));
  if (mode === "install") {
    expect(manifest?.entries[0]?.keyOwnership?.[0]).toMatchObject({ value: "New wording", previous: "Previous wording" });
    expect((await makePlan(root, keep, "keep")).operations[0].action).toBe("skip");
  } else {
    expect(await readInstallManifest(root, "openclaw", transport, scope("keep"))).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual(baseline);
  }
}));

it("stops before replacement when config changes during validation", () => withFixture(async (root, sourceRoot) => {
  const keep = await settings(sourceRoot, "keep", topic({ systemPrompt: "New wording" }));
  const plan = await makePlan(root, keep, "keep");
  const concurrent = JSON.stringify({ ...baseline, diagnostics: { enabled: true } });
  const validating = {
    ...transport,
    execFile: async () => { await writeFile(join(root, path), concurrent); return "validated"; },
  };
  await expect(applyCombinedInstallPlan(plan, { transport: validating })).rejects.toThrow("configuration changed during validation");
  expect(await readFile(join(root, path), "utf8")).toBe(concurrent);
  expect(await readInstallManifest(root, "openclaw", transport, scope("keep"))).toBeUndefined();
}));

async function legacy(
  root: string, artifact: DesiredArtifact, owner: string, mergeRemoval?: InstallManifestEntry["mergeRemoval"],
) {
  const now = "2025-01-01T00:00:00.000Z";
  const options = scope(owner);
  const entry: InstallManifestEntry = {
    path, artifactType: artifact.type, artifactName: artifact.name, installName: artifact.name,
    kind: "file", channel: "managed", sourceHash: artifact.hash, hash: await hashPath(join(root, path)),
    updatedAt: now, workspaceOwner: options.workspaceOwner, dependencyRole: "root", owners: [owner], refCount: 1,
    mergeStrategy: "openclaw-json-deep", ...(mergeRemoval === undefined ? {} : { mergeRemoval }),
  };
  await writeInstallManifest({
    version: 2, adapter: "openclaw", installationType: options.installationType, stateKey: options.stateKey,
    targetRoot: root, revision: "0".repeat(64), generatedAt: now, legacy: false, entries: [entry],
  }, transport);
  return entry;
}

const topicKey = (key: string) => ["channels", "telegram", "groups", "-10012345", "topics", "85", key];
const decide = (path: string[], disposition: string) => ({ path, disposition });

function migration(root: string, artifact: DesiredArtifact, owner: string, decisions: unknown, customTransport = transport) {
  return {
    targetRoot: root, sourceStateKey: scope(owner).stateKey, sourceOwner: scope(owner).workspaceOwner,
    historicalArtifact: artifact.sourcePath, decisions, transport: customTransport,
  };
}

function rehomeSource(artifact: DesiredArtifact) {
  return {
    stateKey: scope("supplies").stateKey,
    workspaceOwner: "workspace-root:" + dirname(artifact.sourcePath),
    agentName: "fixture",
    artifactFile: artifact.sourcePath,
    graphDigest: "a".repeat(64),
    configuredArtifacts: [{
      artifactType: "settings" as const, artifactName: artifact.name, owners: ["supplies"],
      graphNodeId: "supplies@1.0.0+fixture", logicalSelector: "supplies:settings/supplies.json",
      sourceHash: artifact.hash,
    }],
  };
}

it("migrates a recorded donor and four incomplete historical owners, then installs, updates and rolls back", () => withFixture(async (root, sourceRoot) => {
  const donor = await settings(sourceRoot, "supplies", topic(baselineTopic));
  await legacy(root, donor, "supplies", topic({ skills: ["supplies"], systemPrompt: baselineTopic.systemPrompt }));
  const nonDonors = [
    { owner: "connector", keys: ["mcp", "servers", "other", "url"], fragment: { mcp: { servers: { other: { url: "http://example.invalid" } } } } },
    { owner: "compat", keys: ["plugins", "compat", "enabled"], fragment: { plugins: { compat: { enabled: false } } } },
    { owner: "older-policy", keys: topicKey("ingest"), fragment: topic({ ingest: false }) },
    { owner: "notifications", keys: ["notifications", "enabled"], fragment: { notifications: { enabled: true } } },
  ];
  const policies: ReturnType<typeof migration>[] = [];
  for (const [index, spec] of nonDonors.entries()) {
    const source = await settings(sourceRoot, spec.owner, spec.fragment);
    if (index === 0) source.type = "mcp";
    await legacy(root, source, spec.owner, index === 1 ? undefined : {});
    policies.push(migration(root, source, spec.owner, [decide(spec.keys, "release")]));
  }
  const configuredRoot = join(sourceRoot, "durable");
  await mkdir(configuredRoot);
  const replacement = await settings(configuredRoot, "supplies", topic({ ingest: true }));
  const rehome = rehomeSource(replacement);
  const replacementOwner = rehome.workspaceOwner;
  const source = { ...migration(root, donor, "supplies", [
    ...["skills", "systemPrompt"].map((key) => ({
      path: topicKey(key), disposition: "handoff", stateKey: scope("keep").stateKey, workspaceOwner: scope("keep").workspaceOwner,
    })),
    decide(topicKey("ingest"), "adopt-current"),
  ]), rehome };
  const before = await readFile(join(root, path));
  const reviewed = await planOpenClawKeyMigration(source);
  expect(reviewed.originalDelta).toBe("recorded");
  expect(reviewed.rehome).toMatchObject({ workspaceOwner: replacementOwner, stateKey: scope("supplies").stateKey, sourceHash: replacement.hash });
  expect(JSON.stringify(reviewed)).not.toContain(baselineTopic.systemPrompt);
  await expect(planOpenClawKeyMigration({ ...source, rehome: { ...source.rehome, stateKey: scope("other").stateKey } }))
    .rejects.toThrow("same exact state");
  const otherSource = await settings(sourceRoot, "supplies-next", topic({ ingest: false, skills: ["supplies"] }));
  await expect(planOpenClawKeyMigration({ ...source, rehome: {
    ...rehome, configuredArtifacts: [{ ...rehome.configuredArtifacts[0]!, sourceHash: otherSource.hash }],
  } })).rejects.toThrow("must match the configured source graph");
  await expect(applyOpenClawKeyMigration({ ...source, rehome: { ...rehome, graphDigest: "b".repeat(64) } }, reviewed.planDigest))
    .rejects.toThrow("plan changed");
  await applyOpenClawKeyMigration(source, reviewed.planDigest);
  const keep = await settings(sourceRoot, "keep", {
    ...topic({ skills: ["supplies", "keep"], systemPrompt: "Migrated wording" }),
    plugins: { entries: { keep: { enabled: true } } },
  });
  await expect(makePlan(root, keep, "keep")).rejects.toThrow("whole-file or legacy claim");
  for (const policy of policies) {
    const reviewed = await planOpenClawKeyMigration(policy);
    await applyOpenClawKeyMigration(policy, reviewed.planDigest);
  }
  expect(await readFile(join(root, path))).toEqual(before);
  await expect(makePlan(root, replacement, "supplies")).rejects.toThrow("cannot implicitly adopt");
  await expect(makePlan(root, donor, "supplies", transport, replacementOwner)).rejects.toThrow("still declares released keys");
  expect((await makePlan(root, replacement, "supplies", transport, replacementOwner)).operations[0].action).toBe("skip");
  await expect(makePlan(root, keep, "wrong-recipient")).rejects.toThrow("reserved for another exact recipient");
  const installed = await applyCombinedInstallPlan(await makePlan(root, keep, "keep"), { transport });
  const updatedDonor = await settings(configuredRoot, "supplies", topic({ ingest: false }));
  await applyCombinedInstallPlan(await makePlan(root, updatedDonor, "supplies", transport, replacementOwner), { transport });
  await uninstall(await createUninstallPlan(installed, transport), { transport });
  expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual({ ...baseline, ...topic({ ...baselineTopic, ingest: false }) });
  const updated = await readInstallManifest(root, "openclaw", transport, scope("supplies"));
  expect(updated?.entries[0]?.keyMigration?.legacyRemoval).toEqual(topic({
    skills: ["supplies"], systemPrompt: baselineTopic.systemPrompt,
  }));
  expect(updated?.entries[0]?.keyMigration?.rehome).toMatchObject({ previousWorkspaceOwner: source.sourceOwner, workspaceOwner: replacementOwner });
  await expect(makePlan(root, donor, "supplies", transport, replacementOwner)).rejects.toThrow("still declares released keys");
  await expect(createUninstallPlan(updated!, transport, source.sourceOwner)).rejects.toThrow("selected workspace");
  await uninstall(await createUninstallPlan(updated!, transport, replacementOwner), { transport });
  expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual(baseline);
  await expect(makePlan(root, donor, "supplies", transport, replacementOwner)).rejects.toThrow("still declares released keys");
  const fence = await readInstallManifest(root, "openclaw", transport, scope("supplies"));
  expect(fence?.entries[0]?.keyMigration?.rehome).toEqual(updated?.entries[0]?.keyMigration?.rehome);
  const connector = await readInstallManifest(root, "openclaw", transport, scope("connector"));
  expect(connector?.entries[0]).toMatchObject({ artifactType: "mcp", keyOwnership: [] });
}));

it("refuses to uninstall a rehomed state with a foreign sibling skill", () => withFixture(async (root, sourceRoot) => {
  const donor = await settings(sourceRoot, "supplies", topic({ ingest: true }));
  const original = await legacy(root, donor, "supplies", {});
  const installed = await readInstallManifest(root, "openclaw", transport, scope("supplies"));
  if (installed?.version !== 2) throw new Error("Fixture did not install a version 2 manifest.");
  const skillPath = ".openclaw/workspace/skills/legacy/SKILL.md";
  await mkdir(dirname(join(root, skillPath)), { recursive: true });
  await writeFile(join(root, skillPath), "original skill");
  const skill = { ...original, path: skillPath, kind: "file" as const, artifactType: "skills" as const, artifactName: "legacy",
    installName: "legacy", hash: await hashPath(join(root, skillPath)), mergeStrategy: undefined, mergeRemoval: undefined };
  await writeInstallManifest({ ...installed, entries: [...installed.entries, skill] }, transport);
  const configuredRoot = join(sourceRoot, "durable");
  await mkdir(configuredRoot);
  const replacement = await settings(configuredRoot, "supplies", topic({ ingest: true }));
  const request = { ...migration(root, donor, "supplies", [decide(topicKey("ingest"), "adopt-current")]), rehome: rehomeSource(replacement) };
  await applyOpenClawKeyMigration(request, (await planOpenClawKeyMigration(request)).planDigest);
  const migrated = await readInstallManifest(root, "openclaw", transport, scope("supplies"));
  const manifestPath = installManifestPath(root, "openclaw", scope("supplies"));
  const [beforeManifest, beforeConfig] = await Promise.all([readFile(manifestPath), readFile(join(root, path))]);
  expect(migrated?.entries.find((entry) => entry.path === skillPath)).toMatchObject({ workspaceOwner: request.sourceOwner });
  await expect(createUninstallPlan(migrated!, transport, request.rehome.workspaceOwner)).rejects.toThrow("multiple workspace owners");
  await expect(createOwnershipUninstallPlan(migrated!, [], adapter, transport, { workspaceOwner: request.rehome.workspaceOwner }))
    .rejects.toThrow("multiple workspace owners");
  expect(await readFile(manifestPath)).toEqual(beforeManifest);
  expect(await readFile(join(root, path))).toEqual(beforeConfig);
  expect(await readFile(join(root, skillPath), "utf8")).toBe("original skill");
}));

it("requires explicit dispositions and exact pinned source bytes, never inferring a rollback preimage from a missing delta", () => withFixture(async (root, sourceRoot) => {
  const donor = await settings(sourceRoot, "supplies", topic({ ingest: true, skills: ["supplies"] }));
  await legacy(root, donor, "supplies");
  const before = await readFile(join(root, path));
  await expect(planOpenClawKeyMigration(migration(root, donor, "supplies", [decide(topicKey("ingest"), "release")])))
    .rejects.toThrow("exactly one explicit migration decision");
  const request = migration(root, donor, "supplies", [
    decide(topicKey("ingest"), "adopt-current"), decide(topicKey("skills"), "retain-recorded"),
  ]);
  await expect(planOpenClawKeyMigration(request)).rejects.toThrow("needs a recorded delta");
  const replacement = await settings(sourceRoot, "other", topic({ ingest: true, skills: ["supplies"] }));
  await writeFile(replacement.sourcePath, JSON.stringify(topic({ ingest: false, skills: ["supplies"] })));
  await expect(planOpenClawKeyMigration({ ...request, historicalArtifact: replacement.sourcePath })).rejects.toThrow("source hash");
  expect(await readFile(join(root, path))).toEqual(before);
}));

it("preserves an additive array's recorded removal and restores its prior members", () => withFixture(async (root, sourceRoot) => {
  await writeFile(join(root, path), JSON.stringify({ ...baseline, ...topic({ ...baselineTopic, skills: ["prior", "supplies"] }) }));
  const donor = await settings(sourceRoot, "supplies", topic({ skills: ["supplies"] }));
  await legacy(root, donor, "supplies", topic({ skills: ["supplies"] }));
  const request = migration(root, donor, "supplies", [decide(topicKey("skills"), "retain-recorded")]);
  await applyOpenClawKeyMigration(request, (await planOpenClawKeyMigration(request)).planDigest);
  const migrated = await readInstallManifest(root, "openclaw", transport, scope("supplies"));
  expect(migrated?.entries[0]?.keyOwnership?.[0]?.previous).toEqual(["prior"]);
  await uninstall(await createUninstallPlan(migrated!, transport), { transport });
  expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual({ ...baseline, ...topic({ ...baselineTopic, skills: ["prior"] }) });
}));

it.each(["before", "after"] as const)("recovers a %s-metadata-write interruption with unchanged config", (interrupt) => withFixture(async (root, sourceRoot) => {
  const donor = await settings(sourceRoot, "supplies", topic({ ingest: true }));
  const original = await legacy(root, donor, "supplies", {});
  const manifestPath = installManifestPath(root, "openclaw", scope("supplies"));
  await chmod(manifestPath, 0o664);
  const before = await readFile(join(root, path));
  const faulty = {
    ...transport,
    writePrivateJsonAtomic: async (...args: Parameters<NonNullable<typeof transport.writePrivateJsonAtomic>>) => {
      const manifestWrite = args[0].endsWith(".install-manifest.json");
      if (manifestWrite && interrupt === "before") throw new Error("injected metadata interruption");
      await transport.writePrivateJsonAtomic!(...args);
      if (manifestWrite && interrupt === "after") throw new Error("injected metadata interruption");
    },
  };
  const request = migration(root, donor, "supplies", [decide(topicKey("ingest"), "adopt-current")], faulty);
  const plan = await planOpenClawKeyMigration(request);
  await expect(applyOpenClawKeyMigration(request, "f".repeat(64))).rejects.toThrow("plan changed");
  await expect(applyOpenClawKeyMigration(request, plan.planDigest)).rejects.toThrow("injected metadata interruption");
  expect((await stat(applyJournalPath(root, "openclaw", scope("supplies")))).mode & 0o777).toBe(0o600);
  await expect(planOpenClawKeyMigration(request)).rejects.toThrow("pending runtime journals");
  const recovered = await recoverPendingApply(root, "openclaw", transport, scope("supplies"));
  expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
  expect(recovered?.entries[0]?.keyMigration).toMatchObject({ legacyRemoval: original.mergeRemoval, planDigest: plan.planDigest });
  expect(await recoverPendingApply(root, "openclaw", transport, scope("supplies"))).toBeUndefined();
  expect(await readFile(join(root, path))).toEqual(before);
}));

it("refuses private ownership writes through an unsupported transport or a shared-writable metadata directory", () => withFixture(async (root, sourceRoot) => {
  const donor = await settings(sourceRoot, "supplies", topic({ ingest: true }));
  await legacy(root, donor, "supplies", {});
  const manifestPath = installManifestPath(root, "openclaw", scope("supplies"));
  const before = await readFile(manifestPath);
  const request = migration(root, donor, "supplies", [decide(topicKey("ingest"), "adopt-current")]);
  const plan = await planOpenClawKeyMigration(request);
  await expect(applyOpenClawKeyMigration({
    ...request, transport: { ...transport, writePrivateJsonAtomic: undefined },
  }, plan.planDigest)).rejects.toThrow("owner-only atomic metadata writer");
  await chmod(join(root, ".agentwheel"), 0o775);
  await expect(applyOpenClawKeyMigration(request, plan.planDigest)).rejects.toThrow("writable only by their owner");
  expect(await readFile(manifestPath)).toEqual(before);
  await expect(stat(applyJournalPath(root, "openclaw", scope("supplies")))).rejects.toMatchObject({ code: "ENOENT" });
}));
