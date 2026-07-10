import { adapterTargetSupport, type AdapterConfig } from "../model/adapter.js";
import type { Artifact } from "../model/artifact.js";
import { artifactSelectorKey } from "../model/selection.js";

export interface AdapterTargetFilterOptions {
  warn?: (message: string) => void;
}

export function filterArtifactsByAdapterTargets<T extends Pick<Artifact, "type" | "name">>(
  artifacts: T[],
  adapter: AdapterConfig,
  installationType: string,
  options: AdapterTargetFilterOptions = {},
): T[] {
  const skipped: Array<{
    selector: string;
    artifactType: string;
    support: Exclude<ReturnType<typeof adapterTargetSupport>, { ok: true }>;
  }> = [];
  const installable = artifacts.filter((artifact) => {
    if (artifact.type === "fragments") return true;
    const support = adapterTargetSupport(adapter, artifact.type, installationType);
    if (support.ok) return true;

    const selector = artifactSelectorKey(artifact);
    skipped.push({ selector, artifactType: artifact.type, support });
    options.warn?.(skipWarning(selector, adapter, installationType, artifact.type, support));
    return false;
  });

  const before = artifacts.filter((artifact) => artifact.type !== "fragments");
  const after = installable.filter((artifact) => artifact.type !== "fragments");
  if (before.length > 0 && after.length === 0) {
    throw new Error(
      `${unsupportedSummary(adapter, installationType, skipped)} No installable artifacts remain for adapter ${adapter.name}/${installationType} after skipping unsupported targets: ${skipped.map((item) => item.selector).join(", ")}`,
    );
  }

  return installable;
}

function unsupportedSummary(
  adapter: AdapterConfig,
  installationType: string,
  skipped: Array<{
    artifactType: string;
    support: Exclude<ReturnType<typeof adapterTargetSupport>, { ok: true }>;
  }>,
): string {
  const types = [...new Set(skipped.map((item) => item.artifactType))].sort((a, b) => a.localeCompare(b));
  if (types.length !== 1) {
    return `Adapter ${adapter.name} does not support selected artifact targets for installation type '${installationType}'.`;
  }

  const type = types[0]!;
  const supported = [...new Set(skipped.flatMap((item) => item.support.supportedInstallationTypes))].sort((a, b) => a.localeCompare(b));
  if (supported.length > 0) {
    return `Adapter ${adapter.name} does not support ${type} artifacts for installation type '${installationType}'. Supported: ${supported.join(", ")}.`;
  }
  return `Adapter ${adapter.name} does not support ${type} artifacts for any installation type.`;
}

function skipWarning(
  selector: string,
  adapter: AdapterConfig,
  installationType: string,
  artifactType: string,
  support: Exclude<ReturnType<typeof adapterTargetSupport>, { ok: true }>,
): string {
  if (support.reason === "adapter-target-disabled") {
    return `skip ${selector} (selected but adapter-target-disabled: ${adapter.name}/${installationType} disables ${artifactType})`;
  }

  const suffix = support.supportedInstallationTypes.length > 0
    ? `; supported installation types: ${support.supportedInstallationTypes.join(", ")}`
    : "";
  return `skip ${selector} (selected but adapter-target-unsupported: ${adapter.name}/${installationType} has no enabled target for ${artifactType}${suffix})`;
}
