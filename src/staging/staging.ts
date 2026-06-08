import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Artifact } from "../model/artifact.js";
import type { SourceLock } from "../model/manifest.js";
import type { AdapterConfig } from "../model/adapter.js";
import type { ResolvedSource, SourceDriver, SourceResolveOptions } from "../source/types.js";
import { hashPath } from "../utils/fs.js";
import { applyCustomizations } from "./customize.js";

export interface StagedBundle {
  root: string;
  source: ResolvedSource;
  artifacts: Artifact[];
  sourceLock: SourceLock;
}

export interface StageOptions extends SourceResolveOptions {
  workspaceRoot?: string;
  adapter?: AdapterConfig;
}

export async function stageSource(driver: SourceDriver, source: string, options: StageOptions = {}): Promise<StagedBundle> {
  const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(source, options))));
  const artifacts = await driver.list(resolved);
  const root = await mkdtemp(join(tmpdir(), "agentweave-stage-"));
  const stagedArtifacts: Artifact[] = [];

  for (const artifact of artifacts) {
    const stagedPath = join(root, artifact.relativePath);
    await mkdir(dirname(stagedPath), { recursive: true });
    await cp(artifact.sourcePath, stagedPath, { recursive: artifact.kind === "dir", dereference: true });
    stagedArtifacts.push({
      ...artifact,
      stagedPath,
      hash: await hashPath(stagedPath),
      channel: artifact.channel ?? "managed",
    });
  }

  const finalArtifacts = options.workspaceRoot && options.adapter
    ? await applyCustomizations(stagedArtifacts, {
      workspaceRoot: options.workspaceRoot,
      adapter: options.adapter,
      stageRoot: root,
      packageName: resolved.packageName,
    })
    : stagedArtifacts;

  const generatedAt = new Date().toISOString();
  return {
    root,
    source: resolved,
    artifacts: finalArtifacts,
    sourceLock: {
      version: 1,
      driver: resolved.driver,
      source: resolved.source,
      resolvedPath: resolved.resolvedPath,
      packageName: resolved.packageName,
      packageVersion: resolved.packageVersion,
      mode: resolved.mode ?? "pinned",
      requestedRef: resolved.requestedRef,
      resolvedCommit: resolved.resolvedCommit,
      sourceHash: resolved.sourceHash,
      generatedAt,
      artifacts: finalArtifacts.map((artifact) => ({
        type: artifact.type,
        name: artifact.name,
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        hash: artifact.hash,
      })),
    },
  };
}
