import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { commitManifestMetadataJournal } from "../install/apply.js";
import {
  assertJsonKeyHandoff, assertOwnedJsonKeys, jsonFileHash, jsonKeyClaimsOverlap, jsonKeyLeaves, jsonKeyPathsOverlap,
  parseKeyOwnedConfig, readJsonKey, safeJsonKey, type JsonKeyClaim,
} from "../install/json-key-ownership.js";
import { listInstallManifests, requirePrivateOwnershipMetadata, withManifestRevision, type DiscoveredInstallManifest } from "../install/manifest.js";
import { type MergeValue } from "../install/merge-removal.js";
import { parseOpenClawJsonMergeSource } from "../install/openclaw-json-merge.js";
import { installManifestPath, stateKeyFor } from "../install/paths.js";
import {
  acquireApplyLock, assertNoSymlinkPath, assertOwnershipMetadataTransportSupported, listAllApplyJournals,
  mutationMetadataForApplyJournal, observeOwnershipRuntime, writeApplyJournal, type ApplyJournal,
} from "../install/transaction.js";
import { installManifestV2Schema, type InstallManifestEntry } from "../model/manifest.js";
import { parseWorkspaceOwner, workspaceOwnerForRoot } from "../model/workspace-owner.js";
import { declareMutationPath } from "../mutation/declarations.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import { canonicalJson, entryDigest, exactStateKey, ownershipRunAsEndpoint } from "./ownership-retire-stale.js";

const adapter = "openclaw";
const installationType = "user";
const path = ".openclaw/openclaw.json";
const legacyStrategy = "openclaw-json-deep";

const decisionPathSchema = z.array(z.string().refine(safeJsonKey)).min(1);
const decisionSchema = z.union([
  z.strictObject({ path: decisionPathSchema, disposition: z.enum(["release", "retain-recorded", "adopt-current"]) }),
  z.strictObject({
    path: decisionPathSchema,
    disposition: z.literal("handoff"),
    stateKey: z.string().min(1),
    workspaceOwner: z.string().min(1),
  }),
]);
const decisionsSchema = z.array(decisionSchema).min(1);
type Decision = z.infer<typeof decisionSchema>;

export interface OpenClawRehomeSource {
  artifactType: "settings" | "mcp";
  artifactName: string;
  packageName?: string;
  owners: readonly string[];
  graphNodeId: string;
  logicalSelector: string;
  sourceHash: string;
}

export interface OpenClawKeyMigrationRequest {
  targetRoot: string;
  sourceStateKey: string;
  sourceOwner: string;
  historicalArtifact: string;
  decisions: unknown;
  rehome?: {
    stateKey: string;
    workspaceOwner: string;
    agentName: string;
    artifactFile: string;
    graphDigest: string;
    configuredArtifacts: readonly OpenClawRehomeSource[];
  };
  transport?: TargetTransport;
}

export async function planOpenClawKeyMigration(request: OpenClawKeyMigrationRequest) {
  return (await observe(request)).plan;
}

export async function applyOpenClawKeyMigration(request: OpenClawKeyMigrationRequest, reviewedDigest: string) {
  if (!/^[a-f0-9]{64}$/u.test(reviewedDigest)) throw new Error("Apply requires the exact reviewed plan digest.");
  const transport = request.transport ?? localTransport;
  const targetRoot = resolve(request.targetRoot);
  const stateKey = exactStateKey(adapter, request.sourceStateKey, installationType, "source");
  assertOwnershipMetadataTransportSupported(transport);
  if (transport.kind === "local") await assertNoSymlinkPath(join(targetRoot, ".agentwheel"));
  await requirePrivateOwnershipMetadata(transport, targetRoot);
  const lock = await acquireApplyLock(targetRoot, adapter, transport, {}, { installationType, stateKey });
  try {
    const { plan, source, entry, claims, releasedPaths, handoffs, inventory } = await observe(request);
    if (plan.planDigest !== reviewedDigest) throw new Error("OpenClaw migration plan changed; review a new plan.");
    const mutation = mutationMetadataForApplyJournal();
    const now = new Date().toISOString();
    const after = withManifestRevision({
      ...source, targetRoot, stateKey,
      generatedAt: now,
      entries: source.entries.map((item) => item !== entry ? item : {
        ...entry,
        mergeStrategy: "openclaw-json-keys",
        mergeRemoval: undefined,
        mergeCreatedDestination: undefined,
        ...(plan.rehome ? { workspaceOwner: plan.rehome.workspaceOwner, sourceHash: plan.rehome.sourceHash } : {}),
        keyOwnership: claims,
        keyMigration: {
          legacyEntryDigest: plan.legacyEntryDigest, historicalSourceHash: plan.sourceHash,
          planDigest: reviewedDigest,
          legacyRemoval: entry.mergeRemoval,
          releasedPaths, handoffs,
          ...(plan.rehome ? {
            rehome: {
              previousWorkspaceOwner: plan.sourceOwner,
              workspaceOwner: plan.rehome.workspaceOwner,
              agentName: plan.rehome.agentName,
              sourceHash: plan.rehome.sourceHash,
              graphDigest: plan.rehome.graphDigest,
              graphNodeId: plan.rehome.graphNodeId,
              logicalSelector: plan.rehome.logicalSelector,
            },
          } : {}),
        },
      }),
    });
    declareMutationPath(installManifestPath(targetRoot, adapter, { installationType, stateKey }));
    const journal: ApplyJournal = {
      version: mutation ? 2 : 1,
      ...(mutation ? { mutation } : {}),
      mode: "uninstall", adapter, installationType, stateKey, targetRoot,
      baseRevision: source.revision, createdAt: now, updatedAt: now, operations: [], completed: [],
      manifest: after,
      metadataGuards: {
        inventory: revisions(inventory),
        runtime: [{ path, hash: plan.runtimeHash, snapshotDigest: plan.runtimeSnapshotDigest }],
      },
    };
    await writeApplyJournal(journal, transport);
    await commitManifestMetadataJournal(journal, transport);
    return { ...plan, applied: true, manifestRevisionAfter: after.revision };
  } finally {
    await lock.release();
  }
}

async function observe(request: OpenClawKeyMigrationRequest) {
  const transport = request.transport ?? localTransport;
  const targetRoot = resolve(request.targetRoot);
  const endpoint = ownershipRunAsEndpoint(transport, targetRoot);
  if (transport.kind !== "local" && !endpoint) throw new Error("OpenClaw key migration requires local or local-run-as transport.");
  const stateKey = exactStateKey(adapter, request.sourceStateKey, installationType, "source");
  const destPath = join(targetRoot, path);
  if (transport.kind === "local") {
    await assertNoSymlinkPath(destPath);
    await assertNoSymlinkPath(join(targetRoot, ".agentwheel"));
  }
  await assertNoPending(targetRoot, transport);
  const inventory = await listInstallManifests(targetRoot, undefined, transport);
  if (transport.kind === "local") for (const item of inventory) await assertNoSymlinkPath(item.path);
  const source = inventory.find((item) => item.stateKey === stateKey)?.manifest;
  if (!source || source.version !== 2 || source.adapter !== adapter || source.installationType !== installationType
    || resolve(source.targetRoot) !== targetRoot || stateKeyFor(adapter, source) !== stateKey || source.adapterCode) {
    throw new Error("Migration source is not an exact OpenClaw user install state.");
  }
  const entries = source.entries.filter((entry) => entry.path === path);
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.workspaceOwner !== request.sourceOwner
    || !parseWorkspaceOwner(entry.workspaceOwner) || entry.kind !== "file"
    || (entry.artifactType !== "settings" && entry.artifactType !== "mcp") || entry.mergeStrategy !== legacyStrategy
    || entry.mergeCreatedDestination || entry.mode || entry.semanticCommand || entry.semanticPlugin || entry.executed) {
    throw new Error("Migration requires a single named legacy fragment claim, without whole-file deletion rights.");
  }
  await assertNoSymlinkPath(request.historicalArtifact);
  if (!(await lstat(request.historicalArtifact)).isFile()) throw new Error("Historical artifact must be a regular file.");
  const historical = await readFile(request.historicalArtifact, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(entry.sourceHash) || jsonFileHash(historical) !== entry.sourceHash) {
    throw new Error("Historical artifact bytes do not match the legacy manifest source hash.");
  }
  const footprint = jsonKeyLeaves(parseOpenClawJsonMergeSource(historical));
  const recorded = entry.mergeRemoval && Object.keys(entry.mergeRemoval).length ? jsonKeyLeaves(entry.mergeRemoval) : [];
  const known = new Map(footprint.map((claim) => [canonicalJson(claim.path), claim]));
  // A legacy delta can contain older retained additions. They also require a decision.
  for (const claim of recorded) if (!known.has(canonicalJson(claim.path))) known.set(canonicalJson(claim.path), claim);
  const decisions = decisionsSchema.parse(request.decisions).sort((a, b) => canonicalJson(a.path).localeCompare(canonicalJson(b.path)));
  if (decisions.length !== known.size || new Set(decisions.map((decision) => canonicalJson(decision.path))).size !== known.size
    || decisions.some((decision) => !known.has(canonicalJson(decision.path)))) {
    throw new Error("Each key in the historical source or recorded delta needs exactly one explicit migration decision.");
  }
  if (decisions.some((decision, index) => decisions.slice(0, index).some((previous) => jsonKeyPathsOverlap(previous.path, decision.path)))) {
    throw new Error("Legacy source and recorded delta disagree about a key boundary.");
  }
  const beforeRuntime = await observeOwnershipRuntime(destPath, transport);
  if (beforeRuntime.kind !== "file") throw new Error("OpenClaw configuration must be a regular file.");
  const content = await transport.readFile(destPath);
  const config = parseKeyOwnedConfig(content);
  const claims: JsonKeyClaim[] = [];
  const releasedPaths: string[][] = [];
  const handoffs: Array<{ path: string[]; stateKey: string; workspaceOwner: string }> = [];
  const delta = new Map(recorded.map((item) => [canonicalJson(item.path), item]));
  for (const decision of decisions) {
    if (decision.disposition === "release" || decision.disposition === "handoff") {
      if (decision.disposition === "handoff") {
        const recipient = exactStateKey(adapter, decision.stateKey, installationType, "recipient");
        if (recipient === stateKey || !parseWorkspaceOwner(decision.workspaceOwner)) {
          throw new Error("OpenClaw handoff requires a different, named recipient install state.");
        }
        handoffs.push({ path: decision.path, stateKey: recipient, workspaceOwner: decision.workspaceOwner });
      }
      releasedPaths.push(decision.path);
      continue;
    }
    const value = readJsonKey(config, decision.path);
    if (value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value))) {
      throw new Error("A retained or adopted key needs an existing atomic runtime value.");
    }
    const old = delta.get(canonicalJson(decision.path));
    const previous = decision.disposition === "retain-recorded"
      ? previousFromLegacyDelta(old?.value, value, decision)
      : value;
    claims.push({ path: decision.path, value, ...(previous === undefined ? {} : { previous }), createdParents: [] });
  }
  assertOwnedJsonKeys(content, claims);
  const rehome = await qualifyRehome(request.rehome, entry, stateKey, targetRoot, claims);
  for (const other of inventory) for (const peer of other.manifest.entries) {
    if (other.stateKey === stateKey || peer.path !== path) continue;
    assertJsonKeyHandoff(claims, peer.keyMigration, stateKey, rehome?.workspaceOwner ?? entry.workspaceOwner);
    for (const handoff of handoffs) {
      if (peer.keyOwnership?.some((claim) => jsonKeyPathsOverlap(claim.path, handoff.path)
        && (!isDeepStrictEqual(claim.path, handoff.path) || other.stateKey !== handoff.stateKey
          || !("workspaceOwner" in peer) || peer.workspaceOwner !== handoff.workspaceOwner))) {
        throw new Error("Migration would reserve a key already claimed by another OpenClaw install state.");
      }
    }
    if (handoffs.some((handoff) => peer.keyMigration?.handoffs?.some((otherHandoff) =>
      jsonKeyPathsOverlap(otherHandoff.path, handoff.path)))) {
      throw new Error("Migration overlaps an existing OpenClaw key handoff.");
    }
    if (peer.keyOwnership?.some((claim) => claims.some((adopted) => jsonKeyClaimsOverlap(claim, adopted)))) {
      throw new Error("Migration would overlap an existing OpenClaw key claim.");
    }
  }
  // Validate the projected entry before presenting it for review.
  installManifestV2Schema.parse({ ...source, entries: [{
    ...entry, mergeStrategy: "openclaw-json-keys", mergeRemoval: undefined, mergeCreatedDestination: undefined,
    ...(rehome ? { workspaceOwner: rehome.workspaceOwner, sourceHash: rehome.sourceHash } : {}),
    keyOwnership: claims,
    keyMigration: { legacyEntryDigest: entryDigest(entry), historicalSourceHash: entry.sourceHash, planDigest: "0".repeat(64), releasedPaths, handoffs },
  }] });
  const runtimeHash = jsonFileHash(content);
  const afterRuntime = await observeOwnershipRuntime(destPath, transport);
  if (afterRuntime.snapshotDigest !== beforeRuntime.snapshotDigest || await transport.hashPath(destPath) !== runtimeHash
    || digest(revisions(await listInstallManifests(targetRoot, undefined, transport))) !== digest(revisions(inventory))) {
    throw new Error("OpenClaw config or ownership inventory changed during migration planning.");
  }
  await assertNoPending(targetRoot, transport);
  const plan = {
    targetRoot, adapter, installationType, stateKey, sourceOwner: entry.workspaceOwner, sourceHash: entry.sourceHash,
    ...(endpoint ? { transport: endpoint } : {}),
    manifestRevision: source.revision, legacyEntryDigest: entryDigest(entry),
    inventoryDigest: digest(revisions(inventory)), runtimeHash, runtimeSnapshotDigest: beforeRuntime.snapshotDigest,
    originalDelta: entry.mergeRemoval === undefined ? "missing" : recorded.length ? "recorded" : "empty",
    decisions,
    claimDigest: digest(claims),
    ...(rehome ? { rehome } : {}),
  };
  return { plan: { ...plan, planDigest: digest(plan) }, source, entry, claims, releasedPaths, handoffs, inventory };
}

async function qualifyRehome(
  request: OpenClawKeyMigrationRequest["rehome"], entry: InstallManifestEntry, stateKey: string, targetRoot: string,
  claims: JsonKeyClaim[],
) {
  if (!request) return undefined;
  const owner = parseWorkspaceOwner(request.workspaceOwner);
  if (!owner || workspaceOwnerForRoot(owner.root, owner.fleetId) !== request.workspaceOwner
    || request.workspaceOwner === entry.workspaceOwner || !request.agentName.trim() || request.stateKey !== stateKey
    || !claims.length || !/^[a-f0-9]{64}$/u.test(request.graphDigest)) {
    throw new Error("Rehome requires a different named workspace with the same exact state and a keyed artifact mapping.");
  }
  const [configured] = request.configuredArtifacts;
  if (request.configuredArtifacts.length !== 1 || !configured || configured.artifactType !== entry.artifactType
    || configured.artifactName !== entry.artifactName || !configured.graphNodeId || !configured.logicalSelector
    || (!entry.packageName ? configured.packageName !== undefined
      : configured.packageName !== entry.packageName && !configured.owners.includes(entry.packageName))) {
    throw new Error("Rehome requires exactly the same artifact identity in the configured source graph.");
  }
  const artifactPath = resolve(request.artifactFile);
  const sourcePath = relative(owner.root, artifactPath);
  const fromTarget = relative(targetRoot, owner.root);
  if (!isAbsolute(request.artifactFile) || !sourcePath || isAbsolute(sourcePath)
    || sourcePath === ".." || sourcePath.startsWith("../")
    || (fromTarget !== ".." && !fromTarget.startsWith("../") && !isAbsolute(fromTarget))
    || basename(artifactPath) !== entry.artifactName) {
    throw new Error("Rehome requires the same artifact name in the destination workspace, outside the runtime root.");
  }
  await assertNoSymlinkPath(artifactPath);
  if (!(await lstat(artifactPath)).isFile()) throw new Error("Rehome artifact must be a regular file.");
  const bytes = await readFile(artifactPath, "utf8");
  const sourceHash = jsonFileHash(bytes);
  if (sourceHash !== configured.sourceHash) {
    throw new Error("Rehome artifact bytes must match the configured source graph.");
  }
  const fragment = parseOpenClawJsonMergeSource(bytes);
  // The first keyed update must see these same values without consulting an environment.
  if (JSON.stringify(fragment).includes("${")) throw new Error("Rehome requires a literal fragment without environment placeholders.");
  const leaves = jsonKeyLeaves(fragment);
  if (leaves.length !== claims.length || leaves.some(({ path, value }) => !claims.some((claim) =>
    isDeepStrictEqual(claim.path, path) && isDeepStrictEqual(claim.value, value)))) {
    throw new Error("Rehome artifact must declare exactly the retained keys and current values.");
  }
  return {
    workspaceOwner: request.workspaceOwner, stateKey, agentName: request.agentName, sourcePath,
    artifactName: entry.artifactName, artifactType: entry.artifactType, packageName: entry.packageName,
    sourceHash, graphDigest: request.graphDigest, graphNodeId: configured.graphNodeId, logicalSelector: configured.logicalSelector,
  };
}

function previousFromLegacyDelta(recorded: MergeValue | undefined, value: MergeValue, decision: Decision): MergeValue | undefined {
  if (recorded === undefined) throw new Error("Legacy rollback needs a recorded delta; use an explicit current-value adoption or release.");
  if (Array.isArray(recorded)) {
    // These paths used replacement/keyed array behavior, which did not record a recoverable preimage.
    const key = decision.path.join(".");
    if (key === "agents.list" || key === "plugins.entries.agentwheel-skill-router.config.repositories"
      || (decision.path.length === 5 && decision.path[0] === "mcp" && decision.path[1] === "servers"
        && decision.path[3] === "codex" && decision.path[4] === "agents")) {
      throw new Error("Legacy replacement-array rollback is unproven; use an explicit current-value adoption or release.");
    }
    if (!Array.isArray(value) || !recorded.length || recorded.some((item) => !value.some((candidate) => isDeepStrictEqual(item, candidate)))) {
      throw new Error("Recorded legacy array additions no longer match runtime.");
    }
    const remaining = value.filter((item) => !recorded.some((candidate) => isDeepStrictEqual(item, candidate)));
    return remaining.length ? remaining : undefined;
  }
  if (!isDeepStrictEqual(recorded, value)) throw new Error("Recorded legacy value no longer matches runtime.");
  return undefined;
}

function revisions(inventory: DiscoveredInstallManifest[]) {
  return inventory.map((item) => ({ stateKey: item.stateKey, revision: item.manifest.revision }));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function assertNoPending(targetRoot: string, transport: TargetTransport): Promise<void> {
  const journals = await listAllApplyJournals(targetRoot, undefined, transport);
  if (journals.length) throw new Error("Recover pending runtime journals before migrating OpenClaw ownership.");
}
