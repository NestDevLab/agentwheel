import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { commitManifestMetadataJournal } from "../install/apply.js";
import { listInstallManifests, readInstallManifest } from "../install/manifest.js";
import { installManifestPath } from "../install/paths.js";
import {
  acquireApplyLock, assertGovernedRuntimeTransportSupported, assertNoSymlinkPath,
  listAllApplyJournals, metadataRuntimePath, mutationMetadataForApplyJournal,
  ownershipRuntimeSnapshot, writeApplyJournal, type ApplyJournal,
} from "../install/transaction.js";
import { activeMutationMetadata, GovernedMutation } from "../mutation/coordinator.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { mutationOperationIdSchema } from "../mutation/protocol.js";
import { runProcess } from "../mutation/process.js";
import { discoverGitRepository } from "../mutation/repository.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import type { OwnershipHandoffPlan, OwnershipHandoffRequest } from "./ownership.js";

/** Reuse the release-claim metadata transaction: intent first, then exact manifest CAS, no runtime writes. */
export async function applyAuditedOwnershipHandoff(
  request: OwnershipHandoffRequest,
  observe: (request: OwnershipHandoffRequest, transport: TargetTransport) => Promise<OwnershipHandoffPlan>,
): Promise<OwnershipHandoffPlan> {
  const existing = activeMutationMetadata();
  const workspaceRoot = resolve(request.workspaceRoot ?? existing!.workspaceRoot);
  if (existing && (resolve(existing.workspaceRoot) !== workspaceRoot
    || (request.reason !== undefined && existing.reason !== request.reason.replace(/\r\n?/gu, "\n").trim())
    || (request.operationId && request.operationId !== existing.operationId))) {
    throw new Error("Ownership handoff does not match the active governed workspace, reason or operation.");
  }
  const operationId = mutationOperationIdSchema.parse(existing?.operationId ?? request.operationId ?? randomUUID());
  const auditPath = join(workspaceRoot, ".agentwheel", "ownership-handoffs", `${operationId}.json`);
  const mutation = existing ? undefined : await GovernedMutation.begin({
    workspaceRoot, commandName: "agentwheel ownership handoff", reason: request.reason,
    operationId, noCommit: request.noCommit, globalRoot: request.globalRoot, anticipatedPaths: [auditPath],
  });
  try {
    const transport = request.transport ?? localTransport;
    assertGovernedRuntimeTransportSupported(transport);
    // The durable audit is a local repository product. Remote handoffs retain their existing guards.
    if (transport.kind !== "local") throw new Error("Audited ownership handoff supports local targets only.");
    await assertNoSymlinkPath(workspaceRoot);
    await assertNoSymlinkPath(auditPath);
    if ((existing ?? mutation?.metadata())?.revisionMode === "commit-after-verify") {
      const repository = await discoverGitRepository(workspaceRoot);
      if (!repository) throw new Error("Ownership handoff requires a declarative Git audit path.");
      const ignored = await runProcess("git", ["-C", repository.root, "check-ignore", "--no-index", "--", auditPath], { allowExitCodes: [0, 1] });
      if (ignored.exitCode === 0) throw new Error("Ownership handoff audit path is Git-ignored; declare it before handing off ownership.");
    }
    const scope = { installationType: request.installationType, stateKey: request.stateKey };
    await assertNoSymlinkPath(join(request.targetRoot, ".agentwheel"));
    const lock = await acquireApplyLock(request.targetRoot, request.adapter, transport, {}, scope);
    try {
      if ((await listAllApplyJournals(request.targetRoot, undefined, transport)).length) {
        throw new Error("Cannot hand off ownership while an apply journal is pending. Recover the same operation first.");
      }
      if (await transport.pathExists(auditPath)) throw new Error("Ownership handoff intent already exists; recover the same operation instead of applying again.");
      // All original target, owner, exact contribution, hash and revision checks run while locked.
      const plan = await observe(request, transport);
      if (plan.drifted && !request.expectedRuntimeHash) {
        throw new Error("Applying a drifted ownership handoff requires expectedRuntimeHash from a reviewed dry-run.");
      }
      const manifest = await readInstallManifest(request.targetRoot, request.adapter, transport, scope);
      if (!manifest || manifest.version !== 2 || manifest.revision !== plan.manifestRevision) {
        throw new Error("Ownership handoff manifest changed while locked; replan required.");
      }
      const inventory = await listInstallManifests(request.targetRoot, undefined, transport);
      for (const item of inventory) await assertNoSymlinkPath(item.path);
      const runtimePath = metadataRuntimePath(request.targetRoot, plan.path);
      // The full merged file is guarded privately; only hashes enter the public audit.
      const runtime = [{ path: plan.path, hash: await transport.hashPath(runtimePath), snapshotDigest: await ownershipRuntimeSnapshot(runtimePath) }];
      const reason = existing?.reason ?? mutation?.metadata().reason ?? request.reason ?? "Ownership handoff";
      const intent = { schemaVersion: 1, event: "ownership-handoff-intent", operationId, reason,
        // Explicit whitelist: never serialize manifest entries, mergeRemoval or runtime/config values.
        plan: { adapter: plan.adapter, installationType: manifest.installationType, stateKey: manifest.stateKey,
          targetRoot: plan.targetRoot, selector: plan.selector, path: plan.path,
          artifactHash: plan.artifactHash, runtimeHash: plan.runtimeHash, drifted: plan.drifted,
          manifestRevision: plan.manifestRevision, fromOwner: plan.fromOwner, toOwner: plan.toOwner },
        completion: "Verify the linked runtime journal and mutation receipt; intent alone is not completion.",
      };
      const content = `${JSON.stringify(intent, null, 2)}\n`;
      const sha256 = createHash("sha256").update(content).digest("hex");
      declareMutationPath(auditPath);
      declareMutationPath(installManifestPath(request.targetRoot, request.adapter, scope));
      const metadata = mutationMetadataForApplyJournal();
      const now = new Date().toISOString();
      const journal: ApplyJournal = {
        version: metadata ? 2 : 1, ...(metadata ? { mutation: metadata } : {}), mode: "uninstall",
        adapter: manifest.adapter, installationType: manifest.installationType, stateKey: manifest.stateKey,
        targetRoot: manifest.targetRoot, baseRevision: manifest.revision, createdAt: now, updatedAt: now,
        operations: [], completed: [],
        manifest: { ...manifest, entries: manifest.entries.map((entry) =>
          entry.artifactType === request.artifactType && entry.artifactName === request.artifactName
            ? { ...entry, workspaceOwner: plan.toOwner } : entry) },
        metadataAudit: { kind: "ownership-handoff", workspaceRoot, operationId, planDigest: sha256,
          inventory: inventory.map((item) => ({ stateKey: item.stateKey, revision: item.manifest.revision })), runtime,
          auditFiles: [{ path: `.agentwheel/ownership-handoffs/${operationId}.json`, content, sha256 }] },
      };
      if (JSON.stringify(await observe(request, transport)) !== JSON.stringify(plan)) {
        throw new Error("Ownership handoff preconditions changed before journaling; replan required.");
      }
      await writeApplyJournal(journal, transport);
      await commitManifestMetadataJournal(journal, transport);
      await mutation?.complete();
      return plan;
    } finally { await lock.release(); }
  } catch (error) {
    await mutation?.fail(error);
    throw error;
  }
}
