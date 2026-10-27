import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("qualifies same-root merge ownership for a named fleet without rewriting runtime JSON", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-fleet-target-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-fleet-workspace-"));
    roots.push(targetRoot, workspaceRoot);
    const scope = { installationType: "user", stateKey: "claude.user.legacy" };
    const settingsPath = join(targetRoot, ".claude", "settings.json");
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({ hooks: { Stop: [{ command: "amf-hook" }] }, retained: true }, null, 2)}\n`);
    const manifestHash = "a".repeat(64);
    await writeInstallManifest({
      version: 2,
      adapter: "claude",
      installationType: "user",
      stateKey: scope.stateKey,
      targetRoot,
      generatedAt: "2026-07-14T00:00:00.000Z",
      revision: "pending-owner-fixture",
      legacy: false,
      entries: [{
        path: ".claude/settings.json",
        artifactType: "hooks",
        artifactName: "hooks.json",
        installName: "hooks.json",
        logicalSelector: "hooks/hooks.json",
        kind: "file",
        hash: manifestHash,
        sourceHash: "b".repeat(64),
        updatedAt: "2026-07-14T00:00:00.000Z",
        channel: "managed",
        dependencyRole: "root",
        owners: ["limen-claude-hooks"],
        refCount: 1,
        workspaceOwner: workspaceOwnerForRoot(workspaceRoot),
        mergeStrategy: "json-deep",
        mergeRemoval: { hooks: { Stop: [{ command: "amf-hook" }] } },
      }],
    }, localTransport);
    const before = await readFile(settingsPath);
    const installed = await readInstallManifest(targetRoot, "claude", localTransport, scope);
    if (!installed || installed.version !== 2) throw new Error("missing fleet handoff fixture manifest");
    const request = {
      targetRoot,
      adapter: "claude",
      ...scope,
      artifactType: "hooks",
      artifactName: "hooks.json",
      fromWorkspaceRoot: workspaceRoot,
      toWorkspaceRoot: workspaceRoot,
      toFleetId: "delivery",
      expectedHash: manifestHash,
      expectedRevision: installed.revision,
    };

    const plan = await planArtifactOwnershipHandoff(request);
    expect(plan.toOwner).toBe(workspaceOwnerForRoot(workspaceRoot, "delivery"));
    await applyArtifactOwnershipHandoff(request);

    expect(await readFile(settingsPath)).toEqual(before);
    const updated = await readInstallManifest(targetRoot, "claude", localTransport, scope);
    expect(updated?.version).toBe(2);
    if (!updated || updated.version !== 2) throw new Error("missing updated fleet handoff fixture manifest");
    expect(updated.entries[0]?.workspaceOwner).toBe(workspaceOwnerForRoot(workspaceRoot, "delivery"));
  });

  it("round-trips plain and fleet-qualified owners while preserving merged contributions, blocks and sibling claims", async () => {
    const f = await roundTripFixture();
    const bytes = await Promise.all([readFile(f.configPath), readFile(f.instructionsPath)]);
    const modes = await Promise.all([stat(f.configPath), stat(f.instructionsPath)]);
    const original = await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope);
    if (!original || original.version !== 2) throw new Error("Missing round-trip manifest");
    for (const [artifactType, artifactName, operation] of [["mcp", "example.json", "mcp"], ["instructions", "AGENTS.md", "instructions"]]) {
      const before = await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope);
      if (!before || before.version !== 2) throw new Error("Missing source manifest");
      const selected = before.entries.find(entry => entry.artifactType === artifactType && entry.artifactName === artifactName)!;
      const request = { targetRoot: f.targetRoot, workspaceRoot: f.workspaceRoot, globalRoot: f.workspaceRoot, adapter: "codex", ...f.scope,
        artifactType, artifactName, fromWorkspaceRoot: f.workspaceRoot, toWorkspaceRoot: f.workspaceRoot,
        toFleetId: "delivery", expectedHash: selected.hash, expectedRevision: before.revision, operationId: `${operation}-qualify` };
      expect((await planArtifactOwnershipHandoff(request)).fromOwner).toBe(workspaceOwnerForRoot(f.workspaceRoot));
      await applyArtifactOwnershipHandoff(request);
      const qualified = await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope);
      if (!qualified || qualified.version !== 2) throw new Error("Missing qualified manifest");
      expect(qualified.entries.filter(entry => entry.artifactType !== artifactType || entry.artifactName !== artifactName))
        .toEqual(before.entries.filter(entry => entry !== selected));
      const reverse = { ...request, toFleetId: undefined, fromFleetId: "delivery", expectedRevision: qualified.revision, operationId: `${operation}-unqualify` };
      const reversePlan = await planArtifactOwnershipHandoff(reverse);
      expect(reversePlan.fromOwner).toBe(workspaceOwnerForRoot(f.workspaceRoot, "delivery"));
      expect(reversePlan.toOwner).toBe(workspaceOwnerForRoot(f.workspaceRoot));
      await applyArtifactOwnershipHandoff(reverse);
      const audit = JSON.parse(await readFile(join(f.workspaceRoot, ".agentwheel/ownership-handoffs", `${operation}-unqualify.json`), "utf8"));
      expect(audit.plan.fromOwner).toBe(workspaceOwnerForRoot(f.workspaceRoot, "delivery"));
      expect((await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope))?.entries).toEqual(original.entries);
    }
    expect(await readFile(f.configPath)).toEqual(bytes[0]); expect(await readFile(f.instructionsPath)).toEqual(bytes[1]);
    expect((await stat(f.configPath)).mode).toBe(modes[0].mode); expect((await stat(f.instructionsPath)).mode).toBe(modes[1].mode);
  });

  it("requires an explicit valid source fleet and its exact current root and owner", async () => {
    const f = await localFixture();
    const original = await readFile(f.manifestPath);
    await expect(planArtifactOwnershipHandoff({ ...f.request, fromFleetId: "../delivery" })).rejects.toThrow();
    await expect(planArtifactOwnershipHandoff({ ...f.request, fromFleetId: "delivery", fromWorkspaceRoot: undefined })).rejects.toThrow(/fromWorkspaceRoot|source.*root/i);
    await expect(planArtifactOwnershipHandoff({ ...f.request, fromFleetId: "delivery", fromWorkspaceRoot: undefined, fromUnknownOwner: true })).rejects.toThrow(/unknown|fromWorkspaceRoot|source.*root/i);
    await expect(planArtifactOwnershipHandoff({ ...f.request, fromFleetId: "delivery" })).rejects.toThrow(/Old owner precondition failed/);
    expect(await readFile(f.manifestPath)).toEqual(original);
    const manifest = await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope);
    if (!manifest || manifest.version !== 2) throw new Error("Missing source manifest");
    await writeInstallManifest({ ...manifest, entries: manifest.entries.map((entry, index) => index === 0
      ? { ...entry, workspaceOwner: workspaceOwnerForRoot(f.fromWorkspaceRoot, "delivery") } : entry) });
    const current = await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope);
    if (!current) throw new Error("Missing qualified source manifest");
    const qualifiedBefore = await readFile(f.manifestPath);
    const reverse = { ...f.request, fromFleetId: "delivery", expectedRevision: current.revision };
    await expect(planArtifactOwnershipHandoff({ ...reverse, fromFleetId: "another" })).rejects.toThrow(/Old owner/);
    await expect(planArtifactOwnershipHandoff({ ...reverse, fromWorkspaceRoot: f.toWorkspaceRoot })).rejects.toThrow(/Old owner/);
    await expect(applyArtifactOwnershipHandoff({ ...reverse, expectedRevision: "0".repeat(64) })).rejects.toThrow(/Manifest revision/);
    const plan = await planArtifactOwnershipHandoff(reverse);
    expect(plan.fromOwner).toBe(workspaceOwnerForRoot(f.fromWorkspaceRoot, "delivery"));
    expect(await readFile(f.manifestPath)).toEqual(qualifiedBefore);
    expect((await readInstallManifest(f.targetRoot, "codex", localTransport, f.scope))?.revision).toBe(current.revision);
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

  it("carries reviewed file drift only with the exact runtime hash and keeps the recorded hash", async () => {
    const fixture = await localFixture();
    await writeFile(fixture.skillFile, "hand-edited\n");
    const runtimeHash = await localTransport.hashPath(fixture.artifactPath);
    const before = await readFile(fixture.manifestPath, "utf8");

    await expect(planArtifactOwnershipHandoff(fixture.request)).rejects.toThrow(/Managed artifact is drifted/);
    const plan = await planArtifactOwnershipHandoff({ ...fixture.request, carryDrift: true });
    expect(plan).toMatchObject({ drifted: true, artifactHash: fixture.request.expectedHash, runtimeHash });
    await expect(applyArtifactOwnershipHandoff({ ...fixture.request, carryDrift: true }))
      .rejects.toThrow(/requires expectedRuntimeHash/);
    await expect(applyArtifactOwnershipHandoff({
      ...fixture.request,
      carryDrift: true,
      expectedRuntimeHash: "0".repeat(64),
    })).rejects.toThrow(/Runtime hash precondition failed/);
    await expect(planArtifactOwnershipHandoff({ ...fixture.request, expectedRuntimeHash: runtimeHash }))
      .rejects.toThrow(/only valid with carryDrift/);
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(before);

    await applyArtifactOwnershipHandoff({ ...fixture.request, carryDrift: true, expectedRuntimeHash: runtimeHash });
    const manifest = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    if (!manifest || manifest.version !== 2) throw new Error("missing v2 manifest");
    expect(manifest.entries[0]).toMatchObject({
      workspaceOwner: workspaceOwnerForRoot(fixture.toWorkspaceRoot),
      hash: fixture.request.expectedHash,
    });
    expect(await readFile(fixture.skillFile, "utf8")).toBe("hand-edited\n");
  });

  it("rejects a stale runtime hash once the artifact is no longer drifted", async () => {
    const fixture = await localFixture();
    await expect(planArtifactOwnershipHandoff({
      ...fixture.request,
      carryDrift: true,
      expectedRuntimeHash: "0".repeat(64),
    })).rejects.toThrow(/no longer drifted/);
    const plan = await planArtifactOwnershipHandoff({ ...fixture.request, carryDrift: true });
    expect(plan.drifted).toBe(false);
  });

  it("hands off an entry recorded as workspace:unknown only when selected explicitly", async () => {
    const fixture = await localFixture();
    const manifest = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    if (!manifest || manifest.version !== 2) throw new Error("missing v2 manifest");
    await writeInstallManifest({
      ...manifest,
      entries: manifest.entries.map((entry, index) => index === 0 ? { ...entry, workspaceOwner: "workspace:unknown" } : entry),
    }, localTransport);
    const unknown = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    if (!unknown || unknown.version !== 2) throw new Error("missing unknown-owner manifest");
    const { fromWorkspaceRoot: _omitted, ...withoutRoot } = fixture.request;
    const request = { ...withoutRoot, fromUnknownOwner: true, expectedRevision: unknown.revision };

    await expect(planArtifactOwnershipHandoff({ ...fixture.request, expectedRevision: unknown.revision }))
      .rejects.toThrow(/Old owner precondition failed/);
    await expect(planArtifactOwnershipHandoff({ ...request, fromWorkspaceRoot: fixture.fromWorkspaceRoot }))
      .rejects.toThrow(/exactly one of fromWorkspaceRoot or fromUnknownOwner/);
    await expect(planArtifactOwnershipHandoff(withoutRoot)).rejects.toThrow(/exactly one of/);

    const plan = await planArtifactOwnershipHandoff(request);
    expect(plan.fromOwner).toBe("workspace:unknown");
    await applyArtifactOwnershipHandoff(request);
    const updated = await readInstallManifest(fixture.targetRoot, "codex", localTransport, fixture.scope);
    if (!updated || updated.version !== 2) throw new Error("missing updated manifest");
    expect(updated.entries[0].workspaceOwner).toBe(workspaceOwnerForRoot(fixture.toWorkspaceRoot));
    expect(updated.entries[1].workspaceOwner).toBe("workspace-root:/unrelated");
  });

  it("never carries drift for merge-owned entries", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-merge-drift-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-merge-ws-"));
    roots.push(targetRoot, workspaceRoot);
    const scope = { installationType: "user", stateKey: "claude.user.merge-drift" };
    await mkdir(join(targetRoot, ".claude"), { recursive: true });
    await writeFile(join(targetRoot, ".claude", "settings.json"), `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
    await writeInstallManifest({
      version: 2,
      adapter: "claude",
      installationType: "user",
      stateKey: scope.stateKey,
      targetRoot,
      generatedAt: "2026-07-14T00:00:00.000Z",
      revision: "pending-owner-fixture",
      legacy: false,
      entries: [{
        path: ".claude/settings.json",
        artifactType: "hooks",
        artifactName: "hooks.json",
        installName: "hooks.json",
        logicalSelector: "hooks/hooks.json",
        kind: "file",
        hash: "a".repeat(64),
        sourceHash: "b".repeat(64),
        updatedAt: "2026-07-14T00:00:00.000Z",
        channel: "managed",
        dependencyRole: "root",
        owners: ["limen-claude-hooks"],
        refCount: 1,
        workspaceOwner: workspaceOwnerForRoot(workspaceRoot),
        mergeStrategy: "json-deep",
        mergeRemoval: { hooks: { Stop: [{ command: "amf-hook" }] } },
      }],
    }, localTransport);
    await expect(planArtifactOwnershipHandoff({
      targetRoot,
      adapter: "claude",
      ...scope,
      artifactType: "hooks",
      artifactName: "hooks.json",
      fromWorkspaceRoot: workspaceRoot,
      toWorkspaceRoot: workspaceRoot,
      toFleetId: "delivery",
      carryDrift: true,
    })).rejects.toThrow();
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
      listDir: async () => [],
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

async function roundTripFixture() {
  const targetRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-roundtrip-target-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agentwheel-owner-roundtrip-workspace-"));
  roots.push(targetRoot, workspaceRoot);
  const scope = { installationType: "local", stateKey: "codex.local.roundtrip" };
  await mkdir(join(workspaceRoot, ".agentwheel"));
  await writeFile(join(workspaceRoot, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4, packages: [] }));
  await mkdir(join(targetRoot, ".codex"));
  const configPath = join(targetRoot, ".codex/config.toml"), instructionsPath = join(targetRoot, "AGENTS.md");
  await writeFile(configPath, '[mcp_servers.example]\ncommand = "example"\nargs = ["--demo"]\n\n[mcp_servers.retained]\ncommand = "retained"\n\n[unmanaged]\nkeep = true\n');
  const body = "reviewed instructions\n", hash = createHash("sha256").update(body).digest("hex");
  await writeFile(instructionsPath, `unmanaged prefix\n<!-- BEGIN openpack:include instructions/AGENTS.md sha256:${hash} -->\n${body}<!-- END openpack:include instructions/AGENTS.md -->\nunmanaged suffix\n`);
  await chmod(configPath, 0o640); await chmod(instructionsPath, 0o600);
  const common = { kind: "file" as const, sourceHash: "c".repeat(64), updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed" as const,
    owners: ["fixture"], refCount: 1, dependencyRole: "root" as const, workspaceOwner: workspaceOwnerForRoot(workspaceRoot) };
  await writeInstallManifest({ version: 2, adapter: "codex", ...scope, targetRoot, generatedAt: "2026-01-01T00:00:00.000Z", revision: "pending-roundtrip-revision", legacy: false,
    entries: [
      { ...common, path: ".codex/config.toml", artifactType: "mcp", artifactName: "example.json", installName: "example.json", hash: "a".repeat(64),
        mergeStrategy: "codex-toml-mcp", mergeRemoval: { mcpServers: { example: { command: "example", args: ["--demo"] } } } },
      { ...common, path: "AGENTS.md", artifactType: "instructions", artifactName: "AGENTS.md", installName: "AGENTS.md", logicalSelector: "instructions/AGENTS.md", mode: "managed-block", hash },
      { ...common, path: ".codex/config.toml", artifactType: "mcp", artifactName: "retained.json", installName: "retained.json", hash: "b".repeat(64),
        workspaceOwner: workspaceOwnerForRoot(join(workspaceRoot, "other-owner")), mergeStrategy: "codex-toml-mcp", mergeRemoval: { mcpServers: { retained: { command: "retained" } } } },
    ] });
  return { targetRoot, workspaceRoot, scope, configPath, instructionsPath };
}
