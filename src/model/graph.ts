import type { Artifact } from "./artifact.js";
import type { GraphLock } from "./graph-lock.js";

export type GraphNodeId = string; // `${name}@${version}+${sourceDigest12}`

export interface ResolvedNode {
  id: GraphNodeId;
  name: string;
  version: string;
  source: string;
  normalizedSource: string;
  driver: string;
  requestedRef?: string;
  resolvedCommit?: string;
  sourceHash: string;
  mode: "pinned" | "tracking";
  requiredBy: string[];
  selected: string[];
}

export interface ResolvedArtifact extends Artifact {
  graphNodeId: GraphNodeId;
  dependencyRole: "root" | "direct" | "transitive" | "fragment";
  installName: string;
  logicalSelector: string;
  owners: string[];
}

export interface ResolvedGraphBundle {
  root: string;
  nodes: ResolvedNode[];
  artifacts: ResolvedArtifact[];
  graphLock: GraphLock;
}
