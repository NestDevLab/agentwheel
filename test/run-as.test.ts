import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
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
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner: RunAsRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return { stdout: input ? JSON.stringify({ version: 1, result: true }) : "998\n" };
    };
    const transport = createRunAsTransport(identity(root), runner, "/fixed/run-as-worker.mjs", process.execPath);
    expect(await transport.pathExists(join(root, "managed"))).toBe(true);
    expect(calls[0]).toEqual({ command: "/usr/bin/sudo", args: ["-n", "-u", "service", "-H", "--", "/usr/bin/id", "-u"], input: undefined });
    expect(calls[1]?.command).toBe("/usr/bin/sudo");
    expect(calls[1]?.args).toEqual(["-n", "-u", "service", "-H", "--", "/usr/bin/env", "-i",
      `HOME=${root}`, "PATH=/usr/local/bin:/usr/bin:/bin", realpathSync(process.execPath), "/fixed/run-as-worker.mjs", "--root", root, "--uid", "998", "--gid", "998"]);
    expect(JSON.parse(calls[1]!.input!)).toEqual({ version: 1, operation: "pathExists", path: "managed" });
    expect(calls[1]?.args).not.toContain("-c");
    expect(calls[1]?.args).not.toContain(`HOME=${process.env.HOME ?? "/home/example"}`);
    await Promise.all([transport.pathExists(join(root, "second")), transport.readFile(join(root, "third"))]);
    expect(calls.filter(({ args }) => args.at(-2) === "/usr/bin/id" && args.at(-1) === "-u")).toHaveLength(1);
  });

  it("fails closed on sudo denial, a wrong UID, escaping paths and all writes", async () => {
    const root = await fixture();
    const denied = createRunAsTransport(identity(root), async () => { throw new Error("a password is required"); }, "/fixed/worker", process.execPath);
    await expect(denied.pathExists(join(root, "x"))).rejects.toThrow(/sudo preflight failed/);
    const wrong = createRunAsTransport(identity(root), async () => ({ stdout: "0\n" }), "/fixed/worker", process.execPath);
    await expect(wrong.pathExists(join(root, "x"))).rejects.toThrow(/expected 998/);
    await expect(wrong.pathExists("/etc/passwd")).rejects.toThrow(/escapes/);
    await expect(wrong.writeFileAtomic(join(root, "x"), "data")).rejects.toThrow(/read-only in PR1/);
    const plan = { hasBlockingChanges: false, installationType: "user", stateKey: "openclaw.user.test" } as InstallPlan;
    await expect(applyCombinedInstallPlan(plan, { transport: wrong })).rejects.toThrow(/read-only in PR1/);
  });

  it("rejects a service-owned or writable Node executable before sudo", async () => {
    const root = await fixture();
    const executable = join(root, "node");
    await writeFile(executable, "fixture");
    const currentUid = process.getuid!();
    if (currentUid > 0) {
      expect(() => createRunAsTransport({ ...identity(root), uid: currentUid }, async () => ({ stdout: "" }), "/fixed/worker", executable)).toThrow(/Node executable is writable/);
    }
    await chmod(executable, 0o666);
    expect(() => createRunAsTransport(identity(root), async () => ({ stdout: "" }), "/fixed/worker", executable)).toThrow(/Node executable is writable/);
    expect(() => createRunAsTransport(identity(root), async () => ({ stdout: "" }), "/fixed/worker", "node")).toThrow(/must be absolute/);
  });

  it("times out stalled child processes with and without request input", async () => {
    const args = ["-e", "setInterval(() => {}, 1000)"];
    for (const input of [undefined, "request"]) {
      await expect(defaultRunAsRunner(process.execPath, args, input, 100)).rejects.toMatchObject({ killed: true });
    }
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
    await expect(executeRead(root, { version: 1, operation: "readFile", path: "escape" })).rejects.toThrow(/symlink/);
  });
});
