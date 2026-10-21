import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyCombinedInstallPlan } from "../src/install/apply.js";
import { stateKeyFor } from "../src/install/paths.js";
import type { InstallPlan } from "../src/install/plan.js";
import { installRootForAdapterInstallationType, installRootForArtifacts } from "../src/model/adapter.js";
import { resolveTargetStateIdentity } from "../src/model/target-state.js";
import { workspaceAgentSchema } from "../src/model/workspace.js";
import { createRunAsTransport, defaultRunAsRunner, type RunAsRunner } from "../src/transport/run-as.js";
import { resolveRunAsIdentity, type RunAsIdentity } from "../src/transport/run-as-identity.js";
import { containedReadPath, executeRead } from "../src/transport/run-as-worker.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "aw-runas-test-")); roots.push(root); return root; }
function identity(root: string): RunAsIdentity { return { user: "service", uid: 998, gid: 998, home: root, root }; }
function distinctServiceIdentity(root: string): RunAsIdentity {
  return { ...identity(root), uid: process.getuid!() === 65534 ? 65533 : 65534 };
}
async function trustedNodeFixture(root: string): Promise<string> {
  const executable = join(root, "node");
  await writeFile(executable, "fixture");
  await chmod(executable, 0o555);
  return executable;
}

describe("local run-as schema and identity", () => {
  it("requires a named service account and rejects SSH fields, root and relative roots", () => {
    const valid = { adapter: "openclaw", root: "/srv/service", transport: "local-run-as", runAs: "service" };
    expect(workspaceAgentSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, runAs: undefined }, { ...valid, runAs: "root" }, { ...valid, root: "relative" },
      { ...valid, host: "host" }, { ...valid, user: "other" }, { ...valid, port: 22 },
      { ...valid, identityFile: "/tmp/key" }, { ...valid, transport: "local" },
    ]) expect(workspaceAgentSchema.safeParse(invalid).success).toBe(false);
  });

  it("pins getent UID/GID/home and rejects unknown users, symlink roots and wrong owners", async () => {
    const root = await fixture();
    const uid = process.getuid!();
    const passwd = (name: string) => `${name}:x:${uid}:100::${root}:/usr/sbin/nologin`;
    expect(resolveRunAsIdentity("service", root, passwd)).toMatchObject({ uid, gid: 100, home: root });
    expect(() => resolveRunAsIdentity("unknown", root, () => { throw new Error("missing"); })).toThrow(/unknown/);
    expect(() => resolveRunAsIdentity("service", root, (name) => `${name}:x:${uid + 1}:100::${root}:/usr/sbin/nologin`)).toThrow(/owned/);
    const link = `${root}-link`;
    roots.push(link);
    await symlink(root, link);
    expect(() => resolveRunAsIdentity("service", link, passwd)).toThrow(/symlink/);
  });

  it("uses the pinned service home and gives run-as a separate stable state key", async () => {
    const root = await fixture();
    const runAs = identity(root);
    expect(installRootForAdapterInstallationType(openClawAdapter, root, "user", { kind: "local-run-as", homeRoot: root })).toBe(root);
    expect(() => installRootForAdapterInstallationType(openClawAdapter, "/other", "user", { kind: "local-run-as", homeRoot: root })).toThrow(/home/);
    expect(() => installRootForArtifacts(openClawAdapter, "/other", "user", ["skills"], { kind: "local-run-as", homeRoot: root })).toThrow(/home/);
    const common = { adapter: "openclaw", installationType: "user", targetRoot: root };
    const state = (kind: "local" | "local-run-as") => resolveTargetStateIdentity({
      targetFingerprintParts: { ...common, transport: kind, ...(kind === "local-run-as" ? { runAs } : {}) },
      workspaceRoot: "/control", targetKey: "service", resolvedInstallRoot: root, transportKind: kind,
    }).stateFingerprint;
    expect(state("local-run-as")).toBe(state("local-run-as"));
    expect(state("local-run-as")).not.toBe(state("local"));
    expect(stateKeyFor("openclaw", { installationType: "user", targetFingerprint: state("local-run-as") })).not.toBe(
      stateKeyFor("openclaw", { installationType: "user", targetFingerprint: state("local") }));
  });
});

describe("local run-as read transport", () => {
  it("uses exact noninteractive sudo argv, an empty environment and a bounded stdin protocol", async () => {
    const root = await fixture();
    const node = await trustedNodeFixture(root);
    const service = distinctServiceIdentity(root);
    expect(statSync(node).uid).toBe(process.getuid!());
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner: RunAsRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return { stdout: input ? JSON.stringify({ version: 1, result: JSON.parse(input).operation === "readFile" ? "content" : true }) : `${service.uid}\n` };
    };
    const transport = createRunAsTransport(service, runner, "/fixed/run-as-worker.mjs", node);
    expect(await transport.pathExists(join(root, "managed"))).toBe(true);
    expect(calls[0]).toEqual({ command: "/usr/bin/sudo", args: ["-n", "-u", "service", "-H", "--", "/usr/bin/id", "-u"], input: undefined });
    expect(calls[1]?.command).toBe("/usr/bin/sudo");
    expect(calls[1]?.args).toEqual(["-n", "-u", "service", "-H", "--", "/usr/bin/env", "-i",
      `HOME=${root}`, "PATH=/usr/local/bin:/usr/bin:/bin", realpathSync(node), "/fixed/run-as-worker.mjs", "--root", root, "--uid", String(service.uid), "--gid", "998"]);
    expect(JSON.parse(calls[1]!.input!)).toEqual({ version: 1, operation: "pathExists", path: "managed" });
    expect(calls[1]?.args).not.toContain("-c");
    expect(calls[1]?.args).not.toContain(`HOME=${process.env.HOME ?? "/home/example"}`);
    await Promise.all([transport.pathExists(join(root, "second")), transport.readFile(join(root, "third"))]);
    expect(calls.filter(({ args }) => args.at(-2) === "/usr/bin/id" && args.at(-1) === "-u")).toHaveLength(1);
  });

  it("fails closed on sudo denial, a wrong UID, escaping paths and mutations before a valid preflight", async () => {
    const root = await fixture();
    const node = await trustedNodeFixture(root);
    const service = distinctServiceIdentity(root);
    const denied = createRunAsTransport(service, async () => { throw new Error("a password is required"); }, "/fixed/worker", node);
    await expect(denied.pathExists(join(root, "x"))).rejects.toThrow(/sudo preflight failed/);
    const wrong = createRunAsTransport(service, async () => ({ stdout: "0\n" }), "/fixed/worker", node);
    await expect(wrong.pathExists(join(root, "x"))).rejects.toThrow(new RegExp(`expected ${service.uid}`));
    await expect(wrong.pathExists("/etc/passwd")).rejects.toThrow(/escapes/);
    await expect(wrong.writeFileAtomic(join(root, "x"), "data")).rejects.toThrow(new RegExp(`expected ${service.uid}`));
    const plan = { hasBlockingChanges: false, adapter: "openclaw", targetRoot: root, operations: [], baseRevision: null, installationType: "user", stateKey: "openclaw.user.test" } as InstallPlan;
    await expect(applyCombinedInstallPlan(plan, { transport: wrong })).rejects.toThrow(new RegExp(`expected ${service.uid}`));
  });

  it("rejects a service-owned or writable Node executable before sudo", async () => {
    const root = await fixture();
    const executable = join(root, "node");
    await writeFile(executable, "fixture");
    const currentUid = process.getuid!();
    if (currentUid > 0) {
      expect(() => createRunAsTransport({ ...identity(root), uid: currentUid }, async () => ({ stdout: "" }), "/fixed/worker", executable)).toThrow(/Node executable must be an immutable/);
    }
    await chmod(executable, 0o666);
    expect(() => createRunAsTransport(identity(root), async () => ({ stdout: "" }), "/fixed/worker", executable)).toThrow(/Node executable must be an immutable/);
    expect(() => createRunAsTransport(identity(root), async () => ({ stdout: "" }), "/fixed/worker", "node")).toThrow(/must be absolute/);
  });

  it("shares validation snapshots only with the named UID despite restrictive caller umask", async () => {
    const root = await fixture(), node = await trustedNodeFixture(root), service = distinctServiceIdentity(root);
    let snapshot: string | undefined;
    const runner: RunAsRunner = async (_command, _args, input) => {
      if (!input) return { stdout: String(service.uid) };
      const request = JSON.parse(input);
      if (request.operation === "validateOpenClawConfig") {
        snapshot = request.validationSnapshot;
        expect(statSync(snapshot!).mode & 0o777).toBe(0o440);
        const { execFileSync } = await import("node:child_process");
        const acl = JSON.parse(execFileSync("/usr/bin/python3", ["-I", "-c", "import os,struct,json,sys; a=os.getxattr(sys.argv[1],'system.posix_acl_access'); print(json.dumps([struct.unpack('<HHI',a[i:i+8]) for i in range(4,len(a),8)]))", snapshot!], { encoding: "utf8" }));
        expect(acl).toEqual([[1,4,4294967295], [2,4,service.uid], [4,0,4294967295], [16,4,4294967295], [32,0,4294967295]]);
      }
      return { stdout: JSON.stringify({ version: 1, result: request.operation === "readFile" ? "{}" : request.operation === "probe" ? true : null }) };
    };
    const transport = createRunAsTransport(service, runner, "/fixed/worker", node);
    const oldMask = process.umask(0o077);
    try { await transport.validateOpenClawConfig!(join(root, "candidate.json")); }
    finally { process.umask(oldMask); }
    expect(snapshot).toBeDefined();
    expect(() => statSync(snapshot!)).toThrow(/ENOENT/);
  });

  it("times out stalled child processes with and without request input", async () => {
    const args = ["-e", "setInterval(() => {}, 1000)"];
    for (const input of [undefined, "request"]) {
      await expect(defaultRunAsRunner(process.execPath, args, input, 100)).rejects.toMatchObject({ killed: true });
    }
  });

  it("computes ownership snapshots in the worker, including ignored bytes and file modes", async () => {
    const root = await fixture();
    await mkdir(join(root, "__pycache__"));
    const file = join(root, "__pycache__", "cache.pyc");
    await writeFile(file, "first", { mode: 0o600 });
    const request = { version: 1 as const, operation: "ownershipSnapshot" as const, path: "." };
    const before = await executeRead(root, request);
    await writeFile(file, "second");
    const changed = await executeRead(root, request);
    expect(changed).not.toBe(before);
    await chmod(file, 0o640);
    expect(await executeRead(root, request)).not.toBe(changed);
    await symlink("/etc/passwd", join(root, "__pycache__", "escape"));
    await expect(executeRead(root, request)).rejects.toThrow(/symbolic links|symlink/);
  });

  it("rejects directory reads through the worker readFile operation", async () => {
    const root = await fixture();
    await mkdir(join(root, "directory"));
    await expect(executeRead(root, { version: 1, operation: "readFile", path: "directory" })).rejects.toThrow(/regular file/);
  });

  it("rejects traversal and symlinks inside the worker, and reads contained inventory", async () => {
    const root = await fixture();
    await mkdir(join(root, ".agentwheel"));
    await writeFile(join(root, ".agentwheel", "state.json"), "{}\n");
    expect(await executeRead(root, { version: 1, operation: "listDir", path: ".agentwheel" })).toEqual(["state.json"]);
    expect(await executeRead(root, { version: 1, operation: "pathExists", path: ".agentwheel/state.json" })).toBe(true);
    await expect(containedReadPath(root, "../etc/passwd")).rejects.toThrow(/contained/);
    await expect(containedReadPath(root, "/etc/passwd")).rejects.toThrow(/contained/);
    await expect(containedReadPath(root, "x\\y")).rejects.toThrow(/contained/);
    await symlink("/etc/passwd", join(root, "escape"));
    await expect(executeRead(root, { version: 1, operation: "readFile", path: "escape" })).rejects.toThrow(/symbolic links|symlink/);
  });
});
