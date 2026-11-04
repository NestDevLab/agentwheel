import { mkdir, mkdtemp, rm, writeFile, symlink, link, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotManagedOwnership, type OwnershipSnapshotRequest } from "../src/lifecycle/ownership-snapshot.js";
import { installManifestPath } from "../src/install/paths.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import type { InstallManifestV2 } from "../src/model/manifest.js";
import { localTransport } from "../src/transport/index.js";
import * as worker from "../src/transport/run-as-worker.js";
import { commandGovernanceMode, isGovernedCommand } from "../src/mutation/commands.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-ownership-snapshot-")); roots.push(root);
  const target = join(root, "target"), workspace = join(root, "workspace");
  await mkdir(target, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const path = ".agents/skills/example", artifact = join(target, path);
  await mkdir(join(artifact, "scripts"), { recursive: true });
  await writeFile(join(artifact, "SKILL.md"), "Example instructions\n");
  await writeFile(join(artifact, "scripts/resolve.py"), "print('verified bytes')\n");
  await writeFile(join(artifact, "domains.json"), '{"schemaVersion":1}\n');
  await writeFile(join(artifact, "private.txt"), "Unrequested bytes must never be returned\n");
  const hash = await localTransport.hashPath(artifact), stateKey = "codex.user.example";
  const manifest: InstallManifestV2 = { version: 2, adapter: "codex", installationType: "user", stateKey,
    targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z", revision: "0".repeat(64), legacy: false, entries: [{
      path, artifactType: "skills", artifactName: "example", installName: "example", kind: "dir", hash,
      sourceHash: hash, channel: "managed", updatedAt: "2026-01-01T00:00:00.000Z",
      owners: ["workspace:example"], refCount: 1, dependencyRole: "root", workspaceOwner: workspaceOwnerForRoot(workspace),
    }] };
  await writeInstallManifest(manifest);
  const request: OwnershipSnapshotRequest = { workspaceRoot: workspace, fromWorkspaceRoot: workspace,
    targetRoot: target, adapter: "codex", installationType: "user", stateKey, selector: "skills/example", path,
    reason: "Read-only managed artifact inspection", files: ["scripts/resolve.py", "domains.json"] };
  return { root, target, workspace, artifact, hash, manifest, request };
}

describe("managed ownership byte snapshots", () => {
  it("is classified read-only even when mutation flags are supplied", () => {
    expect(commandGovernanceMode("ownership snapshot")).toBe("read-only");
    expect(isGovernedCommand("ownership snapshot", { apply: true, recover: true })).toBe(false);
  });

  it("binds the manifest hash to returned bytes and exports only requested files", async () => {
    const f = await fixture();
    const before = await readInstallManifest(f.target, "codex", localTransport, { stateKey: f.request.stateKey });
    const snapshot = await snapshotManagedOwnership(f.request);
    expect(snapshot.artifactHash).toBe(f.hash);
    expect(snapshot.source.revision).toBe(before!.revision);
    expect(snapshot.files.map(file => file.path)).toEqual(f.request.files);
    expect(Buffer.from(snapshot.files[0]!.content, "base64").toString()).toBe("print('verified bytes')\n");
    expect(JSON.stringify(snapshot)).not.toContain("Unrequested bytes must never");
    expect(await readInstallManifest(f.target, "codex", localTransport, { stateKey: f.request.stateKey })).toEqual(before);
    expect(await snapshotManagedOwnership(f.request)).toEqual(snapshot);
  });

  it("does not re-read runtime bytes after capture to compute the accepted hash", async () => {
    const f = await fixture(), capture = worker.executeRead;
    vi.spyOn(worker, "executeRead").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (args[1].operation === "ownershipBytes") await writeFile(join(f.artifact, "scripts/resolve.py"), "changed after acquisition\n");
      return result;
    });
    const snapshot = await snapshotManagedOwnership(f.request);
    expect(snapshot.artifactHash).toBe(f.hash);
    expect(Buffer.from(snapshot.files[0]!.content, "base64").toString()).toBe("print('verified bytes')\n");
  });

  it.each(["drift", "owner", "overlap", "unmanaged", "adapter", "state", "target"])("refuses %s claims without exposing bytes", async (kind) => {
    const f = await fixture(), request = { ...f.request };
    if (kind === "drift") await writeFile(join(f.artifact, "scripts/resolve.py"), "unverified content\n");
    if (kind === "owner") request.fromWorkspaceRoot = join(f.root, "other");
    if (kind === "adapter") request.adapter = "claude";
    if (kind === "state") request.stateKey = "codex.user.missing";
    if (kind === "target") request.targetRoot = f.workspace;
    if (kind === "unmanaged") { f.manifest.entries[0]!.channel = "ejected"; await writeInstallManifest(f.manifest); }
    if (kind === "overlap") await writeInstallManifest({ ...f.manifest, adapter: "claude", stateKey: "claude.user.overlap" });
    await expect(snapshotManagedOwnership(request)).rejects.toThrow();
  });

  it.each(["missing.py", "../escape.py", "scripts/../domains.json", "/absolute", "scripts\\resolve.py", "__pycache__/code.pyc"])("refuses invalid or unverified export %s", async (file) => {
    const f = await fixture();
    await expect(snapshotManagedOwnership({ ...f.request, files: [file] })).rejects.toThrow();
  });

  it.each(["symlink", "hardlink", "ancestor"])("refuses %s paths through the real descriptor helper", async (kind) => {
    const f = await fixture(), outside = join(f.root, "outside.py");
    await writeFile(outside, "outside bytes\n");
    if (kind === "symlink") await symlink(outside, join(f.artifact, "unsafe.py"));
    if (kind === "hardlink") await link(outside, join(f.artifact, "unsafe.py"));
    if (kind === "ancestor") { await rm(join(f.artifact, "scripts"), { recursive: true }); await symlink(f.workspace, join(f.artifact, "scripts")); }
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow();
  });

  it.each(["manifest", "inventory"])("refuses concurrent %s updates during acquisition", async (kind) => {
    const f = await fixture(), capture = worker.executeRead;
    let mutated = false;
    vi.spyOn(worker, "executeRead").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (args[1].operation !== "ownershipBytes") return result;
      if (kind === "manifest") { f.manifest.entries[0]!.owners = ["workspace:changed"]; await writeInstallManifest(f.manifest); }
      else await writeInstallManifest({ ...f.manifest, stateKey: "codex.user.unrelated", entries: [] });
      mutated = true;
      return result;
    });
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow(/changed|concurrent|inventory/i);
    expect(mutated).toBe(true);
  });

  it("refuses a manifest symlink without an ordinary metadata read", async () => {
    const f = await fixture(), path = installManifestPath(f.target, "codex", { stateKey: f.request.stateKey });
    const outside = join(f.root, "outside-manifest.json");
    await rename(path, outside); await symlink(outside, path);
    const ordinaryRead = vi.spyOn(localTransport, "readFile");
    const acquisition = vi.spyOn(worker, "executeRead");
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow();
    expect(acquisition).toHaveBeenCalledWith(f.target, expect.objectContaining({ operation: "ownershipManifestInventory" }));
    expect(ordinaryRead).not.toHaveBeenCalled();
  });

  it("refuses a swapped metadata ancestor without reading its external replacement", async () => {
    const f = await fixture(), metadata = join(f.target, ".agentwheel"), outside = join(f.root, "outside-metadata");
    await mkdir(outside); await writeFile(join(outside, "codex.user.example.install-manifest.json"), "EXTERNAL_METADATA_MUST_NOT_BE_READ");
    const capture = worker.executeRead, ordinaryRead = vi.spyOn(localTransport, "readFile");
    let swapped = false;
    vi.spyOn(worker, "executeRead").mockImplementation(async (...args) => {
      const snapshot = await capture(...args);
      if (!swapped && args[1].operation === "ownershipManifestInventory") {
        await rename(metadata, join(f.target, "saved-metadata"));
        await symlink(outside, metadata); swapped = true;
      }
      return snapshot;
    });
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(ordinaryRead).not.toHaveBeenCalled();
  });

  it("pins the metadata descriptor during an in-flight ancestor swap without external reads", async () => {
    const f = await fixture(), outside = join(f.root, "outside-metadata");
    await mkdir(outside);
    const name = `${f.request.stateKey}.install-manifest.json`;
    await writeFile(join(outside, name), "EXTERNAL_BYTES_MUST_NOT_BE_READ");
    const helper = fileURLToPath(new URL("../src/transport/run-as-fs.py", import.meta.url));
    const probe = `import json,os,runpy,sys
FS=runpy.run_path(sys.argv[1])["Filesystem"]
target,outside,name=sys.argv[2:]
fs=FS(target,os.getuid(),os.getgid())
metadata=os.path.join(target,".agentwheel")
outside_info=os.stat(os.path.join(outside,name))
original_open,original_read=fs.open_at,os.read
state={"swapped":False,"outsideReads":0,"rejected":False}
def swap_open(anchor,path,flags,mode=0):
    if path == name and not state["swapped"]:
        os.rename(metadata,os.path.join(target,"saved-metadata"))
        os.symlink(outside,metadata)
        state["swapped"]=True
    return original_open(anchor,path,flags,mode)
def guarded_read(fd,size):
    info=os.fstat(fd)
    if (info.st_dev,info.st_ino)==(outside_info.st_dev,outside_info.st_ino):
        state["outsideReads"]+=1
        raise AssertionError("external descriptor read attempted")
    return original_read(fd,size)
fs.open_at,os.read=swap_open,guarded_read
try:
    fs.manifest_inventory(".agentwheel")
except OSError:
    state["rejected"]=True
finally:
    os.read=original_read
    os.close(fs.root)
print(json.dumps(state))
`;
    const { stdout } = await execute("/usr/bin/python3", ["-I", "-c", probe, helper, f.target, outside, name]);
    expect(JSON.parse(stdout)).toEqual({ swapped: true, outsideReads: 0, rejected: true });
  });

  it("refuses special files without opening them as streams", async () => {
    const f = await fixture();
    await execute("mkfifo", [join(f.artifact, "unsafe-pipe")]);
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow();
  });

  it("supports an explicitly selected regular file claim", async () => {
    const f = await fixture();
    await rm(f.artifact, { recursive: true }); await writeFile(f.artifact, Buffer.from([0, 255, 10]));
    f.manifest.entries[0]!.kind = "file";
    f.manifest.entries[0]!.hash = await localTransport.hashPath(f.artifact);
    await writeInstallManifest(f.manifest);
    const result = await snapshotManagedOwnership({ ...f.request, files: ["."] });
    expect(result.files).toEqual([{ path: ".", encoding: "base64", content: Buffer.from([0, 255, 10]).toString("base64") }]);
  });

  it.each([{ files: [] }, { files: ["domains.json", "domains.json"] }, { files: ["."] }])("refuses empty, duplicate or directory exports $files", async ({ files }) => {
    const f = await fixture();
    await expect(snapshotManagedOwnership({ ...f.request, files })).rejects.toThrow();
  });

  it("rejects non-local acquisition before dispatching a transport operation", async () => {
    const f = await fixture(), capture = vi.spyOn(worker, "executeRead");
    await expect(snapshotManagedOwnership({ ...f.request, transport: { ...localTransport, kind: "ssh" } })).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not expose parser excerpts from malformed ownership metadata", async () => {
    const f = await fixture(), marker = "SYNTHETIC_UNREQUESTED_METADATA";
    await writeFile(installManifestPath(f.target, "codex", { stateKey: f.request.stateKey }), `{"unclosed":"${marker}`);
    try { await snapshotManagedOwnership(f.request); throw new Error("unexpected snapshot success"); }
    catch (error) { expect(String(error)).not.toContain(marker); expect(String(error)).toMatch(/snapshot verification failed/i); }
  });

  it("enforces the native snapshot byte limit", async () => {
    const f = await fixture();
    await writeFile(join(f.artifact, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    f.manifest.entries[0]!.hash = await localTransport.hashPath(f.artifact); await writeInstallManifest(f.manifest);
    await expect(snapshotManagedOwnership(f.request)).rejects.toThrow();
  });
});
