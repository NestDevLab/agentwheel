import { appendFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { loadAdapterConfig } from "../model/adapter.js";
import { artifactTypeSchema, type ArtifactType } from "../model/artifact.js";
import { readWorkspaceConfig } from "../model/workspace.js";
import { getSourceDriver } from "../source/index.js";
import { stageSource } from "../staging/staging.js";

export interface RememberResult {
  overlayPath: string;
}

export interface EjectResult {
  packageName: string;
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
  const pkg = config.packages.find((candidate) => candidate.name === parsed.packageName);
  if (!pkg) {
    throw new Error(`Package not configured: ${parsed.packageName}`);
  }

  const driver = getSourceDriver(pkg.driver);
  const adapter = pkg.adapterConfig ? await loadAdapterConfig(pkg.adapterConfig) : getAdapter(pkg.adapter);
  const bundle = await stageSource(driver, pkg.source, {
    adapter,
    cacheRoot: join(workspaceRoot, ".agentwheel", "cache"),
    mode: pkg.mode,
  });

  try {
    const artifact = bundle.artifacts.find((candidate) => candidate.type === parsed.type && candidate.name === parsed.name);
    if (!artifact) {
      throw new Error(`Artifact not found: ${item}`);
    }
    const ejectedPath = join(workspaceRoot, ".agentwheel", "ejected", ...parsed.packageName.split("/"), parsed.type, parsed.name);
    await mkdir(dirname(ejectedPath), { recursive: true });
    await rm(ejectedPath, { recursive: true, force: true });
    await cp(artifact.stagedPath ?? artifact.sourcePath, ejectedPath, { recursive: artifact.kind === "dir", dereference: true });
    return { ...parsed, ejectedPath };
  } finally {
    await rm(bundle.root, { recursive: true, force: true });
  }
}

export function parseEjectItem(item: string): { packageName: string; type: ArtifactType; name: string } {
  const parts = item.split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Eject item must be <package>/<type>/<name>");
  }
  const name = parts.pop()!;
  const type = artifactTypeSchema.parse(parts.pop()!);
  const packageName = parts.join("/");
  return { packageName, type, name };
}
