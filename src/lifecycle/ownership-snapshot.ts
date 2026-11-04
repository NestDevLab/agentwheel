import { resolve } from "node:path";
import { computeInstallManifestInventoryRevision } from "../install/manifest.js";
import { isIgnoredGeneratedEntry } from "../utils/fs.js";
import { executeRead, type OwnershipBytesSnapshot } from "../transport/run-as-worker.js";
import { selectReleaseOwnershipClaim, ownershipProofDigest, type ReleaseOwnershipRequest } from "./ownership-release.js";

export type OwnershipSnapshotRequest = Pick<ReleaseOwnershipRequest,
  "workspaceRoot" | "fromWorkspaceRoot" | "fromFleetId" | "targetRoot" | "adapter" |
  "installationType" | "stateKey" | "selector" | "path" | "reason" | "transport"> & { files: string[] };

function selectedFiles(files: string[]): string[] {
  if (!files.length || files.length > 4096 || new Set(files).size !== files.length) {
    throw new Error("Snapshot requires a bounded, unique list of explicitly selected files.");
  }
  for (const file of files) {
    if (file === ".") continue; // Explicit file-claim root, never directory enumeration.
    if (!file || file.length > 4096 || file.startsWith("/") || file.includes("\\") || file.includes("\0")
      || file.split("/").some(part => !part || part === "." || part === ".." || isIgnoredGeneratedEntry(part))) {
      throw new Error("Snapshot export must be a contained file covered by the managed artifact hash.");
    }
  }
  return [...files];
}

/** Read-only: verify the native managed hash over the very buffers being exported. */
export async function snapshotManagedOwnership(request: OwnershipSnapshotRequest) {
  try { return await captureManagedOwnership(request); }
  catch { throw new Error("Ownership snapshot verification failed (claim, content, confinement or concurrent inventory); no file bytes returned."); }
}

async function captureManagedOwnership(request: OwnershipSnapshotRequest) {
  const files = selectedFiles(request.files);
  if (request.transport && request.transport.kind !== "local") {
    throw new Error("Ownership byte snapshots currently require a local caller-owned target.");
  }
  const target = resolve(request.targetRoot);
  const selected = await selectReleaseOwnershipClaim(request);
  const inventoryBefore = await computeInstallManifestInventoryRevision(target, undefined, request.transport);
  if (selected.entry.channel !== "managed") throw new Error("Snapshot requires an explicitly managed artifact claim.");
  const identity = { adapter: request.adapter, installationType: request.installationType,
    targetRoot: selected.targetRoot, workspaceRoot: selected.workspaceRoot, owner: selected.owner,
    selector: request.selector, path: selected.entry.path, source: selected.source };
  // One confined acquisition. The worker computes both native digests from this
  // same snapshot; no later runtime read participates in the accepted hash.
  const captured = await executeRead(target, { version: 1, operation: "ownershipBytes", path: selected.entry.path }) as OwnershipBytesSnapshot;
  if (captured.kind !== selected.entry.kind || captured.artifactHash !== selected.entry.hash) {
    throw new Error("Managed artifact snapshot does not match its recorded kind and hash.");
  }
  const after = await selectReleaseOwnershipClaim(request);
  const inventoryAfter = await computeInstallManifestInventoryRevision(target, undefined, request.transport);
  if (inventoryBefore !== inventoryAfter || ownershipProofDigest(selected.source) !== ownershipProofDigest(after.source)
    || selected.owner !== after.owner || ownershipProofDigest(selected.inventory) !== ownershipProofDigest(after.inventory)) {
    throw new Error("Ownership manifest or inventory changed concurrently during snapshot acquisition.");
  }
  const exported = files.map(path => {
    const entry = captured.entries.find(entry => entry.path === (path === "." ? "" : path));
    if (!entry || entry.kind !== "file" || entry.content === undefined) {
      throw new Error("An explicitly selected snapshot file is missing or is not a regular file.");
    }
    return { path, encoding: "base64" as const, content: entry.content };
  });
  const result = { schemaVersion: 1 as const, ...identity,
    artifactHash: captured.artifactHash, snapshotDigest: captured.snapshotDigest,
    manifestInventoryRevision: inventoryAfter, files: exported };
  return { ...result, proofDigest: ownershipProofDigest(result) };
}
