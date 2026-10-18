import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export interface RunAsIdentity {
  user: string;
  uid: number;
  gid: number;
  home: string;
  root: string;
}

export function resolveRunAsIdentity(
  user: string,
  root: string,
  getent: (user: string) => string = (name) => execFileSync("/usr/bin/getent", ["passwd", name], { encoding: "utf8" }),
): RunAsIdentity {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(user) || user === "root") {
    throw new Error(`Invalid local run-as account '${user}'.`);
  }
  if (!isAbsolute(root) || resolve(root) !== root || root === parse(root).root) {
    throw new Error(`Local run-as root must be an absolute normalized directory: ${root}`);
  }
  let line: string;
  try { line = getent(user).trim(); }
  catch { throw new Error(`Local run-as account '${user}' is unknown (getent passwd failed).`); }
  const fields = line.split(":");
  if (fields.length !== 7 || fields[0] !== user) throw new Error(`Invalid passwd record for local run-as account '${user}'.`);
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5]!;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0 || !isAbsolute(home) || resolve(home) !== home) {
    throw new Error(`Invalid UID, GID or home for local run-as account '${user}'.`);
  }
  assertNoSymlinkPath(home);
  if (realpathSync(home) !== home || !lstatSync(home).isDirectory()) {
    throw new Error(`Local run-as home ${home} must be a real directory.`);
  }
  assertNoSymlinkPath(root);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || lstatSync(root).uid !== uid) {
    throw new Error(`Local run-as root ${root} must be a real directory owned by UID ${uid}.`);
  }
  return { user, uid, gid, home, root };
}

function assertNoSymlinkPath(path: string): void {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Local run-as root contains a symlink: ${current}`);
  }
}
