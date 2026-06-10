import type { ArtifactType } from "../model/artifact.js";
import { readWorkspaceConfig, writeWorkspaceConfig, type WorkspaceTrust } from "../model/workspace.js";
import type { GraphLock } from "../model/graph-lock.js";
import type { ResolvedGraph } from "../resolve/graph.js";

export interface NormalizedTrustPolicy {
  allow: string[];
  acceptedSources: string[];
  denyArtifactTypes: ArtifactType[];
  requireReviewForTransitive: boolean;
}

export interface TrustEvaluation {
  promptSources: string[];
  persistSources: string[];
}

export function normalizeTrustPolicy(policy: WorkspaceTrust | undefined): NormalizedTrustPolicy {
  return {
    allow: sortedUnique(policy?.allow ?? []),
    acceptedSources: sortedUnique(policy?.acceptedSources ?? []),
    denyArtifactTypes: sortedUnique(policy?.denyArtifactTypes ?? []) as ArtifactType[],
    requireReviewForTransitive: policy?.requireReviewForTransitive ?? true,
  };
}

export function evaluateTransitiveTrust(
  graph: ResolvedGraph,
  previousLock: GraphLock | undefined,
  policy: NormalizedTrustPolicy,
  cliTrustPatterns: string[],
  yes: boolean,
): TrustEvaluation {
  const trusted = new Set([
    ...(previousLock?.canonical.nodes ?? []).map((node) => node.normalizedSource),
    ...policy.acceptedSources,
  ]);
  const patterns = [...policy.allow, ...cliTrustPatterns];
  const unknown = [...new Set(graph.rawNodes
    .filter((raw) => raw.depth > 0)
    .map((raw) => raw.node.normalizedSource)
    .filter((source) => !trusted.has(source))
    .filter((source) => !patterns.some((pattern) => matchesGlob(source, pattern))))].sort();

  if (unknown.length === 0) return { promptSources: [], persistSources: [] };
  if (policy.requireReviewForTransitive === false) return { promptSources: [], persistSources: [] };
  if (yes) return { promptSources: [], persistSources: unknown };
  return { promptSources: unknown, persistSources: unknown };
}

export function assertTrustArtifactPolicy(graph: ResolvedGraph, policy: NormalizedTrustPolicy): void {
  const denied = new Set(policy.denyArtifactTypes);
  if (denied.size === 0) return;
  const violations: string[] = [];
  for (const raw of graph.rawNodes) {
    if (raw.depth === 0) continue;
    for (const selector of raw.node.selected) {
      const type = selector.slice(0, selector.indexOf("/")) as ArtifactType;
      if (!denied.has(type)) continue;
      violations.push(`${raw.node.id}:${selector}`);
    }
  }
  if (violations.length === 0) return;
  throw new Error(
    `Trust policy denied dependency artifact types via trust.denyArtifactTypes: `
    + `${[...denied].sort().join(", ")}\n${violations.map((item) => `- ${item}`).join("\n")}`,
  );
}

export async function rememberTrustedSources(workspaceRoot: string, sources: string[]): Promise<string[]> {
  const unique = sortedUnique(sources);
  if (unique.length === 0) return [];
  const config = await readWorkspaceConfig(workspaceRoot);
  const trust = config.trust ?? {};
  const acceptedSources = sortedUnique([...(trust.acceptedSources ?? []), ...unique]);
  await writeWorkspaceConfig(workspaceRoot, {
    ...config,
    trust: {
      ...trust,
      acceptedSources,
    },
  });
  return unique.filter((source) => !(trust.acceptedSources ?? []).includes(source));
}

export async function forgetTrustedSources(workspaceRoot: string, pattern: string): Promise<string[]> {
  const config = await readWorkspaceConfig(workspaceRoot);
  const trust = config.trust ?? {};
  const acceptedSources = trust.acceptedSources ?? [];
  const removed = acceptedSources.filter((source) => matchesGlob(source, pattern));
  if (removed.length === 0) return [];
  await writeWorkspaceConfig(workspaceRoot, {
    ...config,
    trust: {
      ...trust,
      acceptedSources: acceptedSources.filter((source) => !matchesGlob(source, pattern)),
    },
  });
  return removed;
}

export function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
