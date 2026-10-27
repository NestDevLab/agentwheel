import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Reject code the service can replace, including through writable ancestors. */
export function trustedRunAsCode(path: string, uid: number, groups: readonly number[], label: string): string {
  if (!isAbsolute(path)) throw new Error(`Run-as ${label} path must be absolute.`);
  const canonical = realpathSync(path);
  let child = canonical;
  let info = statSync(child);
  if (!info.isFile() || info.uid === uid || (info.mode & 0o022) !== 0) throw new Error(`Run-as ${label} must be an immutable regular file.`);
  while (child !== dirname(child)) {
    const parent = dirname(child), parentInfo = statSync(parent);
    // POSIX ACL write grants require a writable group-class mask. Reject it
    // regardless of owning group, covering named-user/group ACL entries too.
    const writable = (parentInfo.mode & 0o002) !== 0 || (parentInfo.mode & 0o020) !== 0;
    // Sticky directories protect entries owned by another user, unless the
    // service itself owns the directory (and can remove any entry).
    if (parentInfo.uid === uid || (writable && !((parentInfo.mode & 0o1000) && info.uid !== uid))) {
      throw new Error(`Run-as ${label} has a service-writable ancestor.`);
    }
    child = parent; info = parentInfo;
  }
  return canonical;
}

/** The validator and its package dependencies must come from a trusted install. */
export function trustedOpenClawEntry(root: string, uid: number, groups: readonly number[]): string {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error("OpenClaw validator root must be canonical and absolute.");
  const entry = trustedRunAsCode(join(root, "openclaw.mjs"), uid, groups, "OpenClaw validator");
  let count = 0;
  const visit = (path: string): void => {
    if (++count > 100_000) throw new Error("OpenClaw validator installation exceeds the trust-check limit.");
    const info = lstatSync(path);
    if (info.uid === uid || (info.mode & 0o022) !== 0 && !info.isSymbolicLink()) throw new Error("OpenClaw validator installation is service-writable.");
    if (info.isSymbolicLink()) {
      const resolved = realpathSync(path), rel = relative(root, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("OpenClaw validator dependency escapes its trusted installation.");
      return; // The resolved destination is visited through the canonical tree.
    }
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (!info.isFile()) throw new Error("OpenClaw validator installation contains a special file.");
  };
  visit(root);
  return entry;
}
