export type TransportKind = "local" | "ssh";

export interface TargetTransport {
  kind: TransportKind;
  description: string;
  pathExists(path: string): Promise<boolean>;
  mkdirExclusive(path: string): Promise<void>;
  hashPath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  writeJsonAtomic(path: string, data: unknown): Promise<void>;
  atomicCopy(source: string, dest: string, kind: "file" | "dir"): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface SshTransportConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}
