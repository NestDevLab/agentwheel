import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustedOpenClawEntry, trustedRunAsCode } from "../src/transport/run-as-trust.js";
const roots: string[] = [];
const uid = process.getuid!() === 65534 ? 65533 : 65534;
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-code-trust-")); roots.push(root);
  const entry = join(root, "openclaw.mjs"); await writeFile(entry, "export {};", { mode: 0o644 });
  return { root, entry };
}
describe("run-as executable trust", () => {
  it("allows protected entries under sticky /tmp and rejects replaceable ancestors", async () => {
    const { root, entry } = await fixture();
    expect(trustedRunAsCode(entry, uid, [], "fixture")).toBe(entry);
    await chmod(root, 0o777);
    expect(() => trustedRunAsCode(entry, uid, [], "fixture")).toThrow(/ancestor/);
    await chmod(root, 0o1777);
    expect(trustedRunAsCode(entry, uid, [], "fixture")).toBe(entry);
    expect(() => trustedRunAsCode(entry, process.getuid!(), [], "fixture")).toThrow(/immutable/);
  });
  it("rejects service supplementary-group writes to ancestor entries", async () => {
    const { root, entry } = await fixture(); await chmod(root, 0o770);
    expect(() => trustedRunAsCode(entry, uid, [process.getgid!()], "fixture")).toThrow(/ancestor/);
    expect(() => trustedRunAsCode(entry, uid, [], "fixture")).toThrow(/ancestor/);
  });
  it("rejects a named-user POSIX ACL grant despite an unrelated owning group", async () => {
    const { root, entry } = await fixture();
    // Linux ACL access xattr: owner rwx, named service rwx, group r-x,
    // mask rwx, other --- (the group-class mode reflects the ACL mask).
    execFileSync("/usr/bin/python3", ["-I", "-c", "import os,struct,sys; entries=[(1,7,4294967295),(2,7,int(sys.argv[2])),(4,5,4294967295),(16,7,4294967295),(32,0,4294967295)]; os.setxattr(sys.argv[1], 'system.posix_acl_access', struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in entries))", root, String(uid)]);
    expect(() => trustedRunAsCode(entry, uid, [], "fixture")).toThrow(/ancestor/);
  });
  it("checks every validator dependency and rejects symlinks outside the pinned package", async () => {
    const { root, entry } = await fixture();
    expect(trustedOpenClawEntry(root, uid, [])).toBe(entry);
    const dependencies = join(root, "node_modules"); await mkdir(dependencies, { mode: 0o755 });
    const dep = join(dependencies, "dep.mjs"); await writeFile(dep, "export {};", { mode: 0o666 }); await chmod(dep, 0o666);
    expect(() => trustedOpenClawEntry(root, uid, [])).toThrow(/service-writable/);
    await chmod(dep, 0o644); await symlink("/etc/passwd", join(dependencies, "escape"));
    expect(() => trustedOpenClawEntry(root, uid, [])).toThrow(/escapes/);
  });
});
