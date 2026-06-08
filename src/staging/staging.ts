import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Artifact } from "../model/artifact.js";
import type { SourceLock } from "../model/manifest.js";
import type { ResolvedSource, SourceDriver } from "../source/types.js";
import { hashPath } from "../utils/fs.js";

export interface StagedBundle {
  root: string;
  source: ResolvedSource;
  artifacts: Artifact[];
  sourceLock: SourceLock;
}

export async function stageSource(driver: SourceDriver, source: string): Promise<StagedBundle> {
  const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(source))));
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
    });
  }

  const generatedAt = new Date().toISOString();
  return {
    root,
    source: resolved,
    artifacts: stagedArtifacts,
    sourceLock: {
      version: 1,
      driver: resolved.driver,
      source: resolved.source,
      resolvedPath: resolved.resolvedPath,
      generatedAt,
      artifacts: stagedArtifacts.map((artifact) => ({
        type: artifact.type,
        name: artifact.name,
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        hash: artifact.hash,
      })),
    },
  };
}
