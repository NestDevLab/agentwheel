import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeArtifactSelectors } from "../model/selection.js";
import {
  isCompositeWorkspaceProfile,
  packagesForTarget,
  readWorkspaceConfig,
  workspaceConfigSchema,
  type WorkspaceConfig,
  type WorkspaceConfigInput,
  type WorkspacePackage,
} from "../model/workspace.js";
import { RegistryClient } from "../registry/client.js";
import { ArtifactCollisionError } from "../resolve/collision.js";
import { resolveDependencyGraph, type GraphRootRequest } from "../resolve/graph.js";
import { renderGraphForTarget } from "../resolve/render.js";
import { resolveProfileRuntimeTarget } from "../runtime/target.js";
import { pathExists } from "../utils/fs.js";

interface CollisionScope {
  profiles: Set<string>;
  runtime?: string;
  packages: Map<string, WorkspacePackage>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collisionScopes(config: WorkspaceConfig, workspaceRoot: string, warn: (message: string) => void): Map<string, CollisionScope> {
  const scopes = new Map<string, CollisionScope>();
  const profiles = Object.entries(config.profiles).filter(([, profile]) => !isCompositeWorkspaceProfile(profile));
  if (profiles.length === 0) {
    scopes.set("workspace", { profiles: new Set(["workspace"]), packages: new Map(config.packages.map((pkg) => [pkg.name, pkg])) });
    return scopes;
  }
  for (const [name, profile] of profiles) {
    if (isCompositeWorkspaceProfile(profile)) continue;
    for (const runtime of profile.runtimes) {
      let target;
      try {
        target = resolveProfileRuntimeTarget(runtime, config, workspaceRoot);
      } catch (error) {
        warn(`Pin collision check skipped a runtime of profile ${name}: ${errorMessage(error)}`);
        continue;
      }
      for (const pkg of packagesForTarget(config.packages, target)) {
        // same split as the install plan: these fields send a package to its own state
        const key = JSON.stringify([
          target.adapter,
          pkg.installationType ?? target.installationType ?? "local",
          target.adapterConfig ?? pkg.adapterConfig,
          target.adapterModule ?? pkg.adapterModule,
        ]);
        const scope = scopes.get(key) ?? { profiles: new Set<string>(), runtime: target.adapter, packages: new Map() };
        scope.profiles.add(name);
        scope.packages.set(pkg.name, pkg);
        scopes.set(key, scope);
      }
    }
  }
  return scopes;
}

function samePackages(left: CollisionScope, right: CollisionScope): boolean {
  return JSON.stringify(rootsFor(left)) === JSON.stringify(rootsFor(right));
}

function rootsFor(scope: CollisionScope): GraphRootRequest[] {
  return [...scope.packages.values()].map((pkg) => ({
    rootId: pkg.name,
    source: pkg.source,
    mode: pkg.mode,
    version: pkg.version,
    ref: pkg.requestedRef,
    select: pkg.selection ? undefined : normalizeArtifactSelectors(pkg.select, pkg.skills),
    selection: pkg.selection,
    aliases: pkg.aliases,
    overrides: pkg.overrides,
    includeSuggestions: pkg.withSuggestions === true,
    suggestionAliases: pkg.suggestions,
    useLock: false,
  }));
}

async function collisionIn(scope: CollisionScope, workspaceRoot: string, cacheRoot: string): Promise<ArtifactCollisionError | undefined> {
  try {
    const graph = await resolveDependencyGraph(rootsFor(scope), {
      workspaceRoot,
      cacheRoot,
      // a first registry download costs a minute and runs under the mutation lock
      registryClient: new RegistryClient({
        workspaceRoot,
        offline: true,
        offlineLabel: "Pin collision check",
        offlineHint: "It only reads the local registry cache.",
      }),
      runtime: scope.runtime,
      allowEmptyRoots: true,
    });
    const bundle = await renderGraphForTarget(graph);
    await rm(bundle.root, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    if (error instanceof ArtifactCollisionError) return error;
    throw error;
  }
}

// Only a collision the proposal adds is refused: a pin must stay usable to repair
// a config that already collides, and an unreachable source says nothing about one.
export async function refuseNewPinCollisions(
  workspaceRoot: string,
  proposedInput: WorkspaceConfigInput,
  warn: (message: string) => void,
): Promise<void> {
  const proposed = collisionScopes(workspaceConfigSchema.parse(proposedInput), workspaceRoot, warn);
  const current = collisionScopes(await readWorkspaceConfig(workspaceRoot), workspaceRoot, () => undefined);
  const refused: string[] = [];
  const skipped = new Set<string>();
  // pin only ever writes the config, so a workspace that never installed stays that way
  const sharedCache = join(workspaceRoot, ".agentwheel", "cache");
  const temporaryCache = await pathExists(sharedCache) ? undefined : await mkdtemp(join(tmpdir(), "agentwheel-pin-preflight-"));
  const cacheRoot = temporaryCache ?? sharedCache;
  try {
    // Parallel because this runs while the mutation lock is held.
    await Promise.all([...proposed].map(async ([key, scope]) => {
      const label = [...scope.profiles].sort().join(", ");
      const before = current.get(key);
      if (before && samePackages(before, scope)) return;
      let collision: ArtifactCollisionError | undefined;
      try {
        collision = await collisionIn(scope, workspaceRoot, cacheRoot);
      } catch (error) {
        skipped.add(errorMessage(error));
        return;
      }
      if (!collision) return;
      const existing = before ? await collisionIn(before, workspaceRoot, cacheRoot).catch(() => undefined) : undefined;
      const added = collision.collisions.filter((name) => !existing?.collisions.includes(name));
      if (added.length > 0) refused.push(`${label}: ${collision.message}`);
      else warn(`Pin leaves an existing collision in place for ${label}: ${collision.message}`);
    }));
  } finally {
    if (temporaryCache) await rm(temporaryCache, { recursive: true, force: true });
  }
  refused.sort();
  if (refused.length > 0) {
    throw new Error(`Pin refused, nothing was written. It would break install for profile ${refused.join(" Profile ")}`);
  }
  for (const message of skipped) warn(`Pin collision check could not finish: ${message}`);
}
