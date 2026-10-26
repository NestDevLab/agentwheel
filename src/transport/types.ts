import type { RunAsIdentity } from "./run-as-identity.js";
export type TransportKind = "local" | "ssh" | "local-run-as";

export interface TargetTransport {
  kind: TransportKind;
  description: string;
  homeRoot?: string;
  runAsIdentity?: RunAsIdentity;
  prepareApply?(): Promise<void>;
  validateOpenClawConfig?(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  mkdirExclusive(path: string): Promise<void>;
  hashPath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  ownershipSnapshot?(path: string): Promise<string>;
  ownershipObservation?(path: string): Promise<{ kind: "file" | "dir"; snapshotDigest: string }>;
  listDir(path: string): Promise<string[]>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  writeJsonAtomic(path: string, data: unknown): Promise<void>;
  atomicCopy(source: string, dest: string, kind: "file" | "dir", expectedHash?: string): Promise<void>;
  copyWithin?(source: string, dest: string, kind: "file" | "dir"): Promise<void>;
  rm(path: string): Promise<void>;
  execFile?(command: string, args: string[], options?: { cwd?: string }): Promise<string | void>;
}

export interface SshTransportConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}
