import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizationJournalTrustScript } from "../src/lifecycle/fleet-normalize-transport.js";

// Model exact kernel metadata at the subprocess seam: the service can chmod
// an inode it owns even when its current mode grants no write permission.
const prelude = `import os,stat,types,errno,sys
sys.argv=['trust','/caller/private/journal', '65534','65534']
os.geteuid=lambda:1000
states={
'/':(0,0,stat.S_IFDIR|0o755),
'/caller':(65534,65534,stat.S_IFDIR|0o555),
'/caller/private':(1000,1000,stat.S_IFDIR|0o700),
'/caller/private/journal':(1000,1000,stat.S_IFREG|0o600)}
def metadata(path):
    uid,gid,mode=states[path]
    return types.SimpleNamespace(st_uid=uid,st_gid=gid,st_mode=mode,st_nlink=1)
os.lstat=metadata
def no_acl(path,key): raise OSError(errno.ENODATA,'no acl')
os.getxattr=no_acl
`;
describe("caller normalization journal trust", () => {
  it("rejects read-only service-owned ancestors regardless of current access", () => {
    expect(() => execFileSync("/usr/bin/python3", ["-I", "-c", prelude + normalizationJournalTrustScript], { stdio: "pipe" })).toThrow();
  });
  it("accepts a caller-owned private subtree without rejecting harmless other-group modes", () => {
    const trusted = prelude + "states['/caller']=(1000,1000,stat.S_IFDIR|0o775)\n";
    expect(() => execFileSync("/usr/bin/python3", ["-I", "-c", trusted + normalizationJournalTrustScript], { stdio: "pipe" })).not.toThrow();
  });
  it("checks absent graph and audit destinations against their existing ancestors", () => {
    const trusted = prelude + "states['/caller']=(1000,1000,stat.S_IFDIR|0o755)\nsys.argv=['trust','/caller/private/new-audit','65534','65534','destination']\n";
    const missing = "original=os.lstat\ndef missing(path):\n    if path not in states: raise FileNotFoundError(path)\n    return original(path)\nos.lstat=missing\n";
    expect(() => execFileSync("/usr/bin/python3", ["-I", "-c", trusted + missing + normalizationJournalTrustScript], { stdio: "pipe" })).not.toThrow();
    const hostile = trusted + "states['/caller/private']=(65534,65534,stat.S_IFDIR|0o555)\n";
    expect(() => execFileSync("/usr/bin/python3", ["-I", "-c", hostile + missing + normalizationJournalTrustScript], { stdio: "pipe" })).toThrow();
  });

});
