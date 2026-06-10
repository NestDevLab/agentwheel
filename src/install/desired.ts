import type { Artifact } from "../model/artifact.js";
import type { DependencyRole } from "../model/manifest.js";

export interface DesiredEntryMeta {
  graphNodeId?: string;
  installName?: string;
  logicalSelector?: string;
  dependencyRole?: DependencyRole;
  owners: string[];
  composedFrom?: { selector: string; hash: string }[];
}

export type DesiredArtifact = Artifact & {
  meta: DesiredEntryMeta;
};

export function normalizeOwners(owners: string[]): string[] {
  const normalized = [...new Set(owners.map((owner) => owner.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) {
    throw new Error("Desired artifacts must declare at least one owner");
  }
  return normalized;
}
