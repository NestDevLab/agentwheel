import type { SourceLock } from "../model/manifest.js";
import type { WorkspacePackage } from "../model/workspace.js";

export interface UpdateDecision {
  shouldUpdate: boolean;
  reason: string;
}

export function shouldUpdatePackage(pkg: WorkspacePackage, lock?: SourceLock): UpdateDecision {
  if (!lock) {
    return { shouldUpdate: true, reason: "no source lock" };
  }
  if (pkg.mode === "tracking") {
    return { shouldUpdate: true, reason: "tracking source" };
  }
  if (lock.source !== pkg.source) {
    return { shouldUpdate: true, reason: "pinned source changed" };
  }
  if (lock.requestedRef !== pkg.requestedRef) {
    return { shouldUpdate: true, reason: "pinned ref changed" };
  }
  return { shouldUpdate: false, reason: "pinned source unchanged" };
}
