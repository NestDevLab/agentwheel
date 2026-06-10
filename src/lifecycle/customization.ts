import { appendFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { loadAdapterConfig } from "../model/adapter.js";
import { artifactTypeSchema, type ArtifactType } from "../model/artifact.js";
import { readWorkspaceConfig, type WorkspacePackage } from "../model/workspace.js";
import { graphNodeId } from "../resolve/graph.js";
import { normalizeDependencySource } from "../resolve/identity.js";
import { getSourceDriver } from "../source/index.js";
import { stageSource, type StagedBundle } from "../staging/staging.js";
import { hashPath } from "../utils/fs.js";

export interface RememberResult {
  overlayPath: string;
}

export interface EjectResult {
  packageName: string;
  packageIdentity: string;
  packageVersion?: string;
  graphNodeId: string;
  type: ArtifactType;
  name: string;
  ejectedPath: string;
}

export async function remember(workspaceRoot: string, runtime: string, text: string): Promise<RememberResult> {
  const overlayPath = join(workspaceRoot, ".agentwheel", "overlays", runtime, "instructions.local.md");
  await mkdir(dirname(overlayPath), { recursive: true });
  await appendFile(overlayPath, `${text.trim()}\n`, "utf8");
  return { overlayPath };
}

export async function ejectArtifact(workspaceRoot: string, item: string): Promise<EjectResult> {
  const parsed = parseEjectItem(item);
  const config = await readWorkspaceConfig(workspaceRoot);
  const packageCandidates = config.packages.filter((candidate) => candidate.name === parsed.packageName || candidate.name === parsed.packageIdentity);
  if (packageCandidates.length === 0) {
    throw new Error(`Package not configured: ${parsed.packageName}`);
  }

  const candidates: EjectCandidate[] = [];

  try {
    for (const pkg of packageCandidates) {
      candidates.push(await stageEjectCandidate(workspaceRoot, pkg));
    }
    const candidate = selectEjectCandidate(parsed, candidates);
    const artifact = candidate.bundle.artifacts.find((item) => item.type === parsed.type && item.name === parsed.name);
    if (!artifact) {
      throw new Error(`Artifact not found: ${item}`);
    }
    const ejectedIdentity = parsed.packageIdentity === parsed.packageName
      ? parsed.packageIdentity
      : candidate.nodeId === parsed.packageIdentity
      ? candidate.nodeId
      : `${candidate.packageName}@${candidate.packageVersion}`;
    const ejectedPath = join(workspaceRoot, ".agentwheel", "ejected", ...ejectedIdentity.split("/"), parsed.type, parsed.name);
    await mkdir(dirname(ejectedPath), { recursive: true });
    await rm(ejectedPath, { recursive: true, force: true });
    await cp(artifact.stagedPath ?? artifact.sourcePath, ejectedPath, { recursive: artifact.kind === "dir", dereference: true });
    return {
      ...parsed,
      packageName: candidate.packageName,
      packageIdentity: ejectedIdentity,
      packageVersion: candidate.packageVersion,
      graphNodeId: candidate.nodeId,
      ejectedPath,
    };
  } finally {
    await Promise.all(candidates.map((candidate) => rm(candidate.bundle.root, { recursive: true, force: true })));
  }
}

export function parseEjectItem(item: string): { packageName: string; packageIdentity: string; packageVersion?: string; type: ArtifactType; name: string } {
  const parts = item.split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Eject item must be <package>/<type>/<name>");
  }
  const name = parts.pop()!;
  const type = artifactTypeSchema.parse(parts.pop()!);
  const packageIdentity = parts.join("/");
  const { packageName, packageVersion } = splitPackageVersion(packageIdentity);
  return { packageName, packageIdentity, packageVersion, type, name };
}

function splitPackageVersion(identity: string): { packageName: string; packageVersion?: string } {
  const slash = identity.lastIndexOf("/");
  const at = identity.lastIndexOf("@");
  if (at <= slash) return { packageName: identity };
  return { packageName: identity.slice(0, at), packageVersion: identity.slice(at + 1) };
}

interface EjectCandidate {
  pkg: WorkspacePackage;
  bundle: StagedBundle;
  nodeId: string;
  packageName: string;
  packageVersion: string;
}

async function stageEjectCandidate(workspaceRoot: string, pkg: WorkspacePackage): Promise<EjectCandidate> {
  const normalized = await normalizeDependencySource(pkg.source, {
    declaringPackageRoot: workspaceRoot,
    workspaceRoot,
    ref: pkg.requestedRef,
  });
  const driver = getSourceDriver(normalized.driver);
  const adapter = pkg.adapterConfig ? await loadAdapterConfig(pkg.adapterConfig) : getAdapter(pkg.adapter);
  const bundle = await stageSource(driver, normalized.source, {
    adapter,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: pkg.mode,
    ref: normalized.requestedRef ?? pkg.requestedRef,
  });
  const packageName = bundle.source.packageName ?? pkg.name;
  const packageVersion = bundle.source.packageVersion ?? "0.0.0";
  const sourceHash = bundle.source.sourceHash ?? await hashPath(bundle.source.resolvedPath);
  return {
    pkg,
    bundle,
    nodeId: graphNodeId(packageName, packageVersion, normalized.normalizedSource, bundle.source.resolvedCommit, sourceHash),
    packageName,
    packageVersion,
  };
}

function selectEjectCandidate(
  parsed: ReturnType<typeof parseEjectItem>,
  candidates: EjectCandidate[],
): EjectCandidate {
  const exactNode = candidates.filter((candidate) => candidate.nodeId === parsed.packageIdentity);
  if (exactNode.length === 1) return exactNode[0]!;

  if (parsed.packageVersion) {
    const versioned = candidates.filter((candidate) =>
      candidate.packageName === parsed.packageName && candidate.packageVersion === parsed.packageVersion);
    if (versioned.length === 1) return versioned[0]!;
    if (versioned.length > 1) {
      throw ambiguousEjectError(parsed, versioned, `${parsed.packageName}@${parsed.packageVersion}`);
    }
    throw new Error(
      `Configured package ${parsed.packageName} did not resolve requested identity ${parsed.packageIdentity}. `
      + `Use one of: ${ejectCommands(candidates, parsed).join(", ")}`,
    );
  }

  const shorthand = candidates.filter((candidate) => candidate.packageName === parsed.packageName || candidate.pkg.name === parsed.packageName);
  if (shorthand.length === 1) return shorthand[0]!;
  if (shorthand.length > 1) throw ambiguousEjectError(parsed, shorthand, parsed.packageName);
  throw new Error(`Package not configured: ${parsed.packageName}`);
}

function ambiguousEjectError(parsed: ReturnType<typeof parseEjectItem>, candidates: EjectCandidate[], identity: string): Error {
  return new Error(
    `Ambiguous eject shorthand for ${identity}/${parsed.type}/${parsed.name}; use one of: `
    + ejectCommands(candidates, parsed).join(", "),
  );
}

function ejectCommands(candidates: EjectCandidate[], parsed: ReturnType<typeof parseEjectItem>): string[] {
  const commands = candidates.flatMap((candidate) => [
    `agentwheel eject ${candidate.packageName}@${candidate.packageVersion}/${parsed.type}/${parsed.name}`,
    `agentwheel eject ${candidate.nodeId}/${parsed.type}/${parsed.name}`,
  ]);
  return [...new Set(commands)].sort((a, b) => a.localeCompare(b));
}
