import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { applyArtifactOwnershipHandoff, planArtifactOwnershipHandoff, workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";
import { localTransport } from "../src/transport/index.js";
import type { TargetTransport } from "../src/transport/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact ownership handoff", () => {
  it("changes only one manifest owner after exact local preconditions", async () => {
    const fixture = await localFixture();
    const beforeBytes = await readFile(fixture.skillFile);
    const beforeStat = await stat(fixture.artifactPath);
    const beforeManifest = await readFile(fixture.manifestPath, "utf8");

    const dryRun = await planArtifactOwnershipHandoff(fixture.request);
    expect(dryRun.path).toBe(".agents/skills/obsidian-memory");
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(beforeManifest);

    await applyArtifactOwnershipHandoff(fixture.request);
    const manifest = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    expect(manifest?.version).toBe(2);
    if (!manifest || manifest.version !== 2) throw new Error("missing v2 manifest");
    expect(manifest.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(fixture.toWorkspaceRoot));
    expect(manifest.entries[1].workspaceOwner).toBe("workspace-root:/unrelated");
    expect(await readFile(fixture.skillFile)).toEqual(beforeBytes);
    expect((await stat(fixture.artifactPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("rejects owner, hash, and revision mismatches without writing", async () => {
    const fixture = await localFixture();
    const before = await readFile(fixture.manifestPath, "utf8");
    await expect(planArtifactOwnershipHandoff({
      ...fixture.request,
      fromWorkspaceRoot: "/wrong-owner",
    })).rejects.toThrow(/Old owner precondition failed/);
    await expect(planArtifactOwnershipHandoff({
      ...fixture.request,
      expectedHash: "0".repeat(64),
    })).rejects.toThrow(/Manifest hash precondition failed/);
    await expect(applyArtifactOwnershipHandoff({
      ...fixture.request,
      expectedRevision: "0".repeat(64),
    })).rejects.toThrow(/Manifest revision precondition failed/);
    await writeFile(fixture.skillFile, "drifted\n");
    await expect(planArtifactOwnershipHandoff({
      ...fixture.request,
      expectedHash: undefined,
      expectedRevision: undefined,
    })).rejects.toThrow(/Managed artifact is drifted/);
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(before);
  });

  it("uses the same atomic manifest-only contract over SSH transports", async () => {
    const targetRoot = "/remote/home/user";
    const artifactPath = `${targetRoot}/.agents/skills/obsidian-memory`;
    const hash = "a".repeat(64);
    const fromWorkspaceRoot = "/controller/old";
    const toWorkspaceRoot = "/controller/new";
    const scope = { installationType: "user", stateKey: "codex.user.remote" };
    const manifest = manifestFixture(targetRoot, hash, fromWorkspaceRoot, scope.stateKey);
    const manifestPath = installManifestPath(targetRoot, "codex", scope);
    const files = new Map<string, string>([[manifestPath, `${JSON.stringify(manifest, null, 2)}\n`]]);
    const atomicWrites: string[] = [];
    const dirs = new Set<string>([artifactPath]);
    const transport: TargetTransport = {
      kind: "ssh",
      description: "ssh://fixture",
      pathExists: async (path) => files.has(path) || dirs.has(path),
      mkdirExclusive: async (path) => {
        if (dirs.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        dirs.add(path);
      },
      hashPath: async (path) => path === artifactPath ? hash : "0".repeat(64),
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
      writeFileAtomic: async (path, content) => { files.set(path, String(content)); },
      writeJsonAtomic: async (path, data) => {
        atomicWrites.push(path);
        files.set(path, `${JSON.stringify(data, null, 2)}\n`);
      },
      atomicCopy: async () => { throw new Error("runtime copy must not be called"); },
      rm: async (path) => { dirs.delete(path); files.delete(path); },
    };
    const parsed = await readInstallManifest(targetRoot, "codex", transport, scope);
    if (!parsed) throw new Error("missing manifest");

    await applyArtifactOwnershipHandoff({
      targetRoot,
      adapter: "codex",
      ...scope,
      artifactType: "skills",
      artifactName: "obsidian-memory",
      fromWorkspaceRoot,
      toWorkspaceRoot,
      expectedHash: hash,
      expectedRevision: parsed.revision,
      transport,
    });

    expect(atomicWrites.filter((path) => path === manifestPath)).toHaveLength(1);
    const updated = await readInstallManifest(targetRoot, "codex", transport, scope);
    expect(updated?.version).toBe(2);
    if (!updated || updated.version !== 2) throw new Error("missing v2 manifest");
    expect(updated.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(toWorkspaceRoot));
  });

  it("rejects a manifest whose internal identity points outside the requested target", async () => {
    const fixture = await localFixture();
    const otherRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-other-"));
    roots.push(otherRoot);
    const raw = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as Record<string, unknown>;
    raw.targetRoot = otherRoot;
    await writeFile(fixture.manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    const corrupted = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    if (!corrupted) throw new Error("missing corrupt fixture manifest");

    await expect(applyArtifactOwnershipHandoff({
      ...fixture.request,
      expectedRevision: corrupted.revision,
    })).rejects.toThrow(/manifest identity does not match requested target/i);

    expect(await localTransport.pathExists(installManifestPath(otherRoot, "codex", fixture.scope))).toBe(false);
  });
});

async function localFixture() {
  const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-target-"));
  const fromWorkspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-old-"));
  const toWorkspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-new-"));
  roots.push(targetRoot, fromWorkspaceRoot, toWorkspaceRoot);
  const scope = { installationType: "user", stateKey: "codex.user.fixture" };
  const artifactPath = join(targetRoot, ".agents/skills/obsidian-memory");
  const skillFile = join(artifactPath, "SKILL.md");
  await mkdir(artifactPath, { recursive: true });
  await writeFile(skillFile, "fixture\n");
  const hash = await localTransport.hashPath(artifactPath);
  await writeInstallManifest(manifestFixture(targetRoot, hash, fromWorkspaceRoot, scope.stateKey), localTransport);
  const manifest = await readInstallManifest(targetRoot, "codex", localTransport, scope);
  if (!manifest) throw new Error("missing manifest");
  return {
    targetRoot,
    artifactPath,
    skillFile,
    manifestPath: installManifestPath(targetRoot, "codex", scope),
    fromWorkspaceRoot,
    toWorkspaceRoot,
    scope,
    request: {
      targetRoot,
      adapter: "codex",
      ...scope,
      artifactType: "skills",
      artifactName: "obsidian-memory",
      fromWorkspaceRoot,
      toWorkspaceRoot,
      expectedHash: hash,
      expectedRevision: manifest.revision,
    },
  };
}

function manifestFixture(targetRoot: string, hash: string, fromWorkspaceRoot: string, stateKey: string) {
  const common = {
    kind: "dir" as const,
    hash,
    sourceHash: hash,
    updatedAt: "2026-07-14T00:00:00.000Z",
    channel: "managed" as const,
    dependencyRole: "root" as const,
    owners: ["obsidian-second-brain"],
    refCount: 1,
  };
  return {
    version: 2 as const,
    adapter: "codex",
    installationType: "user",
    stateKey,
    targetRoot,
    generatedAt: "2026-07-14T00:00:00.000Z",
    revision: "pending-owner-fixture",
    legacy: false as const,
    entries: [
      {
        ...common,
        path: ".agents/skills/obsidian-memory",
        artifactType: "skills" as const,
        artifactName: "obsidian-memory",
        installName: "obsidian-memory",
        logicalSelector: "skills/obsidian-memory",
        workspaceOwner: workspaceOwnerForRoot(fromWorkspaceRoot),
      },
      {
        ...common,
        path: ".agents/skills/unrelated",
        artifactType: "skills" as const,
        artifactName: "unrelated",
        installName: "unrelated",
        logicalSelector: "skills/unrelated",
        workspaceOwner: "workspace-root:/unrelated",
      },
    ],
  };
}
