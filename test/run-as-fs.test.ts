import { spawn, spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../src/transport/run-as-fs.py", import.meta.url));
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const roots: string[] = [];
const linuxUser = process.platform === "linux" && uid > 0 && gid > 0;
function request(root: string, operation: string, fields: Record<string, unknown> = {}, identity = { uid, gid }) {
  const result = spawnSync("/usr/bin/python3", ["-I", helper, "--root", root, "--uid", String(identity.uid), "--gid", String(identity.gid)], {
    input: JSON.stringify({ version: 1, operation, ...fields }), encoding: "utf8", maxBuffer: 24 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { version: number; result?: unknown; error?: { code: string; message: string } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-fs-test-"));
  roots.push(root);
  return root;
}
const content = (text: string | Buffer) => Buffer.from(text).toString("base64");
// Instrument real syscalls in a disposable subprocess; production has no test hooks.
function tracedRequest(root: string, operations: Record<string, unknown>[], failAfter?: string) {
  const source = `
import errno,json,os,runpy,sys
module=runpy.run_path(sys.argv[1],run_name='filesystem_test')
root=sys.argv[2]
config=json.load(sys.stdin)
events=[]
def label(fd):
    path=os.readlink('/proc/self/fd/'+str(fd))
    return '.' if path==root else path.removeprefix(root+'/')
def child(fd,name):
    parent=label(fd)
    return str(name) if parent=='.' else parent+'/'+str(name)
def wrap(name):
    original=getattr(os,name)
    def call(*args,**kwargs):
        if name=='fsync':
            event=[name,label(args[0])]
            if events and events[-1][0]==config.get('failAfter'):
                events.append(['fsync-failed',event[1]])
                raise OSError(errno.EIO,'Injected durability failure')
        elif name=='fchmod': event=[name,label(args[0])]
        elif name=='rename': event=[name,child(kwargs['src_dir_fd'],args[0]),child(kwargs['dst_dir_fd'],args[1]),label(kwargs['dst_dir_fd'])]
        else: event=[name,child(kwargs['dir_fd'],args[0]),label(kwargs['dir_fd'])]
        result=original(*args,**kwargs)
        events.append(event)
        return result
    setattr(os,name,call)
for name in ('mkdir','unlink','rmdir','rename','fchmod','fsync'): wrap(name)
filesystem=module['Filesystem'](root,os.getuid(),os.getgid())
try:
    for operation in config['operations']:
        filesystem.execute({'version':1,**operation})
    response={'result':True}
except OSError as error:
    response={'error':{'code':errno.errorcode.get(error.errno),'message':str(error)}}
finally:
    os.close(filesystem.root)
print(json.dumps({**response,'events':events}))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", source, helper, root], {
    input: JSON.stringify({ operations, failAfter }), encoding: "utf8", maxBuffer: 24 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { result?: boolean; error?: { code: string }; events: string[][] };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("confined filesystem identity", () => {
  it("rejects root and mismatched pinned identities without writing", async () => {
    const root = await fixture();
    expect(request(root, "probe", {}, { uid: 0, gid: 0 }).error?.code).toBe("EPERM");
    expect(request(root, "probe", {}, { uid: uid + 1, gid: gid || 1 }).error?.code).toBe("EPERM");
  });
});

describe.skipIf(!linuxUser)("Linux openat2 confined filesystem", () => {
  it("probes without writes and preserves structured missing/existing errors", async () => {
    const root = await fixture();
    expect(request(root, "probe").result).toBe(true);
    expect(request(root, "listDir", { path: "." }).result).toEqual([]);
    expect(request(root, "pathExists", { path: "missing" }).result).toBe(false);
    expect(request(root, "listDir", { path: "missing" }).result).toEqual([]);
    expect(request(root, "readFile", { path: "missing" }).error?.code).toBe("ENOENT");
    expect(request(root, "mkdirExclusive", { path: "parents/lock" }).error).toBeUndefined();
    expect(request(root, "mkdirExclusive", { path: "parents/lock" }).error?.code).toBe("EEXIST");
  });

  it("copies byte-exact trees and restores modes, ignored content and empty directories", async () => {
    const root = await fixture();
    await mkdir(join(root, "tree", "empty"), { recursive: true });
    await mkdir(join(root, "tree", ".git"));
    await writeFile(join(root, "tree", ".git", "config"), "ignored");
    await writeFile(join(root, "tree", "binary"), Buffer.from([0, 255, 128, 10]), { mode: 0o640 });
    await chmod(join(root, "tree"), 0o750);
    const before = request(root, "snapshot", { path: "tree", includeIgnored: true }).result;
    const filtered = request(root, "snapshot", { path: "tree", includeIgnored: false }).result as Array<{ path: string }>;
    expect(filtered.map(entry => entry.path)).toEqual(["", "binary", "empty"]);
    expect(request(root, "copyWithin", { source: "tree", path: "backup" }).error).toBeUndefined();
    expect(request(root, "snapshot", { path: "backup", includeIgnored: true }).result).toEqual(before);
    expect(request(root, "writeFileAtomic", { path: "tree/binary", content: content("changed") }).error).toBeUndefined();
    expect((request(root, "snapshot", { path: "tree/binary", includeIgnored: true }).result as Array<{ mode: number }>)[0]?.mode).toBe(0o640);
    expect(request(root, "copyWithin", { source: "backup", path: "tree" }).error).toBeUndefined();
    expect(request(root, "snapshot", { path: "tree", includeIgnored: true }).result).toEqual(before);
    expect(request(root, "readFile", { path: "tree/binary" }).result).toBe(content(Buffer.from([0, 255, 128, 10])));
    expect(request(root, "rm", { path: "tree" }).error).toBeUndefined();
    expect(request(root, "rm", { path: "tree" }).error).toBeUndefined();
  });

  it("validates a complete hierarchy, bytes and permission bits before writes", async () => {
    const root = await fixture();
    await writeFile(join(root, "target"), "original");
    const invalid = [
      [{ path: "child", kind: "file", mode: 0o600, content: content("x") }],
      [{ path: "", kind: "dir", mode: 0o755 }, { path: "missing/child", kind: "dir", mode: 0o700 }],
      [{ path: "", kind: "file", mode: 0o4600, content: content("x") }],
      [{ path: "", kind: "file", mode: 0o600, content: "!" }],
      [{ path: "", kind: "dir", mode: 0o700 }, { path: "", kind: "dir", mode: 0o700 }],
    ];
    for (const entries of invalid) {
      expect(request(root, "installSnapshot", { path: "target", entries }).error?.code).toBe("EINVAL");
      expect(await readFile(join(root, "target"), "utf8")).toBe("original");
    }
    expect(request(root, "installSnapshot", { path: "target", entries: [
      { path: "", kind: "dir", mode: 0o750 },
      { path: "empty", kind: "dir", mode: 0o710 },
      { path: "file", kind: "file", mode: 0o604, content: content("hello") },
    ] }).error).toBeUndefined();
    expect(request(root, "snapshot", { path: "target", includeIgnored: true }).result).toEqual([
      { path: "", kind: "dir", mode: 0o750 },
      { path: "empty", kind: "dir", mode: 0o710 },
      { path: "file", kind: "file", mode: 0o604, content: content("hello") },
    ]);
  });

  it("rejects traversal, root mutations, symlink roots and symlinks in every operation", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "sentinel"), "unchanged");
    await symlink(outside, join(root, "escape"));
    for (const path of ["../sentinel", "/sentinel", "a/../sentinel", "x\\sentinel", "bad\0name", "a//b"]) {
      expect(request(root, "pathExists", { path }).error?.code).toBe("EINVAL");
    }
    for (const operation of ["rm", "mkdirExclusive", "writeFileAtomic", "installSnapshot", "copyWithin"]) {
      expect(request(root, operation, { path: ".", source: "escape", content: content("x"), entries: [] }).error).toBeDefined();
    }
    for (const operation of ["pathExists", "listDir", "readFile", "snapshot", "rm", "writeFileAtomic"]) {
      expect(request(root, operation, { path: "escape/sentinel", includeIgnored: true, content: content("x") }).error).toBeDefined();
    }
    expect(request(join(root, "escape"), "probe").error?.code).toBe("ELOOP");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("rejects hardlinks and special files without blocking", async () => {
    const root = await fixture();
    await writeFile(join(root, "file"), "original");
    await link(join(root, "file"), join(root, "hardlink"));
    expect(spawnSync("/usr/bin/mkfifo", [join(root, "fifo")]).status).toBe(0);
    for (const path of ["file", "hardlink", "fifo"]) {
      for (const operation of ["pathExists", "readFile", "snapshot", "rm", "writeFileAtomic"]) {
        expect(request(root, operation, { path, content: content("x"), includeIgnored: true }).error?.code).toBe("EINVAL");
      }
    }
  });

  it("bounds decoded file bytes, aggregate bytes, entry counts and depth", async () => {
    const root = await fixture();
    const huge = content(Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(request(root, "writeFileAtomic", { path: "huge", content: huge }).error?.code).toBe("EINVAL");
    expect(request(root, "pathExists", { path: "huge" }).result).toBe(false);
    expect(request(root, "mkdirExclusive", { path: Array(65).fill("d").join("/") }).error?.code).toBe("EINVAL");
    const entries = [{ path: "", kind: "dir", mode: 0o700 }, ...Array.from({ length: 4096 }, (_, i) => ({ path: `f${i}`, kind: "dir", mode: 0o700 }))];
    expect(request(root, "installSnapshot", { path: "huge", entries }).error?.code).toBe("EINVAL");
    const data = content(Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(request(root, "installSnapshot", { path: "huge", entries: [
      { path: "", kind: "dir", mode: 0o700 },
      { path: "a", kind: "file", mode: 0o600, content: data },
      { path: "b", kind: "file", mode: 0o600, content: data },
    ] }).error?.code).toBe("EINVAL");
  });

  it("durably orders new ancestors, empty backup directories, chmod, rename and recursive removal", async () => {
    const root = await fixture();
    const traced = tracedRequest(root, [
      { operation: "mkdirExclusive", path: "ancestors/nested/empty" },
      { operation: "writeFileAtomic", path: "ancestors/nested/file", content: content("durable") },
      { operation: "copyWithin", source: "ancestors", path: "backup" },
      { operation: "rm", path: "backup" },
      { operation: "rm", path: "ancestors" },
    ]);
    expect(traced.error).toBeUndefined();
    expect(traced.result).toBe(true);
    const { events } = traced;
    expect(events.some(event => event[0] === "mkdir" && event[1]?.endsWith("/empty"))).toBe(true);
    expect(events.some(event => event[0] === "fchmod" && event[1]?.endsWith("/empty"))).toBe(true);
    expect(events.some(event => event[0] === "rename")).toBe(true);
    expect(events.some(event => event[0] === "unlink")).toBe(true);
    expect(events.some(event => event[0] === "rmdir")).toBe(true);
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event[0] === "mkdir") {
        // The new directory inode and its parent's entry must both be durable
        // before the next mutation, including every newly created ancestor.
        expect(events[i + 1]).toEqual(["fsync", event[1]]);
        expect(events[i + 2]).toEqual(["fsync", event[2]]);
      } else if (event[0] === "fchmod") {
        expect(events[i + 1]).toEqual(["fsync", event[1]]);
      } else if (event[0] === "rename") {
        expect(events[i + 1]).toEqual(["fsync", event[3]]);
      } else if (event[0] === "unlink" || event[0] === "rmdir") {
        expect(events[i + 1]).toEqual(["fsync", event[2]]);
      }
    }
    expect(request(root, "listDir", { path: "." }).result).toEqual([]);
  });

  it("never acknowledges a mutation when directory durability fails", async () => {
    const cases: Array<{ failAfter: string; prepare?: (root: string) => Promise<void>; operation: Record<string, unknown> }> = [
      { failAfter: "mkdir", operation: { operation: "mkdirExclusive", path: "ancestor/child" } },
      { failAfter: "fsync", operation: { operation: "mkdirExclusive", path: "ancestor/child" } },
      { failAfter: "fchmod", operation: { operation: "installSnapshot", path: "empty-backup", entries: [{ path: "", kind: "dir", mode: 0o750 }] } },
      { failAfter: "rename", operation: { operation: "writeFileAtomic", path: "file", content: content("written") } },
      { failAfter: "unlink", prepare: root => writeFile(join(root, "file"), "remove"), operation: { operation: "rm", path: "file" } },
      { failAfter: "rmdir", prepare: root => mkdir(join(root, "empty")), operation: { operation: "rm", path: "empty" } },
    ];
    for (const testCase of cases) {
      const root = await fixture();
      await testCase.prepare?.(root);
      const traced = tracedRequest(root, [testCase.operation], testCase.failAfter);
      expect(traced.result).toBeUndefined();
      expect(traced.error?.code).toBe("EIO");
      expect(traced.events.some(event => event[0] === "fsync-failed")).toBe(true);
    }
  });

  it("never follows an adversarial concurrently replaced directory symlink", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "sentinel"), "unchanged");
    await mkdir(join(root, "switch"));
    // The attacker alternates a real directory and a link while helpers write below it.
    const attacker = spawn("/usr/bin/python3", ["-I", "-c", [
      "import os,sys,time", "root,outside=sys.argv[1:]", "p=root+'/switch'", "park=root+'/park'",
      "end=time.monotonic()+5", "while time.monotonic()<end:", " try:",
      "  os.rename(p,park)", "  os.symlink(outside,p)", "  os.unlink(p)", "  os.rename(park,p)",
      " except OSError: pass",
    ].join("\n"), root, outside], { stdio: "ignore" });
    try {
      for (let i = 0; i < 30; i++) {
        request(root, "writeFileAtomic", { path: "switch/sentinel", content: content("inside") });
      }
    } finally {
      attacker.kill("SIGKILL");
      await new Promise<void>(resolve => attacker.once("close", () => resolve()));
    }
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged");
  }, 15_000);
});
