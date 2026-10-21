import { assertCallerRunAsWritePath } from "../transport/caller-write-trust.js";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { commitManifestMetadataJournal } from "../install/apply.js";
import { computeInstallManifestInventoryRevision, listInstallManifests, readInstallManifest } from "../install/manifest.js";
import { installManifestPath, stateKeyFor } from "../install/paths.js";
import {
  acquireApplyLock, assertOwnershipMetadataTransportSupported, assertNoSymlinkPath, listAllApplyJournals, metadataRuntimePath,
  mutationMetadataForApplyJournal, observeOwnershipRuntime, writeApplyJournal,
  type ApplyJournal,
} from "../install/transaction.js";
import { workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { activeMutationMetadata, GovernedMutation } from "../mutation/coordinator.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { mutationOperationIdSchema, mutationReasonSchema } from "../mutation/protocol.js";
import { discoverGitRepository } from "../mutation/repository.js";
import { runProcess } from "../mutation/process.js";
import { ownershipRunAsEndpoint } from "./ownership-retire-stale.js";
import { localTransport, type TargetTransport } from "../transport/index.js";

export interface ReleaseOwnershipRequest {
  workspaceRoot: string;
  fromWorkspaceRoot: string;
  fromFleetId?: string;
  targetRoot: string;
  adapter: string;
  installationType: string;
  stateKey: string;
  selector: string;
  path: string;
  reason: string;
  planDigest?: string;
  expectedSourceRevision?: string;
  expectedInventoryRevision?: string;
  operationId?: string;
  noCommit?: boolean;
  globalRoot?: string;
  transport?: TargetTransport;
}

export type ReleaseOwnershipPlan = Awaited<ReturnType<typeof observe>>;

/** Pure observation: this releases a claim; it makes no assertion about historical provenance. */
export async function planReleaseOwnership(request: ReleaseOwnershipRequest): Promise<ReleaseOwnershipPlan> {
  return observe(request);
}

export async function applyReleaseOwnership(request: ReleaseOwnershipRequest) {
  for (const [name, value] of Object.entries({
    planDigest: request.planDigest,
    expectedSourceRevision: request.expectedSourceRevision,
    expectedInventoryRevision: request.expectedInventoryRevision,
  })) {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Reviewed SHA-256 ${name} is required to release a claim.`);
  }
  const workspaceRoot = resolve(request.workspaceRoot);
  const existing = activeMutationMetadata();
  if (existing && (resolve(existing.workspaceRoot) !== workspaceRoot
    || existing.reason !== request.reason.replace(/\r\n?/gu, "\n").trim()
    || (request.operationId && request.operationId !== existing.operationId))) {
    throw new Error("Ownership release does not match the active governed workspace, reason or operation.");
  }
  const operationId = mutationOperationIdSchema.parse(existing?.operationId ?? request.operationId ?? randomUUID());
  const auditPath = join(workspaceRoot, ".agentwheel", "ownership-releases", `${operationId}.json`);
  // APIs as well as the CLI honor the effective provider precheck before runtime metadata writes.
  const mutation = existing ? undefined : await GovernedMutation.begin({
    workspaceRoot,
    commandName: "agentwheel ownership release-claim",
    reason: request.reason,
    operationId,
    noCommit: request.noCommit,
    globalRoot: request.globalRoot,
    anticipatedPaths: [auditPath],
  });
  try {
    if ((existing ?? mutation?.metadata())?.revisionMode === "commit-after-verify") {
      const repository = await discoverGitRepository(workspaceRoot);
      if (!repository) throw new Error("Ownership release requires a declarative Git audit path.");
      const ignored = await runProcess("git", ["-C", repository.root, "check-ignore", "--no-index", "--", auditPath], { allowExitCodes: [0, 1] });
      if (ignored.exitCode === 0) {
        throw new Error("Ownership release audit path is Git-ignored; explicitly declare it in repository policy before releasing a claim.");
      }
    }
    const result = await applyLocked(request, operationId, auditPath);
    await mutation?.complete();
    return result;
  } catch (error) {
    await mutation?.fail(error);
    throw error;
  }
}

async function applyLocked(request: ReleaseOwnershipRequest, operationId: string, auditPath: string) {
  const transport = request.transport ?? localTransport;
  assertOwnershipMetadataTransportSupported(transport);
  if (transport.kind === "local-run-as") await assertCallerRunAsWritePath(auditPath, [transport.runAsIdentity!]);
  if (transport.kind === "local") await assertNoSymlinkPath(join(resolve(request.targetRoot), ".agentwheel"));
  else await transport.pathExists(join(resolve(request.targetRoot), ".agentwheel"));
  await assertNoSymlinkPath(auditPath);
  const lock = await acquireApplyLock(resolve(request.targetRoot), request.adapter, transport, {}, {
    installationType: request.installationType, stateKey: request.stateKey,
  });
  try {
    if ((await listAllApplyJournals(request.targetRoot, undefined, transport)).length) {
      throw new Error("Ownership release refuses pending runtime journals; recover them first.");
    }
    const plan = await observe(request);
    if (plan.planDigest !== request.planDigest || plan.source.revision !== request.expectedSourceRevision
      || plan.manifestInventoryRevision !== request.expectedInventoryRevision) {
      throw new Error("Stale ownership release plan, manifest or inventory; replan required.");
    }
    if (await localTransport.pathExists(auditPath)) throw new Error(`Ownership release audit already exists: ${auditPath}`);
    declareMutationPath(auditPath);
    declareMutationPath(plan.source.manifestPath);
    const manifest = await readInstallManifest(plan.targetRoot, plan.adapter, transport, {
      installationType: plan.installationType, stateKey: plan.source.stateKey,
    });
    if (!manifest || manifest.version !== 2 || manifest.revision !== plan.source.revision) {
      throw new Error("Source manifest changed after selection; replan required.");
    }
    const now = new Date().toISOString();
    const content = `${JSON.stringify({
      schemaVersion: 1,
      event: "ownership-release-intent",
      operationId,
      reason: plan.reason,
      reviewedPlanDigest: plan.planDigest,
      plan,
      // This immutable dossier records intent. The linked journal verifies completion separately.
      completion: "Verify install state and the governed mutation receipt; intent alone does not prove completion.",
    }, null, 2)}\n`;
    const metadata = mutationMetadataForApplyJournal();
    const journal: ApplyJournal = {
      version: metadata ? 2 : 1,
      ...(metadata ? { mutation: metadata } : {}),
      mode: "uninstall",
      adapter: plan.adapter,
      installationType: plan.installationType,
      stateKey: plan.source.stateKey,
      targetRoot: plan.targetRoot,
      baseRevision: manifest.revision,
      createdAt: now, updatedAt: now,
      operations: [], completed: [],
      manifest: { ...manifest, entries: manifest.entries.filter((entry) => digest(entry) !== plan.source.entryDigest) },
      metadataAudit: {
        kind: "ownership-release",
        workspaceRoot: plan.workspaceRoot,
        operationId,
        planDigest: plan.planDigest,
        inventory: plan.inventory,
        runtime: [{ path: plan.path, hash: plan.runtimeHash, snapshotDigest: plan.runtimeSnapshotDigest }],
        auditFiles: [{ path: `.agentwheel/ownership-releases/${operationId}.json`, content, sha256: hash(content) }],
      },
    };
    // All subsequent writes are replayable through this native linked journal.
    await writeApplyJournal(journal, transport);
    await commitManifestMetadataJournal(journal, transport);
    return { ...plan, applied: true as const, operationId, auditPath, retainedEntries: journal.manifest.entries.length };
  } finally {
    await lock.release();
  }
}

async function observe(request: ReleaseOwnershipRequest) {
  const transport = request.transport ?? localTransport;
  if (transport.kind === "ssh") throw new Error("Ownership release does not support SSH targets.");
  const endpoint = ownershipRunAsEndpoint(transport, request.targetRoot);
  const targetRoot = resolve(request.targetRoot);
  const workspaceRoot = resolve(request.workspaceRoot);
  const reason = mutationReasonSchema.parse(request.reason.trim());
  if (!request.stateKey || stateKeyFor(request.adapter, { stateKey: request.stateKey }) !== request.stateKey
    || !request.installationType.trim() || !request.selector.includes("/")) {
    throw new Error("Ownership release requires an exact state key, installation type and type/name selector.");
  }
  const runtimePath = metadataRuntimePath(targetRoot, request.path);
  await assertNoSymlinkPath(workspaceRoot);
  if (transport.kind === "local") await assertNoSymlinkPath(join(targetRoot, ".agentwheel"));
  else await transport.pathExists(join(targetRoot, ".agentwheel"));
  const manifests = await listInstallManifests(targetRoot, undefined, transport);
  if (transport.kind === "local") for (const item of manifests) await assertNoSymlinkPath(item.path);
  const source = manifests.find((item) => item.stateKey === request.stateKey);
  const manifest = source?.manifest;
  if (!manifest || manifest.version !== 2 || manifest.adapter !== request.adapter
    || manifest.targetRoot !== targetRoot || manifest.installationType !== request.installationType
    || stateKeyFor(manifest.adapter, { stateKey: manifest.stateKey, installationType: manifest.installationType }) !== request.stateKey) {
    throw new Error("Source manifest does not prove the requested target, adapter, installation type and state key.");
  }
  const matches = manifest.entries.filter((entry) => entry.path === request.path
    && `${entry.artifactType}/${entry.artifactName}` === request.selector);
  if (matches.length !== 1) throw new Error(`Expected exactly one ownership claim at ${request.path} for ${request.selector}.`);
  const entry = matches[0]!;
  const owner = workspaceOwnerForRoot(request.fromWorkspaceRoot, request.fromFleetId);
  if (entry.workspaceOwner !== owner) throw new Error(`Workspace owner does not match the selected claim at ${entry.path}.`);
  if (entry.mergeStrategy || entry.mode || entry.semanticPlugin || entry.semanticCommand || entry.executed
    || entry.channel === "ejected") {
    throw new Error("Ownership release only supports plain file/directory claims; shared or semantic contributions are protected.");
  }
  for (const item of manifests) {
    for (const other of item.manifest.entries) {
      if (item === source && other === entry) continue;
      const otherPath = metadataRuntimePath(targetRoot, other.path);
      if (otherPath === runtimePath || otherPath.startsWith(`${runtimePath}/`) || runtimePath.startsWith(`${otherPath}/`)) {
        throw new Error(`Ambiguous or overlapping ownership claim at ${entry.path} in ${item.stateKey}.`);
      }
    }
  }
  const { snapshotDigest, kind: runtimeKind } = await observeOwnershipRuntime(runtimePath, transport);
  if (runtimeKind !== entry.kind) throw new Error("Selected runtime kind does not match the manifest claim.");
  const runtimeHash = await transport.hashPath(runtimePath);
  const inventory = manifests.map((item) => ({ stateKey: item.stateKey, revision: item.manifest.revision }));
  const plan = {
    ...(endpoint ? { transport: endpoint } : {}),
    adapter: request.adapter,
    installationType: request.installationType,
    targetRoot, workspaceRoot, owner,
    selector: request.selector, path: entry.path,
    source: {
      stateKey: request.stateKey,
      manifestPath: installManifestPath(targetRoot, request.adapter, { installationType: request.installationType, stateKey: request.stateKey }),
      revision: manifest.revision,
      entryDigest: digest(entry),
      entry,
    },
    recordedHash: entry.hash,
    runtimeHash,
    runtimeSnapshotDigest: snapshotDigest,
    manifestInventoryRevision: await computeInstallManifestInventoryRevision(targetRoot, undefined, transport),
    inventory,
    reason,
  };
  return { ...plan, planDigest: digest(plan) };
}

function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function digest(value: unknown): string { return hash(canonicalJson(value)); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
