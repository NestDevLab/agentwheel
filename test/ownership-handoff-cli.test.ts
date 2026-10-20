import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";
import { readInstallManifest, writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { localTransport } from "../src/transport/index.js";
import { workspaceOwnerForRoot } from "../src/lifecycle/ownership.js";

const exec = promisify(execFile);
const cli = join(process.cwd(), "dist/index.js");
const roots: string[] = [];
beforeAll(() => ensureCliBuild(cli));
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("ownership handoff explicit source state", () => {
  it("selects exactly the same complete merge as the existing named-agent stateKey without editing config", async () => {
    const f = await fixture();
    const original = await readFile(f.config, "utf8");
    const flag = await f.run(["--source-state-key", f.key, "--dry-run"]);
    const configured = JSON.parse(original);
    configured.agents.runtime.stateKey = f.key;
    await writeFile(f.config, JSON.stringify(configured));
    const named = await f.run(["--dry-run"]);
    expect(flag.stdout).toBe(named.stdout);
    await writeFile(f.config, original);
    expect(await readFile(f.config, "utf8")).toBe(original);
    expect(await readFile(f.manifest)).toEqual(f.manifestBefore);
    expect(await readFile(f.runtimeFile)).toEqual(f.runtimeBefore);
    expect(flag.stderr).not.toContain("Agentwheel mutation operation:");
  });

  it("applies only the selected owner with the existing hash/revision guards and preserves runtime/config/graph", async () => {
    const f = await fixture();
    const config = await readFile(f.config);
    const mode = (await stat(f.runtimeFile)).mode;
    const before = await readInstallManifest(f.target, "codex", localTransport, f.scope);
    if (!before || before.version !== 2) throw new Error("Missing fixture manifest");
    const result = await f.run(["--source-state-key", f.key, "--expected-hash", "a".repeat(64), "--expected-revision", before.revision]);
    expect(result.stdout).toContain("Ownership handed off:");
    const after = await readInstallManifest(f.target, "codex", localTransport, f.scope);
    expect(after?.entries[0]).toEqual({ ...before.entries[0], workspaceOwner: workspaceOwnerForRoot(f.workspace) });
    expect(after?.entries[1]).toEqual(before.entries[1]);
    expect(await readFile(f.runtimeFile)).toEqual(f.runtimeBefore);
    expect((await stat(f.runtimeFile)).mode).toBe(mode);
    expect(await readFile(f.config)).toEqual(config);
    expect(await readFile(f.graphSentinel, "utf8")).toBe("unchanged graph sentinel\n");
  });

  it.each([
    ["missing key", "codex.local.missing", /No install manifest/],
    ["wrong adapter", "claude.local.legacy", /scoped to the selected adapter/],
    ["wrong installation type", "codex.user.legacy", /selected installation type/],
    ["noncanonical key", "codex.local.../legacy", /exact, canonical/],
  ])("rejects %s without changing any claim", async (_label, key, error) => {
    const f = await fixture();
    await expect(f.run(["--source-state-key", key, "--dry-run"])).rejects.toMatchObject({ stderr: expect.stringMatching(error) });
    expect(await readFile(f.manifest)).toEqual(f.manifestBefore);
    expect(await readFile(f.runtimeFile)).toEqual(f.runtimeBefore);
  });

  it.each([
    ["wrong target", "target", /identity does not match|target root mismatch/i],
    ["wrong source owner", "owner", /Old owner precondition failed/],
    ["missing merge provenance", "incomplete", /cannot verify incomplete merge ownership/],
    ["changed merge contribution despite carry-drift", "contribution", /exact MCP retirement precondition failed/],
    ["wrong recorded hash", "hash", /Manifest hash precondition failed/],
    ["wrong revision", "revision", /Manifest revision precondition failed/],
  ])("retains native rejection for %s", async (_label, change, error) => {
    const f = await fixture();
    const args = ["--source-state-key", f.key, "--dry-run"];
    if (change === "target" || change === "incomplete") {
      const manifest = JSON.parse(f.manifestBefore.toString());
      if (change === "target") manifest.targetRoot = join(f.target, "other");
      else delete manifest.entries[0].mergeRemoval;
      await writeFile(f.manifest, JSON.stringify(manifest));
    }
    if (change === "owner") args.push("--from-workspace-root", join(f.workspace, "wrong-owner"));
    if (change === "contribution") {
      await writeFile(f.runtimeFile, '[mcp_servers.example]\ncommand = "different"\nargs = ["--demo"]\n');
      args.push("--carry-drift");
    }
    if (change === "hash") args.push("--expected-hash", "b".repeat(64));
    if (change === "revision") args.push("--expected-revision", "b".repeat(64));
    const before = await readFile(f.manifest);
    const runtime = await readFile(f.runtimeFile);
    await expect(f.run(args)).rejects.toMatchObject({ stderr: expect.stringMatching(error) });
    expect(await readFile(f.manifest)).toEqual(before);
    expect(await readFile(f.runtimeFile)).toEqual(runtime);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-handoff-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const target = join(root, "runtime");
  const home = join(root, "home");
  const oldOwner = join(root, "old-owner");
  const key = "codex.local.authentic-legacy";
  const scope = { installationType: "local", stateKey: key };
  const config = join(workspace, ".agentwheel/config.json");
  const graphSentinel = join(workspace, ".agentwheel/locks/sentinel.txt");
  await mkdir(join(workspace, ".agentwheel/locks"), { recursive: true });
  await mkdir(join(target, ".codex"), { recursive: true });
  await mkdir(home);
  await writeFile(config, JSON.stringify({ schemaVersion: 1, packages: [], agents: {
    runtime: { adapter: "codex", root: target, transport: "local", installationType: "local" },
  }, profiles: {}, registry: {}, trust: {} }));
  await writeFile(graphSentinel, "unchanged graph sentinel\n");
  const runtimeFile = join(target, ".codex/config.toml");
  await writeFile(runtimeFile, '[mcp_servers.example]\ncommand = "example"\nargs = ["--demo"]\n\n[retained]\nvalue = true\n');
  await writeInstallManifest({ version: 2, adapter: "codex", installationType: "local", stateKey: key,
    targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z", revision: "fixture-pending-revision", legacy: false,
    entries: [{ path: ".codex/config.toml", artifactType: "mcp", artifactName: "example.json", installName: "example.json", dependencyRole: "root", kind: "file",
      hash: "a".repeat(64), sourceHash: "c".repeat(64), updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed",
      owners: ["workspace:example-pack"], refCount: 1, workspaceOwner: workspaceOwnerForRoot(oldOwner),
      mergeStrategy: "codex-toml-mcp", mergeRemoval: { mcpServers: { example: { command: "example", args: ["--demo"] } } } },
    { path: "unrelated.txt", artifactType: "rules", artifactName: "unrelated.txt", installName: "unrelated.txt", dependencyRole: "root", sourceHash: "d".repeat(64), kind: "file", hash: "d".repeat(64),
      updatedAt: "2026-01-01T00:00:00.000Z", channel: "managed", owners: ["workspace:other"], refCount: 1,
      workspaceOwner: workspaceOwnerForRoot(join(root, "unrelated-owner")) }],
  }, localTransport);
  const manifest = installManifestPath(target, "codex", scope);
  return { workspace, target, config, graphSentinel, runtimeFile, key, scope, manifest,
    manifestBefore: await readFile(manifest), runtimeBefore: await readFile(runtimeFile),
    run: (args: string[]) => exec("node", [cli, "--no-update-check", "ownership", "handoff", "mcp/example.json",
      "--local", "--agent", "runtime", "--from-workspace-root", oldOwner, "--to-workspace-root", workspace, ...args],
    { cwd: workspace, env: { ...process.env, HOME: home }, maxBuffer: 2 * 1024 * 1024 }),
  };
}
