import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RunAsIdentity } from "./run-as-identity.js";
const exec = promisify(execFile);

// Check the service's real groups and ACL access, including replaceable ancestors.
// Missing destinations are safe only below an immutable existing ancestor.
export const callerWriteTrustScript = `import errno,os,stat,struct,sys
path=sys.argv[1]; uid=int(sys.argv[2]); groups=set(map(int,sys.argv[3].split(','))); private=len(sys.argv)<5 or sys.argv[4]=='private'
def permissions(path,s):
    if s.st_uid==uid: return (s.st_mode>>6)&7
    try: raw=os.getxattr(path,'system.posix_acl_access')
    except OSError as e:
        if e.errno not in (errno.ENODATA,errno.ENOTSUP): raise
        return ((s.st_mode>>3)&7) if s.st_gid in groups else s.st_mode&7
    entries=[struct.unpack('<HHI',raw[i:i+8]) for i in range(4,len(raw),8)]
    mask=next((p for t,p,i in entries if t==16),7)
    named=next((p for t,p,i in entries if t==2 and i==uid),None)
    if named is not None: return named&mask
    matches=[p for t,p,i in entries if (t==4 and s.st_gid in groups) or (t==8 and i in groups)]
    if matches:
        result=0
        for p in matches: result|=p
        return result&mask
    return next(p for t,p,i in entries if t==32)
parent='/'
for name in path.strip('/').split('/'):
    child=os.path.join(parent,name); ps=os.lstat(parent)
    try: cs=os.lstat(child)
    except FileNotFoundError:
        if ps.st_uid==uid or permissions(parent,ps)&3==3: raise RuntimeError('service controls missing caller destination')
        if private: raise
        break
    if stat.S_ISLNK(cs.st_mode): raise RuntimeError('journal symlink refused')
    if ps.st_uid==uid: raise RuntimeError('service-owned journal ancestor refused')
    p=permissions(parent,ps)
    if p&3==3 and (not ps.st_mode&stat.S_ISVTX or ps.st_uid==uid or cs.st_uid==uid): raise RuntimeError('service can replace journal ancestor')
    parent=child
try: s=os.lstat(path)
except FileNotFoundError: s=None
if s is not None and (s.st_uid==uid or permissions(path,s)&2 or (stat.S_ISREG(s.st_mode) and s.st_nlink!=1)): raise RuntimeError('service controls caller destination')
if private and (s.st_uid!=os.geteuid() or not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or permissions(path,s)&2): raise RuntimeError('private caller journal required')
`;
export async function assertCallerRunAsWritePath(path: string, identities: RunAsIdentity[], options: { privateFile?: boolean } = {}): Promise<void> {
  for (const identity of identities) {
    const { stdout } = await exec("/usr/bin/id", ["-G", identity.user], { timeout: 10_000 });
    const groups = stdout.trim().split(/\s+/);
    if (groups.some((group) => !/^\d+$/.test(group))) throw new Error("Invalid run-as service groups.");
    try { await exec("/usr/bin/python3", ["-I", "-c", callerWriteTrustScript, resolve(path), String(identity.uid), groups.join(","), options.privateFile ? "private" : "destination"], { timeout: 10_000, maxBuffer: 4096 }); }
    catch { throw new Error("Caller write destination must be immutable to every service identity, including through ancestors and ACLs."); }
  }
}
