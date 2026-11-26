import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { registerFleet, resolveWorkspaceOwnershipScope } from "../src/model/fleet.js";
import { readWorkspaceConfig, writeWorkspaceConfig, workspaceConfigPath } from "../src/model/workspace.js";
import { activateMaintenanceStorage, assertMaintenanceLease, assertMaintenanceReceipt, maintenanceLockRoot, maintenanceStorage, withMaintenanceStorageContext, workspaceStorageRoot } from "../src/model/maintenance-storage.js";
import { GovernedMutation, recoverMutationRuntime, resumeMutation } from "../src/mutation/coordinator.js";
import { invokeRevisionProvider } from "../src/mutation/providers.js";
import { acquireMutationLock, readMutationReceipt, updateMutationReceipt } from "../src/mutation/receipts.js";

import { applyCombinedInstallPlan, createCombinedInstallPlan, type DesiredArtifact } from "../src/install/index.js";
import { applyJournalPath } from "../src/install/transaction.js";
import { installManifestPath } from "../src/install/paths.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const exec = promisify(execFile);
const roots: string[] = [];
const previousState = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
afterEach(async () => {
  if (previousState === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = previousState;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function git(root: string, ...args: string[]) {
  return (await exec("git", ["-C", root, ...args])).stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-maintenance-test-"));
  roots.push(root);
  const canonical = join(root, "owner"), source = join(root, "source"), globalRoot = join(root, "home");
  await mkdir(join(canonical, ".agentwheel"), { recursive: true });
  await mkdir(join(canonical, ".syncwheel"));
  await mkdir(globalRoot);
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = join(root, "mutation-state");
  await git(canonical, "init", "-b", "main");
  await git(canonical, "config", "user.name", "Fixture");
  await git(canonical, "config", "user.email", "fixture@example.invalid");
  const policy = {
    reason: "required", journal: "required", revisioning: {
      mode: "commit-after-verify", allowNoCommitOverride: false, reasonInCommit: "full",
      provider: { kind: "command", id: "guard", command: ["/never/execute"],
        executableSha256: "a".repeat(64), trustBoundary: "entrypoint", protocolVersion: 1 },
    },
  };
  await writeFile(workspaceConfigPath(canonical), JSON.stringify({ schemaVersion: 4, fleetId: "fixture",
    packages: [{ name: "core", source: "/synthetic/source", driver: "local", adapter: "codex", mode: "pinned" }],
    mutationPolicy: policy }));
  await writeFile(join(canonical, ".syncwheel/manifest.json"), "{}");
  await git(canonical, "add", ".");
  await git(canonical, "commit", "-qm", "base");
  await registerFleet({ id: "fixture", root: canonical, requiredPackages: ["core"], globalRoot });
  await exec("git", ["clone", "--no-hardlinks", canonical, source]);
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  const config = JSON.parse(await readFile(workspaceConfigPath(source), "utf8"));
  config.mutationPolicy.revisioning.provider = { kind: "git", id: "git", protocolVersion: 1 };
  await writeFile(workspaceConfigPath(source), JSON.stringify(config));
  await git(source, "add", ".agentwheel/config.json");
  await git(source, "commit", "-qm", "reviewed native maintenance policy");
  const revision = await git(source, "rev-parse", "HEAD");
  await mkdir(join(canonical, ".git/hooks"), { recursive: true });
  for (const name of ["pre-commit", "reference-transaction"]) {
    const hook = join(canonical, ".git/hooks", name);
    await writeFile(hook, `#!/bin/sh\nprintf invoked >> '${root}/forbidden-hook'\nexit 89\n`);
    await chmod(hook, 0o700);
  }
  return { root, canonical, source, globalRoot, revision,
    activate: () => activateMaintenanceStorage({ fleet: "fixture", source, revision, globalRoot }) };
}

it("commits only in independent storage while retaining registered identity and owner HEAD/index/config", async () => {
  const f = await fixture();
  const beforeHead = await git(f.canonical, "rev-parse", "HEAD");
  const beforeRefs = await git(f.canonical, "for-each-ref", "--format=%(refname) %(objectname)");
  const index = await readFile(join(f.canonical, ".git/index"));
  const config = await readFile(workspaceConfigPath(f.canonical));
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    expect(workspaceStorageRoot(f.canonical)).toBe(f.source);
    expect(await resolveWorkspaceOwnershipScope(f.canonical, { fleetId: "fixture", globalRoot: f.globalRoot }))
      .toEqual({ root: f.canonical, fleetId: "fixture" });
    const mutation = await GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel pin", reason: "Pin reviewed synthetic package", operationId: "maintenance-pin" });
    const proposed = await readWorkspaceConfig(f.canonical);
    proposed.packages[0].requestedRef = "b".repeat(40);
    await writeWorkspaceConfig(f.canonical, proposed);
    const receipt = await mutation!.complete();
    expect(receipt.repositoryRoot).toBe(f.source);
    expect(receipt.workspaceRoot).toBe(f.canonical);
    expect(receipt.maintenanceStorage?.sourceRevision).toBe(f.revision);
    expect(receipt.provider?.kind).toBe("git");
    expect(receipt.status).toBe("succeeded");
    await assertMaintenanceLease();
  });
  expect(await git(f.canonical, "rev-parse", "HEAD")).toBe(beforeHead);
  expect(await git(f.canonical, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(beforeRefs);
  expect(await readFile(join(f.canonical, ".git/index"))).toEqual(index);
  expect(await readFile(workspaceConfigPath(f.canonical))).toEqual(config);
  expect(await git(f.source, "rev-parse", "HEAD")).not.toBe(f.revision);
  expect(await readFile(join(f.root, "forbidden-hook")).catch(() => null)).toBeNull();
});

it("rejects dirty sources and source profile/identity changes before binding", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "foreign"), "uncommitted");
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("must be clean");
    expect(maintenanceStorage()).toBeUndefined();
  });
  await rm(join(f.source, "foreign"));
  const config = JSON.parse(await readFile(workspaceConfigPath(f.source), "utf8"));
  config.fleetId = "another";
  await writeFile(workspaceConfigPath(f.source), JSON.stringify(config));
  await git(f.source, "add", ".");
  await git(f.source, "commit", "-qm", "wrong identity");
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("fleet identity");
  });
});

it("uses the owner's existing mutation lock and refuses canonical configuration drift", async () => {
  const f = await fixture();
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    const lock = await acquireMutationLock(f.canonical, "other-writer");
    await expect(GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel install", reason: "qualified fixture" })).rejects.toThrow("Another Agentwheel mutation");
    await lock.release();
    await writeFile(join(f.canonical, ".agentwheel/config.json"), "{}");
    await expect(assertMaintenanceLease()).rejects.toThrow("lease changed");
  });
});

it("rejects source hooks and graph-lock symlinks without invoking the owner hooks", async () => {
  const f = await fixture();
  const hook = join(f.source, ".git/hooks/pre-commit");
  await mkdir(join(f.source, ".git/hooks"), { recursive: true });
  await writeFile(hook, "#!/bin/sh\nexit 89\n");
  await chmod(hook, 0o700);
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("commit/ref hooks");
  });
  await rm(hook);
  await mkdir(join(f.root, "foreign-locks"));
  await symlink(join(f.root, "foreign-locks"), join(f.source, ".agentwheel/locks"));
  await git(f.source, "add", ".agentwheel/locks");
  await git(f.source, "commit", "-qm", "invalid lock storage");
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("regular directories");
  });
  expect(await readFile(join(f.root, "forbidden-hook")).catch(() => null)).toBeNull();
});

it("refuses non-metadata history even when its content is later reverted", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "foreign"), "product change");
  await git(f.source, "add", ".");
  await git(f.source, "commit", "-qm", "foreign product");
  await git(f.source, "revert", "--no-edit", "HEAD");
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("outside native configuration/lock storage");
  });
});

it("requires the original binding to recover a maintenance receipt", async () => {
  const f = await fixture();
  let original: ReturnType<typeof maintenanceStorage>;
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    original = maintenanceStorage();
    expect(() => assertMaintenanceReceipt({ maintenanceStorage: original })).not.toThrow();
    expect(() => assertMaintenanceReceipt({ maintenanceStorage: { ...original!, sourceRevision: "f".repeat(40) } }))
      .toThrow("original verified maintenance");
  });
  expect(() => assertMaintenanceReceipt({ maintenanceStorage: original })).toThrow("original verified maintenance");
});

it.each(["off", "command", "profile"])("refuses post-activation source %s drift before beginning a mutation", async kind => {
  const f = await fixture();
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    const config = JSON.parse(await readFile(workspaceConfigPath(f.source), "utf8"));
    if (kind === "off") {
      config.mutationPolicy.revisioning = { mode: "off" };
      config.mutationPolicy.journal = "off";
    } else if (kind === "command") {
      config.mutationPolicy.revisioning.provider = { kind: "command", id: "forbidden", command: ["/never/execute"],
        executableSha256: "a".repeat(64), trustBoundary: "entrypoint", protocolVersion: 1 };
    } else config.bootstrapSkills = false;
    await writeFile(workspaceConfigPath(f.source), JSON.stringify(config));
    await expect(assertMaintenanceLease()).rejects.toThrow(/maintenance.*changed/i);
    await expect(GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel install", reason: "Qualified source drift refusal" }))
      .rejects.toThrow(/maintenance.*changed/i);
  });
});

it("rechecks source ancestry and product history after activation before mutation", async () => {
  const f = await fixture();
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    await writeFile(join(f.source, "foreign-product"), "concurrent product");
    await git(f.source, "add", "foreign-product");
    await git(f.source, "commit", "-qm", "concurrent product");
    await expect(assertMaintenanceLease()).rejects.toThrow("outside native configuration/lock storage");
    await expect(GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel install", reason: "Qualified source history refusal" }))
      .rejects.toThrow("outside native configuration/lock storage");
  });
});

it("recovers dirty metadata only with the original receipt and registered owner", async () => {
  const f = await fixture();
  let operationId = "";
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    const mutation = await GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel pin", reason: "Recover verified package pin" });
    operationId = mutation!.operationId;
    const config = await readWorkspaceConfig(f.canonical);
    config.packages[0].requestedRef = "e".repeat(40);
    await writeWorkspaceConfig(f.canonical, config);
    await mutation!.fail(new Error("Interrupted after successful handler"));
    await updateMutationReceipt(await readMutationReceipt(operationId), { status: "handler-succeeded" });
  });
  await withMaintenanceStorageContext(async () => {
    await expect(f.activate()).rejects.toThrow("must be clean");
    await activateMaintenanceStorage({ fleet: "fixture", source: f.source, revision: f.revision,
      globalRoot: f.globalRoot, recoveryOperation: operationId });
    const recovered = await resumeMutation(operationId, "recover");
    expect(recovered.status).toBe("succeeded");
    expect(recovered.workspaceRoot).toBe(f.canonical);
    expect(recovered.repositoryRoot).toBe(f.source);
  });
  expect(await git(f.source, "status", "--porcelain")).toBe("");
  expect(await readFile(join(f.root, "forbidden-hook")).catch(() => null)).toBeNull();
});

it("refuses a command-provider dispatch despite an otherwise valid source binding", async () => {
  const f = await fixture();
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    await expect(invokeRevisionProvider({ kind: "command", id: "forbidden", command: ["/never/execute"],
      executableSha256: "a".repeat(64), trustBoundary: "entrypoint", protocolVersion: 1 }, {
      protocolVersion: 1, action: "check", operationId: "native-forbidden-provider", repositoryRoot: f.source,
      expectedHead: f.revision, commandName: "agentwheel pin", reason: "Refuse circular provider",
      noCommit: false, paths: [],
    }, { workspaceRoot: f.canonical })).rejects.toThrow("verified independent Git provider");
  });
});

it("rechecks source hooks after activation without executing them", async () => {
  const f = await fixture();
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    const hook = join(f.source, ".git/hooks/reference-transaction");
    await writeFile(hook, "#!/bin/sh\nexit 89\n");
    await chmod(hook, 0o700);
    await expect(assertMaintenanceLease()).rejects.toThrow("commit/ref hooks");
  });
});

it("shares the existing repository mutex when the registered fleet root is nested", async () => {
  const f = await fixture();
  const nested = join(f.canonical, "nested-fleet");
  await mkdir(join(nested, ".agentwheel"), { recursive: true });
  await writeFile(workspaceConfigPath(nested), await readFile(workspaceConfigPath(f.canonical)));
  const globalConfig = await readWorkspaceConfig(f.globalRoot);
  if (!("fleets" in globalConfig) || !globalConfig.fleets?.fixture) throw new Error("Missing fixture registration");
  globalConfig.fleets.fixture.root = nested;
  await writeWorkspaceConfig(f.globalRoot, globalConfig);
  await withMaintenanceStorageContext(async () => {
    await activateMaintenanceStorage({ fleet: "fixture", source: f.source, revision: f.revision, globalRoot: f.globalRoot });
    const lock = await acquireMutationLock(f.canonical, "existing-repository-writer");
    try {
      await expect(GovernedMutation.begin({ workspaceRoot: nested, globalRoot: f.globalRoot,
        commandName: "agentwheel pin", reason: "Preserve canonical repository mutex" }))
        .rejects.toThrow("Another Agentwheel mutation");
    } finally { await lock.release(); }
  });
});

it.each(["GIT_WORK_TREE", "GIT_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"])("refuses post-bind %s without changing the canonical mutex", async name => {
  const f = await fixture();
  const previous = process.env[name];
  try {
    await withMaintenanceStorageContext(async () => {
      await f.activate();
      const lock = await acquireMutationLock(f.canonical, "existing-writer");
      try {
        process.env[name] = f.source;
        await expect(assertMaintenanceLease()).rejects.toThrow("repository-local Git environment");
        await expect(maintenanceLockRoot()).rejects.toThrow("repository-local Git environment");
        await expect(GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
          commandName: "agentwheel pin", reason: "Preserve canonical namespace" }))
          .rejects.toThrow("repository-local Git environment");
      } finally { await lock.release(); }
    });
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
});

it("rechecks the maintenance lease under the recovery mutex before replaying a pending runtime journal", async () => {
  const f = await fixture();
  const runtime = join(f.root, "runtime"), artifactPath = join(f.root, "rule.md");
  await mkdir(runtime);
  await writeFile(artifactPath, "Reviewed runtime rule\n");
  const adapter = { name: "recovery-fixture", targets: { rules: { local: { enabled: true, dest: ".runtime/rules" } } } };
  const artifact: DesiredArtifact = { type: "rules", name: "rule.md", sourcePath: artifactPath,
    stagedPath: artifactPath, relativePath: "rules/rule.md", kind: "file", hash: await hashPath(artifactPath),
    channel: "managed", meta: { logicalSelector: "rules/rule.md", dependencyRole: "root", owners: ["core"] } };
  const journalPath = applyJournalPath(runtime, adapter.name, { installationType: "local" });
  const manifestPath = installManifestPath(runtime, adapter.name, { installationType: "local" });
  const runtimePath = join(runtime, ".runtime/rules/rule.md");
  await withMaintenanceStorageContext(async () => {
    await f.activate();
    const plan = await createCombinedInstallPlan([artifact], adapter, runtime);
    const mutation = await GovernedMutation.begin({ workspaceRoot: f.canonical, globalRoot: f.globalRoot,
      commandName: "agentwheel install", operationId: "maintenance-runtime-race", reason: "Recover a reviewed runtime rule" });
    try {
      await applyCombinedInstallPlan(plan, { transport: { ...localTransport, async atomicCopy() {
        throw new Error("injected before runtime copy");
      } } });
      throw new Error("Expected injected failure");
    } catch (error) {
      expect(String(error)).toContain("injected before runtime copy");
      await mutation!.fail(error);
    }
    expect((await readMutationReceipt("maintenance-runtime-race")).runtimeJournals[0]?.status).toBe("pending");
    const bytes = async (path: string) => readFile(path).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const before = { runtime: await bytes(runtimePath), manifest: await bytes(manifestPath), journal: await bytes(journalPath) };
    expect(before.runtime).toBeNull();
    expect(before.journal).not.toBeNull();
    await assertMaintenanceLease();
    await expect(recoverMutationRuntime("maintenance-runtime-race", { afterLockAcquired: async () => {
      const config = await readFile(join(f.canonical, ".agentwheel/config.json"), "utf8");
      await writeFile(join(f.canonical, ".agentwheel/config.json"), config + "\n");
    } })).rejects.toThrow("lease changed");
    expect(await bytes(runtimePath)).toEqual(before.runtime);
    expect(await bytes(manifestPath)).toEqual(before.manifest);
    expect(await bytes(journalPath)).toEqual(before.journal);
  });
});
