import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mutationPolicySchema, type MutationPolicy } from "../model/mutation.js";
import { readWorkspaceConfig } from "../model/workspace.js";
import {
  beginMutationPathDeclarations,
  declareMutationPath,
  declaredMutationPaths,
  endMutationPathDeclarations,
  readMutationPathDeclarations,
  resumeMutationPathDeclarations,
} from "./declarations.js";
import { invokeRevisionProvider, revisionProviderRejection } from "./providers.js";
import { mutationOperationIdSchema, mutationReasonSchema, revisionProviderRequestSchema, type RevisionPath, type RevisionProviderRequest } from "./protocol.js";
import {
  acquireMutationLock,
  createMutationReceipt,
  readMutationReceipt,
  updateMutationReceipt,
  type MutationLock,
  type MutationReceipt,
  type RuntimeJournalReceipt,
} from "./receipts.js";
import {
  collectIntroducedPaths,
  currentHead,
  discoverGitRepository,
  assertGitPreflight,
  snapshotRepository,
  type RepositorySnapshot,
} from "./repository.js";
import { describeDirtyPathOwnership } from "./session-ownership.js";

export interface BeginMutationOptions {
  workspaceRoot: string;
  commandName: string;
  reason?: string;
  operationId?: string;
  noCommit?: boolean;
  anticipatedPaths?: string[];
  requireCleanWorkingTree?: boolean;
  globalRoot?: string;
  additionalWorkspaceRoots?: string[];
  requiresDeclarativeRepositoryDelta?: boolean;
}

export class GovernedMutation {
  readonly operationId: string;
  private closed = false;

  private constructor(
    private readonly policy: MutationPolicy,
    private receipt: MutationReceipt,
    private readonly baseline: RepositorySnapshot | undefined,
    private readonly lock: MutationLock,
  ) {
    this.operationId = receipt.operationId;
  }

  static async begin(options: BeginMutationOptions): Promise<GovernedMutation | undefined> {
    const policy = await mutationPolicyForWorkspace(options.workspaceRoot, options.globalRoot);
    if (!policy) {
      if (options.noCommit) throw new Error("--no-commit requires an effective commit-after-verify mutation policy.");
      return undefined;
    }
    const reason = normalizeReason(options.reason, options.commandName, policy);
    if (policy.revisioning.mode === "off") {
      if (options.noCommit) throw new Error("--no-commit is only valid when revisioning.mode is commit-after-verify.");
      if (policy.journal === "off") return undefined;
    } else if (options.noCommit && !policy.revisioning.allowNoCommitOverride) {
      throw new Error("This workspace does not allow the audited --no-commit override.");
    }

    const operationId = mutationOperationIdSchema.parse(options.operationId ?? randomUUID());
    const repository = await discoverGitRepository(options.workspaceRoot);
    if (policy.revisioning.mode === "commit-after-verify" && !repository) {
      throw new Error(`commit-after-verify requires a Git repository containing ${options.workspaceRoot}.`);
    }
    if (policy.revisioning.mode === "commit-after-verify" && options.requiresDeclarativeRepositoryDelta) {
      throw new Error(
        `${options.commandName} is a runtime-only ownership transition with no durable declarative repository representation; commit-after-verify refuses it before writes.`,
      );
    }
    if (policy.revisioning.mode === "commit-after-verify" && repository) {
      for (const additionalRoot of options.additionalWorkspaceRoots ?? []) {
        const additionalRepository = await discoverGitRepository(additionalRoot);
        if (!additionalRepository || additionalRepository.root !== repository.root) {
          throw new Error(
            "commit-after-verify refuses a mutation spanning multiple repositories or non-repository state; split it into governed single-repository operations.",
          );
        }
      }
    }
    const lock = await acquireMutationLock(repository?.root ?? options.workspaceRoot, operationId);
    let baseline: RepositorySnapshot | undefined;
    let receipt: MutationReceipt | undefined;
    try {
      baseline = repository ? await snapshotRepository(repository.root) : undefined;
      receipt = await createMutationReceipt({
        operationId,
        commandName: options.commandName,
        reason,
        noCommit: options.noCommit === true,
        workspaceRoot: options.workspaceRoot,
        repositoryRoot: repository?.root ?? null,
        expectedHead: repository?.head ?? null,
        expectedManifestDigest: null,
        revisionMode: policy.revisioning.mode,
        provider: policy.revisioning.mode === "commit-after-verify" ? policy.revisioning.provider : null,
        preexistingPaths: snapshotEntries(baseline),
        paths: [],
        runtimeJournals: [],
        status: "prepared",
      });
      if (policy.revisioning.mode === "commit-after-verify"
        && options.requireCleanWorkingTree
        && baseline
        && baseline.changed.size > 0) {
        const changedPaths = [...baseline.changed.keys()].sort();
        const ownership = await describeDirtyPathOwnership(repository!.root, changedPaths);
        throw new Error(
          `This governed command computes declarative paths during planning and requires a clean working tree before runtime mutation; found: ${changedPaths.join(", ")}. ${ownership}`,
        );
      }
      beginMutationPathDeclarations(
        repository?.root ?? options.workspaceRoot,
        operationId,
        baseline?.changed.keys(),
      );
      for (const path of options.anticipatedPaths ?? []) declareMutationPath(path);
      if (policy.revisioning.mode === "commit-after-verify" && repository) {
        await invokeRevisionProvider(policy.revisioning.provider, providerRequest(receipt, "check", []), {
          workspaceRoot: options.workspaceRoot,
        });
      }
      const mutation = new GovernedMutation(policy, receipt, baseline, lock);
      activeMutation = mutation;
      return mutation;
    } catch (error) {
      if (receipt) {
        await updateMutationReceipt(receipt, { status: "precheck-failed", error: sanitizeError(error) }).catch(() => undefined);
      }
      endMutationPathDeclarations();
      await lock.release();
      throw error;
    }
  }

  async complete(action: "finalize" | "recover" = "finalize"): Promise<MutationReceipt> {
    if (this.closed) return this.receipt;
    let paths: RevisionPath[];
    try {
      const pendingRuntimeJournals = this.receipt.runtimeJournals.filter((entry) => entry.status !== "resolved");
      if (pendingRuntimeJournals.length > 0) {
        throw new Error(
          `Runtime apply verification is incomplete: ${pendingRuntimeJournals.map((entry) => entry.path).join(", ")}.`,
        );
      }
      this.receipt = await updateMutationReceipt(this.receipt, { status: "handler-succeeded" });
      paths = await this.collectPaths();
      this.receipt = await updateMutationReceipt(this.receipt, { paths, status: "mutation-applied" });
    } catch (error) {
      this.receipt = await updateMutationReceipt(this.receipt, {
        status: "postcheck-failed",
        error: sanitizeError(error),
      });
      await this.close();
      throw new Error(`Agentwheel mutation ${this.operationId} failed its repository postcheck: ${sanitizeError(error)}`);
    }

    try {
      if (this.policy.revisioning.mode === "off") {
        this.receipt = await updateMutationReceipt(this.receipt, {
          status: paths.length === 0 ? "no-repository-delta" : "succeeded",
        });
        return this.receipt;
      }

      const provider = this.policy.revisioning.provider;
      await invokeRevisionProvider(provider, providerRequest(this.receipt, "preflight", paths), {
        workspaceRoot: this.receipt.workspaceRoot,
      });
      const response = await invokeRevisionProvider(provider, providerRequest(this.receipt, action, paths), {
        workspaceRoot: this.receipt.workspaceRoot,
      });
      this.receipt = await updateMutationReceipt(this.receipt, {
        status: receiptStatusForProvider(response.status),
        providerResponse: response,
      });
      return this.receipt;
    } catch (error) {
      this.receipt = await updateMutationReceipt(this.receipt, {
        status: "commit-pending",
        ...(revisionProviderRejection(error) ? { providerResponse: revisionProviderRejection(error) } : {}),
        error: sanitizeError(error),
      });
      throw new Error(`Agentwheel mutation ${this.operationId} is commit-pending: ${sanitizeError(error)}`);
    } finally {
      await this.close();
    }
  }

  async fail(error: unknown): Promise<void> {
    if (this.closed) return;
    try {
      let paths: RevisionPath[] = this.receipt.paths;
      try {
        paths = await this.collectPaths();
      } catch {
        // Preserve the primary command error. The declaration journal remains available for explicit recovery.
      }
      this.receipt = await updateMutationReceipt(this.receipt, {
        paths,
        status: "partial",
        error: sanitizeError(error),
      });
      if (this.policy.revisioning.mode === "commit-after-verify") {
        await invokeRevisionProvider(
          this.policy.revisioning.provider,
          providerRequest(this.receipt, "release", paths),
          { workspaceRoot: this.receipt.workspaceRoot },
        ).catch(() => undefined);
      }
    } finally {
      await this.close();
    }
  }

  metadata(): { operationId: string; reason: string; noCommit: boolean; revisionMode: MutationReceipt["revisionMode"] } {
    return {
      operationId: this.receipt.operationId,
      reason: this.receipt.reason,
      noCommit: this.receipt.noCommit,
      revisionMode: this.receipt.revisionMode,
    };
  }

  async transitionRuntimeJournal(
    link: Omit<RuntimeJournalReceipt, "status">,
    status: RuntimeJournalReceipt["status"],
  ): Promise<void> {
    const runtimeJournals = upsertRuntimeJournal(this.receipt.runtimeJournals, link, status);
    this.receipt = await updateMutationReceipt(this.receipt, { runtimeJournals });
  }

  async transitionExistingRuntimeJournal(path: string, status: RuntimeJournalReceipt["status"]): Promise<void> {
    const existing = this.receipt.runtimeJournals.find((entry) => entry.path === path);
    if (!existing) throw new Error(`Mutation '${this.operationId}' has no runtime journal link for ${path}.`);
    const runtimeJournals = upsertRuntimeJournal(this.receipt.runtimeJournals, existing, status);
    this.receipt = await updateMutationReceipt(this.receipt, { runtimeJournals });
  }

  static activateExisting(
    receipt: MutationReceipt,
    baseline: RepositorySnapshot | undefined,
    lock: MutationLock,
  ): GovernedMutation {
    if (receipt.revisionMode === "commit-after-verify" && !receipt.provider) {
      throw new Error(`Mutation '${receipt.operationId}' is missing its revision provider recovery policy.`);
    }
    const policy = mutationPolicySchema.parse(receipt.revisionMode === "commit-after-verify"
      ? {
          reason: "required",
          journal: "required",
          revisioning: {
            mode: "commit-after-verify",
            allowNoCommitOverride: true,
            reasonInCommit: "full",
            provider: receipt.provider,
          },
        }
      : {
          reason: "required",
          journal: "required",
          revisioning: { mode: "off" },
        });
    const mutation = new GovernedMutation(policy, receipt, baseline, lock);
    activeMutation = mutation;
    return mutation;
  }

  private async collectPaths(): Promise<RevisionPath[]> {
    if (!this.receipt.repositoryRoot || !this.receipt.expectedHead || !this.baseline) return [];
    const declarations = [...new Set([
      ...declaredMutationPaths(),
      ...readMutationPathDeclarations(this.receipt.operationId),
    ])].sort((a, b) => a.localeCompare(b));
    return collectIntroducedPaths(this.receipt.repositoryRoot, this.receipt.expectedHead, this.baseline, declarations);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (activeMutation === this) activeMutation = undefined;
    endMutationPathDeclarations();
    await this.lock.release();
  }
}

let activeMutation: GovernedMutation | undefined;

export function activeMutationMetadata(): {
  operationId: string;
  reason: string;
  noCommit: boolean;
  revisionMode: MutationReceipt["revisionMode"];
} | undefined {
  return activeMutation?.metadata();
}

export async function reserveActiveRuntimeJournal(link: Omit<RuntimeJournalReceipt, "status">): Promise<void> {
  await activeMutation?.transitionRuntimeJournal(link, "reserved");
}

export async function activateActiveRuntimeJournal(link: Omit<RuntimeJournalReceipt, "status">): Promise<void> {
  await activeMutation?.transitionRuntimeJournal(link, "pending");
}

export async function beginResolveMutationRuntimeJournal(operationId: string, path: string): Promise<void> {
  await transitionMutationRuntimeJournal(operationId, path, "resolving");
}

export async function resolveMutationRuntimeJournal(operationId: string, path: string): Promise<void> {
  await transitionMutationRuntimeJournal(operationId, path, "resolved");
}

async function transitionMutationRuntimeJournal(
  operationId: string,
  path: string,
  status: RuntimeJournalReceipt["status"],
): Promise<void> {
  if (activeMutation?.operationId === operationId) {
    await activeMutation.transitionExistingRuntimeJournal(path, status);
    return;
  }
  const receipt = await readMutationReceipt(operationId);
  const existing = receipt.runtimeJournals.find((entry) => entry.path === path);
  if (!existing) throw new Error(`Mutation '${operationId}' has no runtime journal link for ${path}.`);
  await updateMutationReceipt(receipt, {
    runtimeJournals: upsertRuntimeJournal(receipt.runtimeJournals, existing, status),
  });
}


export async function resumeMutation(operationId: string, action: "finalize" | "recover"): Promise<MutationReceipt> {
  let receipt = await readMutationReceipt(operationId);
  if (["succeeded", "revisioning-skipped", "no-repository-delta"].includes(receipt.status)) return receipt;
  if (["prepared", "precheck-failed", "partial", "postcheck-failed", "failed"].includes(receipt.status)) {
    throw new Error(
      `Mutation '${receipt.operationId}' is ${receipt.status}; finalize/recover is refused because handler success and runtime journal resolution were not verified.`,
    );
  }
  const pendingRuntimeJournals = receipt.runtimeJournals.filter((entry) => entry.status !== "resolved");
  if (pendingRuntimeJournals.length > 0) {
    throw new Error(
      `Mutation '${receipt.operationId}' still has unresolved runtime apply journals: ${pendingRuntimeJournals.map((entry) => entry.path).join(", ")}.`,
    );
  }
  if (!receipt.provider || !receipt.repositoryRoot || !receipt.expectedHead || receipt.revisionMode !== "commit-after-verify") {
    throw new Error(`Mutation '${receipt.operationId}' has no revision provider recovery contract.`);
  }
  const provider = receipt.provider;
  const repositoryRoot = receipt.repositoryRoot;
  const expectedHead = receipt.expectedHead;
  const lock = await acquireMutationLock(repositoryRoot, receipt.operationId);
  try {
    let paths = receipt.paths;
    const head = await currentHead(repositoryRoot);
    if (paths.length === 0 && head === expectedHead) {
      paths = await collectIntroducedPaths(
        repositoryRoot,
        expectedHead,
        snapshotFromReceipt(receipt),
        readMutationPathDeclarations(receipt.operationId),
      );
      receipt = await updateMutationReceipt(receipt, { paths, status: "mutation-applied" });
    }
    await invokeRevisionProvider(provider, providerRequest(receipt, "preflight", paths), {
      workspaceRoot: receipt.workspaceRoot,
    });
    const response = await invokeRevisionProvider(provider, providerRequest(receipt, action, paths), {
      workspaceRoot: receipt.workspaceRoot,
    });
    return updateMutationReceipt(receipt, {
      status: receiptStatusForProvider(response.status),
      providerResponse: response,
      error: undefined,
    });
  } catch (error) {
    receipt = await updateMutationReceipt(receipt, {
      status: "commit-pending",
      ...(revisionProviderRejection(error) ? { providerResponse: revisionProviderRejection(error) } : {}),
      error: sanitizeError(error),
    });
    throw error;
  } finally {
    await lock.release();
  }
}

export interface RecoverMutationRuntimeOptions {
  /** Test-only scheduling seam; durable state is reread after this barrier while the mutation lock is held. */
  afterLockAcquired?: () => void | Promise<void>;
}

export async function recoverMutationRuntime(
  operationId: string,
  options: RecoverMutationRuntimeOptions = {},
): Promise<MutationReceipt> {
  let receipt = await readMutationReceipt(operationId);
  const lockRoot = receipt.repositoryRoot ?? receipt.workspaceRoot;
  const lock = await acquireMutationLock(lockRoot, receipt.operationId);
  try {
    await options.afterLockAcquired?.();
    receipt = await readMutationReceipt(operationId);
    assertRuntimeRecoveryReceipt(receipt);
  } catch (error) {
    await lock.release();
    throw error;
  }

  const pending = receipt.runtimeJournals.filter((entry) => entry.status !== "resolved");
  const baseline = receipt.repositoryRoot ? snapshotFromReceipt(receipt) : undefined;
  const declarationRoot = receipt.repositoryRoot ?? receipt.workspaceRoot;
  let mutation: GovernedMutation | undefined;
  resumeMutationPathDeclarations(declarationRoot, receipt.operationId, baseline?.changed.keys());
  try {
    if (receipt.repositoryRoot && receipt.expectedHead && baseline) {
      const declarations = readMutationPathDeclarations(receipt.operationId);
      const repository = await discoverGitRepository(receipt.repositoryRoot);
      if (!repository || repository.root !== receipt.repositoryRoot || repository.head !== receipt.expectedHead) {
        throw new Error(
          `Mutation '${receipt.operationId}' repository HEAD lease changed before runtime recovery.`,
        );
      }
      await assertGitPreflight(repository);
      await collectIntroducedPaths(receipt.repositoryRoot, receipt.expectedHead, baseline, declarations);
    }

    mutation = GovernedMutation.activateExisting(receipt, baseline, lock);
    const [{ recoverPendingApply }, { readLinkedLocalApplyJournal, removeApplyJournal, localPathExists }] = await Promise.all([
      import("../install/apply.js"),
      import("../install/transaction.js"),
    ]);
    let missingReservation = false;
    for (const entry of pending) {
      if (entry.transport !== "local") {
        throw new Error(`Runtime recovery for ${entry.transportDescription} is unsupported until a durable remote recovery protocol exists.`);
      }
      const exists = await localPathExists(entry.path);
      if (!exists) {
        if (entry.status === "reserved") {
          await resolveMutationRuntimeJournal(receipt.operationId, entry.path);
          missingReservation = true;
          continue;
        }
        if (entry.status === "resolving") {
          await resolveMutationRuntimeJournal(receipt.operationId, entry.path);
          continue;
        }
        throw new Error(`Runtime apply journal ${entry.path} disappeared while its receipt was ${entry.status}.`);
      }
      const journal = await readLinkedLocalApplyJournal(
        entry.path,
        receipt.operationId,
        entry.journalDigest,
        entry.transportDescription,
      );
      if (journal.mutation?.reason !== receipt.reason || journal.mutation.noCommit !== receipt.noCommit) {
        throw new Error(`Runtime apply journal ${entry.path} mutation metadata does not match its durable receipt.`);
      }
      if (entry.status === "resolving") {
        await removeApplyJournal(journal.targetRoot, journal.adapter, undefined, {
          installationType: journal.installationType,
          stateKey: journal.stateKey,
        });
        continue;
      }
      const recovered = await recoverPendingApply(journal.targetRoot, journal.adapter, undefined, {
        installationType: journal.installationType,
        stateKey: journal.stateKey,
      });
      if (!recovered) throw new Error(`Runtime apply journal ${entry.path} could not be recovered deterministically.`);
    }
    if (missingReservation) {
      throw new Error("A reserved runtime journal was never created, so the interrupted handler must be rerun as a new governed operation.");
    }
    return await mutation.complete("recover");
  } catch (error) {
    if (mutation) {
      await mutation.fail(error).catch(() => undefined);
    } else {
      receipt = await updateMutationReceipt(receipt, { status: "partial", error: sanitizeError(error) });
      endMutationPathDeclarations();
      await lock.release();
    }
    throw new Error(`Agentwheel mutation ${receipt.operationId} runtime recovery failed: ${sanitizeError(error)}`);
  }
}

function assertRuntimeRecoveryReceipt(receipt: MutationReceipt): void {
  const pending = receipt.runtimeJournals.filter((entry) => entry.status !== "resolved");
  if (pending.length === 0) {
    throw new Error(`Mutation '${receipt.operationId}' has no pending linked runtime apply journals.`);
  }
  if (!["prepared", "partial", "postcheck-failed", "handler-succeeded", "mutation-applied", "commit-pending"].includes(receipt.status)) {
    throw new Error(`Mutation '${receipt.operationId}' is ${receipt.status}; runtime recovery is not allowed.`);
  }
  if (receipt.revisionMode === "commit-after-verify"
    && (!receipt.provider || !receipt.repositoryRoot || !receipt.expectedHead)) {
    throw new Error(`Mutation '${receipt.operationId}' has no revision provider recovery contract.`);
  }
}

export async function checkMutationProvider(
  workspaceRoot: string,
  globalRoot?: string,
): Promise<Awaited<ReturnType<typeof invokeRevisionProvider>> | undefined> {
  const policy = await mutationPolicyForWorkspace(workspaceRoot, globalRoot);
  if (!policy || policy.revisioning.mode === "off") return undefined;
  const repository = await discoverGitRepository(workspaceRoot);
  if (!repository) throw new Error(`No Git repository contains ${workspaceRoot}.`);
  const operationId = randomUUID();
  const request = revisionProviderRequestSchema.parse({
    protocolVersion: policy.revisioning.provider.protocolVersion,
    action: "check",
    operationId,
    repositoryRoot: repository.root,
    expectedHead: repository.head,
    commandName: "mutation check",
    reason: "Check the configured Agentwheel revision provider",
    noCommit: false,
    paths: [],
  });
  return invokeRevisionProvider(policy.revisioning.provider, request, { workspaceRoot });
}

export async function mutationPolicyForWorkspace(
  workspaceRoot: string,
  globalRoot = homedir(),
): Promise<MutationPolicy | undefined> {
  const scopedConfig = await readWorkspaceConfig(workspaceRoot);
  const scoped = scopedConfig.schemaVersion === 4 ? scopedConfig.mutationPolicy : undefined;
  if (resolve(workspaceRoot) === resolve(globalRoot)) return scoped;
  const globalConfig = await readWorkspaceConfig(globalRoot);
  const global = globalConfig.schemaVersion === 4 ? globalConfig.mutationPolicy : undefined;
  return mergeMutationPolicies(global, scoped);
}

export function mergeMutationPolicies(
  global: MutationPolicy | undefined,
  scoped: MutationPolicy | undefined,
): MutationPolicy | undefined {
  if (!global) return scoped;
  if (!scoped) return global;
  const globalCommit = global.revisioning.mode === "commit-after-verify" ? global.revisioning : undefined;
  const scopedCommit = scoped.revisioning.mode === "commit-after-verify" ? scoped.revisioning : undefined;
  const chosen = scopedCommit ?? globalCommit;
  const revisioning = chosen
    ? {
        ...chosen,
        allowNoCommitOverride: globalCommit && scopedCommit
          ? globalCommit.allowNoCommitOverride && scopedCommit.allowNoCommitOverride
          : chosen.allowNoCommitOverride,
      }
    : { mode: "off" as const };
  return mutationPolicySchema.parse({
    reason: global.reason === "required" || scoped.reason === "required" ? "required" : "optional",
    journal: global.journal === "required" || scoped.journal === "required" || chosen ? "required" : "off",
    revisioning,
  });
}

function providerRequest(receipt: MutationReceipt, action: RevisionProviderRequest["action"], paths: RevisionPath[]): RevisionProviderRequest {
  if (!receipt.repositoryRoot || !receipt.expectedHead || !receipt.provider) {
    throw new Error(`Mutation '${receipt.operationId}' is missing revision provider request state.`);
  }
  return revisionProviderRequestSchema.parse({
    protocolVersion: receipt.provider.protocolVersion,
    action,
    operationId: receipt.operationId,
    repositoryRoot: receipt.repositoryRoot,
    expectedHead: receipt.expectedHead,
    ...(receipt.expectedManifestDigest ? { expectedManifestDigest: receipt.expectedManifestDigest } : {}),
    commandName: receipt.commandName,
    reason: receipt.reason,
    noCommit: receipt.noCommit,
    paths,
  });
}

function normalizeReason(input: string | undefined, commandName: string, policy: MutationPolicy): string {
  const normalized = input?.replace(/\r\n?/gu, "\n").trim();
  if (!normalized && policy.reason === "required") throw new Error(`Mutation reason required: pass --reason <why> for '${commandName}'.`);
  return mutationReasonSchema.parse(normalized || `Run Agentwheel ${commandName}`);
}

function snapshotEntries(snapshot: RepositorySnapshot | undefined): MutationReceipt["preexistingPaths"] {
  if (!snapshot) return [];
  return [...snapshot.changed.entries()]
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function snapshotFromReceipt(receipt: MutationReceipt): RepositorySnapshot {
  return { changed: new Map(receipt.preexistingPaths.map((entry) => [entry.path, entry.sha256])) };
}

function sanitizeError(error: unknown): string {
  const value = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  return (value || "Unknown mutation failure").slice(0, 4096);
}

function receiptStatusForProvider(status: string): MutationReceipt["status"] {
  if (status === "revisioning-skipped") return "revisioning-skipped";
  if (status === "no-repository-delta") return "no-repository-delta";
  return "succeeded";
}

function upsertRuntimeJournal(
  entries: MutationReceipt["runtimeJournals"],
  link: Omit<RuntimeJournalReceipt, "status">,
  status: RuntimeJournalReceipt["status"],
): MutationReceipt["runtimeJournals"] {
  const existing = entries.find((entry) => entry.path === link.path);
  if (existing && (
    existing.transport !== link.transport
    || existing.transportDescription !== link.transportDescription
    || existing.journalDigest !== link.journalDigest
  )) {
    throw new Error(`Runtime journal link collision for ${link.path}.`);
  }
  return [
    ...entries.filter((entry) => entry.path !== link.path),
    { ...link, status },
  ].sort((a, b) => a.path.localeCompare(b.path));
}
