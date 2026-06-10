import type { ArtifactType } from "../model/artifact.js";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { WorkspaceTrust } from "../model/workspace.js";
import type { GraphLock } from "../model/graph-lock.js";
import type { ResolvedGraph } from "../resolve/graph.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

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

const trustStoreSchema = z.object({
  version: z.literal(1),
  acceptedSources: z.array(z.string().min(1)).default([]),
});

type TrustStore = z.infer<typeof trustStoreSchema>;

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

export async function readTrustedSources(_workspaceRoot?: string, storePath = defaultTrustStorePath()): Promise<string[]> {
  return (await readTrustStore(storePath)).acceptedSources;
}

export async function rememberTrustedSources(_workspaceRoot: string, sources: string[], storePath = defaultTrustStorePath()): Promise<string[]> {
  const unique = sortedUnique(sources);
  if (unique.length === 0) return [];
  const store = await readTrustStore(storePath);
  const acceptedSources = sortedUnique([...store.acceptedSources, ...unique]);
  await writeTrustStore(storePath, { version: 1, acceptedSources });
  return unique.filter((source) => !store.acceptedSources.includes(source));
}

export async function forgetTrustedSources(_workspaceRoot: string, pattern: string, storePath = defaultTrustStorePath()): Promise<string[]> {
  const store = await readTrustStore(storePath);
  const acceptedSources = store.acceptedSources;
  const removed = acceptedSources.filter((source) => matchesGlob(source, pattern));
  if (removed.length === 0) return [];
  await writeTrustStore(storePath, {
    version: 1,
    acceptedSources: acceptedSources.filter((source) => !matchesGlob(source, pattern)),
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

async function readTrustStore(path: string): Promise<TrustStore> {
  if (!(await pathExists(path))) return { version: 1, acceptedSources: [] };
  return trustStoreSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function writeTrustStore(path: string, store: TrustStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, trustStoreSchema.parse(store));
}

function defaultTrustStorePath(): string {
  return process.env.AGENTWHEEL_TRUST_STORE ?? join(homedir(), ".agentwheel", "trust.json");
}
