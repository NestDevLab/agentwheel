import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { listInstallManifests } from "../install/manifest.js";
import { assertExactMergeContribution, type MergeRemoval, type MergeValue } from "../install/merge-removal.js";
import { assertNoSymlinkPath, listAllApplyJournals, observeOwnershipRuntime } from "../install/transaction.js";
import { localTransport, type TargetTransport } from "../transport/index.js";
import { canonicalJson, exactStateKey, ownershipRunAsEndpoint } from "./ownership-retire-stale.js";

const configPath = ".openclaw/openclaw.json";
const strategy = "openclaw-json-deep";
const topicKeys = ["skills", "systemPrompt"] as const;

export interface OpenClawTopicOwnershipRequest {
  targetRoot: string;
  installationType: string;
  sourceStateKey: string;
  sourceOwner: string;
  chatId: string;
  topicId: string;
  transport?: TargetTransport;
}

export async function inspectOpenClawTopicOwnership(request: OpenClawTopicOwnershipRequest) {
  const { installationType, sourceOwner, chatId, topicId } = request;
  const targetRoot = resolve(request.targetRoot);
  const transport = request.transport ?? localTransport;
  const endpoint = ownershipRunAsEndpoint(transport, targetRoot);
  if (transport.kind !== "local" && !endpoint) throw new Error("Topic ownership inspection requires local or local-run-as transport.");
  const sourceStateKey = exactStateKey("openclaw", request.sourceStateKey, installationType, "source");
  if (!/^-100[0-9]+$/u.test(chatId) || !/^[1-9][0-9]*$/u.test(topicId)) {
    throw new Error("An exact Telegram group ID and positive topic ID are required.");
  }
  const path = join(targetRoot, configPath);
  if (transport.kind === "local") {
    await assertNoSymlinkPath(path);
    await assertNoSymlinkPath(join(targetRoot, ".agentwheel"));
  }
  const inventory = await listInstallManifests(targetRoot, undefined, transport);
  if (transport.kind === "local") for (const item of inventory) await assertNoSymlinkPath(item.path);
  const journals = await listAllApplyJournals(targetRoot, undefined, transport);
  if (journals.length) throw new Error("Resolve pending runtime journals before inspecting a topic transfer.");
  const source = inventory.find((item) => item.stateKey === sourceStateKey);
  if (!source || source.manifest.version !== 2 || source.manifest.adapter !== "openclaw"
    || source.manifest.installationType !== installationType || resolve(source.manifest.targetRoot) !== targetRoot) {
    throw new Error("The source state does not identify the requested OpenClaw target.");
  }
  const sourceEntries = source.manifest.entries.filter((entry) => entry.path === configPath);
  const entry = sourceEntries[0];
  if (sourceEntries.length !== 1 || entry.workspaceOwner !== sourceOwner
    || entry.artifactType !== "settings" || entry.kind !== "file" || entry.mergeStrategy !== strategy
    || entry.mergeCreatedDestination || entry.mode || entry.semanticPlugin || entry.semanticCommand) {
    throw new Error("The source must identify one exact OpenClaw settings contribution.");
  }
  const content = await transport.readFile(path);
  const observation = await observeOwnershipRuntime(path, transport);
  if (observation.kind !== "file") throw new Error("OpenClaw configuration must be a regular file.");
  const keys = ["channels", "telegram", "groups", chatId, "topics", topicId];
  const original = entry.mergeRemoval;
  const topic = recordAt(original, keys);
  if (!original || !topic || !Array.isArray(topic.skills) || !topic.skills.every((skill) => typeof skill === "string")
    || !topic.skills.length || typeof topic.systemPrompt !== "string" || !topic.systemPrompt.trim()) {
    throw new Error("The source manifest must record both topic settings as an exact removable contribution.");
  }
  assertExactMergeContribution(original, strategy, content);
  const transferred: MergeRemoval = { skills: topic.skills, systemPrompt: topic.systemPrompt };
  const retained = structuredClone(original);
  const retainedTopic = recordAt(retained, keys)!;
  for (const key of topicKeys) delete retainedTopic[key];
  const conflicts: Array<{ stateKey: string; reason: "unknown-contribution" | "overlapping-contribution" }> = [];
  for (const item of inventory) for (const other of item.manifest.entries) {
    if (other.path !== configPath || item.stateKey === sourceStateKey) continue;
    const removal = other.mergeRemoval;
    if (other.mergeStrategy !== strategy || other.mergeCreatedDestination || !removal || !Object.keys(removal).length) {
      conflicts.push({ stateKey: item.stateKey, reason: "unknown-contribution" });
    } else if (topicKeys.some((key) => conflictsAt(removal, keys, key))) {
      conflicts.push({ stateKey: item.stateKey, reason: "overlapping-contribution" });
    } else {
      assertExactMergeContribution(removal, strategy, content);
    }
  }
  const runtimeHash = createHash("sha256").update("file\0").update(content).digest("hex");
  if (await transport.hashPath(path) !== runtimeHash) throw new Error("OpenClaw configuration changed during inspection; replan.");
  const manifestRevisions = inventory.map((item) => [item.stateKey, item.manifest.revision] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const plan = {
    targetRoot, installationType, sourceStateKey, sourceOwner, chatId, topicId, keys: topicKeys,
    ...(endpoint ? { transport: endpoint } : {}),
    sourceRevision: source.manifest.revision, sourceHash: entry.sourceHash,
    runtimeHash, runtimeSnapshotDigest: observation.snapshotDigest,
    inventoryDigest: digest(manifestRevisions), transferDigest: digest(transferred), retainedDigest: digest(retained),
    conflicts: conflicts.sort((a, b) => a.stateKey.localeCompare(b.stateKey) || a.reason.localeCompare(b.reason)),
  };
  const currentInventory = await listInstallManifests(targetRoot, undefined, transport);
  if (digest(currentInventory.map((item) => [item.stateKey, item.manifest.revision] as const)
    .sort(([a], [b]) => a.localeCompare(b))) !== plan.inventoryDigest
    || (await listAllApplyJournals(targetRoot, undefined, transport)).length) {
    throw new Error("Runtime ownership changed during inspection; replan.");
  }
  return { ...plan, status: plan.conflicts.length ? "blocked" : "verified", planDigest: digest(plan) } as const;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function recordAt(value: MergeValue | undefined, keys: readonly string[]): MergeRemoval | undefined {
  for (const key of keys) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return isRecord(value) ? value : undefined;
}

function conflictsAt(removal: MergeRemoval, keys: readonly string[], leaf: string): boolean {
  let value: MergeValue = removal;
  for (const key of [...keys, leaf]) {
    if (!isRecord(value)) return true;
    if (!Object.hasOwn(value, key)) return false;
    value = value[key];
  }
  return true;
}

function isRecord(value: MergeValue | undefined): value is MergeRemoval {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
