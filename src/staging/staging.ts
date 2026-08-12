import { chmod, cp, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Artifact, PackageAsset } from "../model/artifact.js";
import type { SourceLock } from "../model/manifest.js";
import type { AdapterConfig } from "../model/adapter.js";
import type { ResolvedSource, SourceDriver, SourceResolveOptions } from "../source/types.js";
import { hashPath, isIgnoredGeneratedEntry } from "../utils/fs.js";
import { expandMarkdownIncludes } from "../compose/markdown.js";
import { applyCustomizations, applyFragmentCustomizations } from "./customize.js";
import { renderClaudeSubagents } from "./claude-subagents.js";
import { renderCodexSubagents } from "./codex-subagents.js";
import { renderCopilotArtifacts } from "./copilot-artifacts.js";
import { renderOpenClawSubagents } from "./openclaw-subagents.js";
import { artifactSelectorKey, filterArtifactsBySelection, normalizeArtifactSelectors } from "../model/selection.js";

export interface StagedBundle {
  root: string;
  source: ResolvedSource;
  artifacts: Artifact[];
  sourceLock: SourceLock;
}

export interface RawStagedBundle {
  root: string;
  source: ResolvedSource;
  artifacts: Artifact[];
}

export interface StageOptions extends SourceResolveOptions {
  workspaceRoot?: string;
  adapter?: AdapterConfig;
  select?: string[];
  skills?: string[];
}

export async function stageSource(driver: SourceDriver, source: string, options: StageOptions = {}): Promise<StagedBundle> {
  return renderStagedBundle(await stageSourceRaw(driver, source, options), options);
}

export async function stageSourceRaw(driver: SourceDriver, source: string, options: SourceResolveOptions = {}): Promise<RawStagedBundle> {
  const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(source, options))));
  return stageResolvedSourceRaw(driver, resolved);
}

export async function stageResolvedSourceRaw(driver: SourceDriver, resolved: ResolvedSource): Promise<RawStagedBundle> {
  const artifacts = await driver.list(resolved);
  return stageResolvedArtifactsRaw(resolved, artifacts);
}

export async function stageResolvedArtifactsRaw(resolved: ResolvedSource, artifacts: Artifact[]): Promise<RawStagedBundle> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-stage-"));
  const stagedArtifacts: Artifact[] = [];

  for (const artifact of artifacts) {
    const stagedPath = join(root, artifact.relativePath);
    await mkdir(dirname(stagedPath), { recursive: true });
    await cp(artifact.sourcePath, stagedPath, {
      recursive: artifact.kind === "dir",
      dereference: true,
      filter: (path) => !isIgnoredGeneratedEntry(basename(path)),
    });
    await composeAssets(artifact, resolved.resolvedPath, stagedPath);
    stagedArtifacts.push({
      ...artifact,
      stagedPath,
      hash: await hashPath(stagedPath),
      channel: artifact.channel ?? "managed",
    });
  }

  return {
    root,
    source: resolved,
    artifacts: stagedArtifacts,
  };
}

export async function renderStagedBundle(bundle: RawStagedBundle, options: StageOptions = {}): Promise<StagedBundle> {
  const { root, source: resolved, artifacts: stagedArtifacts } = bundle;
  const preExpandedArtifacts = options.workspaceRoot && options.adapter
    ? await applyFragmentCustomizations(stagedArtifacts, {
      workspaceRoot: options.workspaceRoot,
      adapter: options.adapter,
      stageRoot: root,
      packageName: resolved.packageName,
    })
    : stagedArtifacts;

  const expandedArtifacts = await expandMarkdownIncludes(preExpandedArtifacts, root);
  const selectedArtifacts = filterArtifactsBySelection(expandedArtifacts, options.select, options.skills);
  const runtimeSelectedSet = new Set(normalizeArtifactSelectors(options.select, options.skills) ?? []);
  const runtimeArtifacts = options.adapter
    ? filterArtifactsByRuntime(selectedArtifacts, options.adapter.name, runtimeSelectedSet)
    : selectedArtifacts;
  const claudeRenderedArtifacts = await renderClaudeSubagents(runtimeArtifacts, root, options.adapter);
  const codexRenderedArtifacts = await renderCodexSubagents(claudeRenderedArtifacts, root, options.adapter);
  const openClawRenderedArtifacts = await renderOpenClawSubagents(codexRenderedArtifacts, root, options.adapter);
  const renderedArtifacts = await renderCopilotArtifacts(openClawRenderedArtifacts, root, options.adapter);

  const finalArtifacts = options.workspaceRoot && options.adapter
    ? await applyCustomizations(renderedArtifacts, {
      workspaceRoot: options.workspaceRoot,
      adapter: options.adapter,
      stageRoot: root,
      packageName: resolved.packageName,
    })
    : renderedArtifacts;

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
      cacheIdentity: resolved.cacheIdentity,
      sourceHash: resolved.sourceHash,
      generatedAt,
      artifacts: finalArtifacts.map((artifact) => ({
        type: artifact.type,
        name: artifact.name,
        relativePath: artifact.relativePath,
        kind: artifact.kind,
        hash: artifact.hash,
        format: artifact.format,
        composedFrom: artifact.composedFrom,
      })),
    },
  };
}

function filterArtifactsByRuntime(artifacts: Artifact[], adapterName: string, selectedSet: Set<string>): Artifact[] {
  return artifacts.filter((artifact) => {
    if (!artifact.runtimes?.length || artifact.runtimes.includes(adapterName)) return true;
    const selector = artifactSelectorKey(artifact);
    const reason = selectedSet.has(selector) ? "selected but not targeted" : "not targeted";
    console.warn(`skip (${reason}: runtimes=[${artifact.runtimes.join(",")}]) ${selector}`);
    return false;
  });
}

async function composeAssets(artifact: Artifact, packageRoot: string, stagedPath: string): Promise<void> {
  if (!artifact.assets?.length) return;
  if (artifact.kind !== "dir") {
    throw new Error(`Asset includes require a directory artifact: ${artifact.type}/${artifact.name}`);
  }
  for (const asset of artifact.assets) {
    const source = resolvePackagePath(packageRoot, asset.from);
    const dest = join(stagedPath, asset.into);
    await copyAsset(asset, source, dest);
  }
}

async function copyAsset(asset: PackageAsset, source: string, dest: string): Promise<void> {
  const sourceStats = await stat(source);
  if (sourceStats.isFile()) {
    if (matchesAny(basename(source), asset.include)) {
      await mkdir(dest, { recursive: true });
      await copyAssetFile(source, join(dest, basename(source)), asset);
    }
    return;
  }
  if (!sourceStats.isDirectory()) {
    throw new Error(`Asset include source is not a file or directory: ${source}`);
  }
  if (!asset.include?.length) {
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest, { recursive: true, dereference: true });
    if (asset.mode === "copy") await normalizeCopiedModes(dest);
    return;
  }
  for (const file of await listFiles(source)) {
    const rel = relative(source, file).replaceAll("\\", "/");
    if (!matchesAny(rel, asset.include) && !matchesAny(basename(file), asset.include)) continue;
    await copyAssetFile(file, join(dest, rel), asset);
  }
}

async function copyAssetFile(source: string, dest: string, asset: PackageAsset): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { dereference: true });
  if (asset.mode === "copy") await chmod(dest, 0o644);
}

function resolvePackagePath(packageRoot: string, path: string): string {
  const resolved = resolve(packageRoot, path);
  const root = resolve(packageRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Asset include escapes package root: ${path}`);
  }
  return resolved;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function normalizeCopiedModes(path: string): Promise<void> {
  const stats = await stat(path);
  if (stats.isFile()) {
    await chmod(path, 0o644);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await normalizeCopiedModes(join(path, entry.name));
  }
}

function matchesAny(path: string, patterns?: string[]): boolean {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(path);
}
