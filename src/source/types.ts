import type { Artifact } from "../model/artifact.js";

export interface ResolvedSource {
  driver: string;
  source: string;
  resolvedPath: string;
  packageName?: string;
  packageVersion?: string;
  mode?: "pinned" | "tracking";
  requestedRef?: string;
  resolvedCommit?: string;
  sourceHash?: string;
}

export interface ScanFinding {
  level: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

export interface SourceDriver {
  readonly name: string;
  resolve(source: string, options?: SourceResolveOptions): Promise<ResolvedSource>;
  list(resolved: ResolvedSource): Promise<Artifact[]>;
  fetch(resolved: ResolvedSource): Promise<ResolvedSource>;
  scan(resolved: ResolvedSource): Promise<ScanResult>;
  translate(resolved: ResolvedSource): Promise<ResolvedSource>;
  export(resolved: ResolvedSource): Promise<ResolvedSource>;
}

export interface SourceResolveOptions {
  cacheRoot?: string;
  mode?: "pinned" | "tracking";
  ref?: string;
}
