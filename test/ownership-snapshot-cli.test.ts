import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { writeInstallManifest } from "../src/install/manifest.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import { localTransport } from "../src/transport/index.js";
import { ownershipRuntimeSnapshot } from "../src/transport/ownership-snapshot.js";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-snapshot-cli-")); roots.push(root);
  const target = join(root, "target"), workspace = join(root, "workspace"), home = join(root, "home");
  for (const path of [target, workspace, home]) await mkdir(path, { mode: 0o700 });
  const path = ".agents/skills/example", artifact = join(target, path), stateKey = "codex.local.example";
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "SKILL.md"), "Selected verified bytes\n");
  await writeFile(join(artifact, "unrequested.txt"), "Unrequested fixture bytes\n");
  const hash = await localTransport.hashPath(artifact);
  await writeInstallManifest({ version: 2, legacy: false, adapter: "codex", installationType: "local", stateKey,
    targetRoot: target, generatedAt: "2026-01-01T00:00:00.000Z", revision: "pending-revision", entries: [{
      path, artifactType: "skills", artifactName: "example", installName: "example", kind: "dir", hash, sourceHash: hash,
      channel: "managed", updatedAt: "2026-01-01T00:00:00.000Z", owners: ["workspace:example"], refCount: 1,
      dependencyRole: "root", workspaceOwner: workspaceOwnerForRoot(workspace),
    }] });
  const preload = join(root, "fetch-trap.cjs"), fetched = join(root, "fetch-attempted");
  await writeFile(preload, `Object.defineProperty(process.stderr, 'isTTY', {value: true});\nglobal.fetch = async () => { require('node:fs').writeFileSync(${JSON.stringify(fetched)}, 'fetch attempted'); throw Error('network forbidden'); };\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_OPTIONS: `--require ${preload}` };
  delete env.CI; delete env.AGENTWHEEL_NO_UPDATE_CHECK;
  return { root, target, workspace, path, stateKey, hash, env, fetched };
}

it("exports only selected bytes with no update fetch, metadata writes, lock or provider operation", async () => {
  const cli = resolve("dist/index.js"); await ensureCliBuild(cli);
  const f = await fixture(), before = await ownershipRuntimeSnapshot(f.root);
  // Deliberately omit --no-update-check, clear CI opt-outs and force TTY in the
  // preload. The new leaf itself must skip the update-check network/cache path.
  const { stdout, stderr } = await execute(process.execPath, [cli, "ownership", "snapshot", "skills/example",
    "--adapter", "codex", "--installation-type", "local", "--target-root", f.target,
    "--state-key", f.stateKey, "--path", f.path, "--from-workspace-root", f.workspace,
    "--file", "SKILL.md", "--json"], { env: f.env });
  const result = JSON.parse(stdout);
  expect(result.artifactHash).toBe(f.hash);
  expect(result.files.map((file: { path: string }) => file.path)).toEqual(["SKILL.md"]);
  expect(Buffer.from(result.files[0].content, "base64").toString()).toBe("Selected verified bytes\n");
  expect(stderr).not.toContain("mutation operation");
  expect(await ownershipRuntimeSnapshot(f.root)).toBe(before);
  await expect(readFile(f.fetched)).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

it("rejects executable configured adapters before importing them", async () => {
  const cli = resolve("dist/index.js"); await ensureCliBuild(cli);
  const f = await fixture(), marker = join(f.root, "adapter-executed");
  await mkdir(join(f.workspace, ".agentwheel"));
  await writeFile(join(f.workspace, "adapter.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  await writeFile(join(f.workspace, ".agentwheel/config.json"), JSON.stringify({ schemaVersion: 4, packages: [], agents: {
    example: { adapter: "codex", root: f.target, transport: "local", installationType: "local", adapterModule: "./adapter.mjs" },
  } }));
  const before = await ownershipRuntimeSnapshot(f.root);
  await expect(execute(process.execPath, [cli, "ownership", "snapshot", "skills/example", "--local", "--agent", "example",
    "--state-key", f.stateKey, "--path", f.path, "--from-workspace-root", f.workspace, "--file", "SKILL.md", "--json"],
  { cwd: f.workspace, env: f.env })).rejects.toThrow();
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await ownershipRuntimeSnapshot(f.root)).toBe(before);
}, 120_000);
