import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { runProcess } from "../mutation/process.js";
import type { MutationPolicy } from "./mutation.js";

export interface MaintenanceStorage {
  workspaceRoot: string;
  sourceRoot: string;
  sourceRevision: string;
  workspaceHead: string;
  workspaceRepositoryRoot: string;
  workspaceConfigSha256: string;
  sourcePolicySha256: string;
  fleetId: string;
  registration: string;
  registryRoot: string;
}

const context = new AsyncLocalStorage<{ binding?: MaintenanceStorage }>();

function assertGitNamespaceEnvironment(): void {
  // Git's repository-local environment (git rev-parse --local-env-vars).
  const selectors = ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_INTERNAL_SUPER_PREFIX"];
  if (selectors.some(name => process.env[name] !== undefined)
      || Object.keys(process.env).some(name => /^GIT_CONFIG_(KEY|VALUE)_/.test(name))) {
    throw new Error("Native maintenance requires an unset repository-local Git environment.");
  }
}

function configurationShape(value: object): string {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.packages;
  delete copy.mutationPolicy;
  return JSON.stringify(copy);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertNativeMaintenancePolicy(policy: MutationPolicy | undefined): void {
  if (!maintenanceStorage()) return;
  if (!policy || policy.reason !== "required" || policy.journal !== "required"
      || policy.revisioning.mode !== "commit-after-verify" || policy.revisioning.provider.kind !== "git"
      || policy.revisioning.allowNoCommitOverride
      || digest(policy) !== maintenanceStorage()!.sourcePolicySha256) {
    throw new Error("Verified native maintenance policy changed.");
  }
}

export function withMaintenanceStorageContext<T>(action: () => T): T {
  return context.run({}, action);
}

export function maintenanceStorage(): MaintenanceStorage | undefined {
  return context.getStore()?.binding;
}

export function workspaceStorageRoot(root: string): string {
  const binding = maintenanceStorage();
  return binding && resolve(root) === binding.workspaceRoot ? binding.sourceRoot : root;
}

export function isMaintenanceRepository(root: string): boolean {
  return maintenanceStorage()?.sourceRoot === resolve(root);
}

export async function maintenanceLockRoot(): Promise<string | undefined> {
  const binding = maintenanceStorage();
  if (binding) assertGitNamespaceEnvironment();
  return binding?.workspaceRepositoryRoot;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await runProcess("git", ["-C", root, ...args])).stdout.toString("utf8").trim();
}

async function assertSourceHistory(sourceRoot: string, revision: string): Promise<void> {
  await git(sourceRoot, "merge-base", "--is-ancestor", revision, "HEAD");
  for (const commit of (await git(sourceRoot, "rev-list", `${revision}..HEAD`)).split("\n").filter(Boolean)) {
    const changed = await git(sourceRoot, "diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "--no-renames", "-r", commit);
    if (changed.split("\n").some(path => path && path !== ".agentwheel/config.json" && !path.startsWith(".agentwheel/locks/"))) {
      throw new Error("Maintenance source advanced outside native configuration/lock storage.");
    }
  }
}

async function assertSourceStorage(sourceRoot: string, workspaceRoot: string): Promise<void> {
  if (workspaceRoot === sourceRoot) throw new Error("Maintenance source must be an independent checkout.");
  if (await git(sourceRoot, "rev-parse", "--show-toplevel") !== sourceRoot) throw new Error("Maintenance source must be the Git root.");
  const ownerRelative = relative(await git(workspaceRoot, "rev-parse", "--show-toplevel"), workspaceRoot);
  if (ownerRelative === ".." || ownerRelative.startsWith(`..${sep}`) || isAbsolute(ownerRelative)) {
    throw new Error("Maintenance owner must remain inside its canonical Git worktree.");
  }
  if (await realpath(await git(sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"))
      === await realpath(await git(workspaceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"))) {
    throw new Error("Maintenance source must not share the managed Git directory.");
  }
  if (await realpath(join(sourceRoot, ".agentwheel")) !== join(sourceRoot, ".agentwheel")
      || !(await lstat(join(sourceRoot, ".agentwheel/config.json"))).isFile()) {
    throw new Error("Maintenance configuration must use regular independent storage.");
  }
  async function rejectLockLinks(directory: string): Promise<void> {
    const metadata = await lstat(directory).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isDirectory()) throw new Error("Maintenance graph-lock storage must use regular directories.");
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (entry.isSymbolicLink()) throw new Error("Maintenance graph-lock storage must not contain symlinks.");
      if (entry.isDirectory()) await rejectLockLinks(join(directory, entry.name));
    }
  }
  await rejectLockLinks(join(sourceRoot, ".agentwheel/locks"));
  const hooksPath = await runProcess("git", ["-C", sourceRoot, "config", "--get", "core.hooksPath"], { allowExitCodes: [0, 1] });
  if (hooksPath.stdout.toString("utf8").trim()) throw new Error("Maintenance source must not redirect Git hooks.");
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "reference-transaction"]) {
    const path = await git(sourceRoot, "rev-parse", "--git-path", `hooks/${name}`);
    try {
      await access(resolve(sourceRoot, path), constants.X_OK);
    } catch { continue; }
    throw new Error("Maintenance source must not execute commit/ref hooks.");
  }
}

export async function activateMaintenanceStorage(input: { fleet: string; source: string; revision: string; globalRoot?: string; recoveryOperation?: string }): Promise<void> {
  assertGitNamespaceEnvironment();
  if (!context.getStore()) throw new Error("Maintenance storage requires an isolated command context.");
  if (!/^[a-f0-9]{40}$/.test(input.revision)) throw new Error("Maintenance source requires an exact 40-hex revision.");
  const { showRegisteredFleet } = await import("./fleet.js");
  const { workspaceConfigSchema } = await import("./workspace.js");
  const registryRoot = resolve(input.globalRoot ?? homedir());
  const registration = await showRegisteredFleet(input.fleet, { globalRoot: registryRoot });
  const workspaceRoot = await realpath(registration.root);
  const sourceRoot = await realpath(input.source);
  await assertSourceStorage(sourceRoot, workspaceRoot);
  const dirty = await git(sourceRoot, "status", "--porcelain");
  if (dirty && !input.recoveryOperation) throw new Error("Maintenance source must be clean.");
  if (dirty) {
    const changed = await git(sourceRoot, "diff", "--name-only", "--no-renames", "HEAD", "--");
    const untracked = await git(sourceRoot, "ls-files", "--others", "--exclude-standard");
    if ([changed, untracked].some(output => output.split("\n").some(path => path
        && path !== ".agentwheel/config.json" && !path.startsWith(".agentwheel/locks/")))) {
      throw new Error("Maintenance recovery contains changes outside configuration/lock storage.");
    }
  }
  await assertSourceHistory(sourceRoot, input.revision);
  const workspaceHead = await git(workspaceRoot, "rev-parse", "HEAD");
  await git(sourceRoot, "merge-base", "--is-ancestor", workspaceHead, input.revision);
  const canonicalBytes = await readFile(join(workspaceRoot, ".agentwheel/config.json"));
  const canonical = workspaceConfigSchema.parse(JSON.parse(canonicalBytes.toString("utf8")));
  const source = workspaceConfigSchema.parse(JSON.parse(await readFile(join(sourceRoot, ".agentwheel/config.json"), "utf8")));
  if (!("fleetId" in source) || source.fleetId !== input.fleet || !("fleetId" in canonical) || canonical.fleetId !== input.fleet) {
    throw new Error("Maintenance storage must preserve the registered fleet identity.");
  }
  const policy = source.schemaVersion === 4 ? source.mutationPolicy : undefined;
  if (!policy || policy.reason !== "required" || policy.journal !== "required"
      || policy.revisioning.mode !== "commit-after-verify" || policy.revisioning.provider.kind !== "git"
      || policy.revisioning.allowNoCommitOverride) {
    throw new Error("Maintenance storage requires reason/journal and native Git commit verification.");
  }
  if (configurationShape(source) !== configurationShape(canonical)) throw new Error("Maintenance storage cannot change runtime profiles or workspace identity.");
  context.getStore()!.binding = {
    workspaceRoot, sourceRoot, sourceRevision: input.revision, workspaceHead,
    workspaceRepositoryRoot: await git(workspaceRoot, "rev-parse", "--show-toplevel"),
    workspaceConfigSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
    sourcePolicySha256: digest(policy),
    fleetId: input.fleet, registration: JSON.stringify(registration), registryRoot,
  };
  if (input.recoveryOperation) {
    const { readMutationReceipt } = await import("../mutation/receipts.js");
    const receipt = await readMutationReceipt(input.recoveryOperation);
    if (!receipt.maintenanceStorage) throw new Error("Recovery requires an existing maintenance receipt.");
    assertMaintenanceReceipt(receipt);
  }
}

export function assertMaintenancePaths(root: string, paths: readonly { path: string }[]): void {
  if (isMaintenanceRepository(root)
      && paths.some(item => item.path !== ".agentwheel/config.json" && !item.path.startsWith(".agentwheel/locks/"))) {
    throw new Error("Native maintenance may revise only configuration and graph-lock storage.");
  }
}

export async function assertMaintenanceLease(): Promise<void> {
  const binding = maintenanceStorage();
  if (!binding) return;
  assertGitNamespaceEnvironment();
  await assertSourceStorage(binding.sourceRoot, binding.workspaceRoot);
  await assertSourceHistory(binding.sourceRoot, binding.sourceRevision);
  const { showRegisteredFleet } = await import("./fleet.js");
  const { workspaceConfigSchema } = await import("./workspace.js");
  const bytes = await readFile(join(binding.workspaceRoot, ".agentwheel/config.json"));
  if (await git(binding.workspaceRoot, "rev-parse", "HEAD") !== binding.workspaceHead
      || await git(binding.workspaceRoot, "rev-parse", "--show-toplevel") !== binding.workspaceRepositoryRoot
      || createHash("sha256").update(bytes).digest("hex") !== binding.workspaceConfigSha256
      || JSON.stringify(await showRegisteredFleet(binding.fleetId, { globalRoot: binding.registryRoot })) !== binding.registration) {
    throw new Error("Canonical maintenance ownership/configuration lease changed.");
  }
  const canonical = workspaceConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  const source = workspaceConfigSchema.parse(JSON.parse(await readFile(join(binding.sourceRoot, ".agentwheel/config.json"), "utf8")));
  assertNativeMaintenancePolicy(source.schemaVersion === 4 ? source.mutationPolicy : undefined);
  if (configurationShape(source) !== configurationShape(canonical)) {
    throw new Error("Verified maintenance runtime profiles or identity changed.");
  }
}

export function assertMaintenanceReceipt(receipt: { maintenanceStorage?: MaintenanceStorage }): void {
  const original = receipt.maintenanceStorage;
  const current = maintenanceStorage();
  if (original && (!current || Object.keys(original).length !== Object.keys(current).length
      || (Object.keys(original) as (keyof MaintenanceStorage)[]).some(key => original[key] !== current[key]))) {
    throw new Error("Recovery requires the original verified maintenance storage/ownership binding.");
  }
}
