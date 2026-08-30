import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Artifact, ComposedFromEntry, PackageComposeEntry } from "../model/artifact.js";
import { artifactTypeSchema } from "../model/artifact.js";
import { hashPath, pathExists } from "../utils/fs.js";

const includePattern = /<!--\s*openpack:include(\?)?\s+([^>]+?)\s*-->/g;
const escapedIncludePattern = /<!--\s*openpack\\:include(\?)?\s+([^>]+?)\s*-->/g;
const generatedPattern = /<!--\s*(?:BEGIN|END)\s+openpack:include\b/;
const markerHashLength = 16;

export interface ParsedOpenPackIncludeSelector {
  alias?: string;
  selector: string;
}

export interface CrossPackageIncludeRequest {
  fromNodeId: string;
  alias: string;
  selector: string;
  optional: boolean;
}

export interface CrossPackageIncludeResolution {
  toNodeId: string;
  packageRoot: string;
  artifactPaths: Map<string, string>;
  sourcePath: string;
  sourceContent: string;
  sourceHash: string;
}

export interface MarkdownIncludeOptions {
  nodeId?: string;
  originNodeId?: string;
  allowCrossPackage?: boolean;
  resolveCrossPackageInclude?: (request: CrossPackageIncludeRequest) => Promise<CrossPackageIncludeResolution | undefined>;
  additionalComposeEntries?: (artifact: Artifact) => ExternalComposeEntry[];
}

export interface ExternalComposeEntry {
  entry: PackageComposeEntry;
  packageRoot: string;
  artifactPaths: Map<string, string>;
  nodeId?: string;
}

export async function expandMarkdownIncludes(artifacts: Artifact[], packageRoot: string, options: MarkdownIncludeOptions = {}): Promise<Artifact[]> {
  const byKey = new Map<string, Artifact>();
  for (const artifact of artifacts) byKey.set(artifactKey(artifact), artifact);
  const artifactPaths = artifactPathMap(artifacts);

  for (const artifact of orderedForExpansion(artifacts)) {
    // Fragments are composition inputs. Expanding them in place can leave generated
    // markers in a dependency's staging tree before a parent package consumes it.
    // Consumers recursively expand the raw fragment content when they include it.
    if (artifact.type === "fragments") continue;
    const files = await markdownFilesForArtifact(artifact);
    if (files.length === 0) continue;

    const composedFrom: ComposedFromEntry[] = [];
    for (const file of files) {
      const localEntries = composeEntriesForFile(artifact, file).map((entry) => ({
        entry,
        packageRoot,
        artifactPaths,
        nodeId: options.nodeId,
      }));
      const externalEntries = isPrimaryMarkdownFile(artifact, file)
        ? options.additionalComposeEntries?.(artifact) ?? []
        : [];
      const result = await expandFile(file, packageRoot, [...localEntries, ...externalEntries], artifactPaths, options);
      if (result.changed) await writeFile(file, result.content, "utf8");
      composedFrom.push(...result.composedFrom);
    }

    const stagedPath = artifact.stagedPath ?? artifact.sourcePath;
    const unique = uniqueComposedFrom(composedFrom);
    byKey.set(artifactKey(artifact), {
      ...artifact,
      hash: await hashPath(stagedPath),
      composedFrom: unique.length > 0 ? unique : undefined,
    });
  }

  return artifacts.map((artifact) => byKey.get(artifactKey(artifact)) ?? artifact);
}

export async function validateMarkdownIncludes(artifacts: Artifact[], packageRoot: string, options: MarkdownIncludeOptions = {}): Promise<void> {
  const artifactPaths = artifactPathMap(artifacts);
  for (const artifact of artifacts) {
    for (const file of await markdownFilesForArtifact(artifact)) {
      const entries = composeEntriesForFile(artifact, file).map((entry) => ({ entry, packageRoot, artifactPaths, nodeId: options.nodeId }));
      await expandFile(file, packageRoot, entries, artifactPaths, options);
    }
  }
}

async function expandFile(
  file: string,
  packageRoot: string,
  appendEntries: ExternalComposeEntry[],
  artifactPaths: Map<string, string>,
  options: MarkdownIncludeOptions,
): Promise<{ content: string; changed: boolean; composedFrom: ComposedFromEntry[] }> {
  const raw = await readFile(file, "utf8");
  const owner = ownerSelector(packageRoot, file, options.nodeId);
  const expanded = await expandContent(raw, packageRoot, [owner], artifactPaths, options);
  let content = expanded.content;
  const composedFrom = [...expanded.composedFrom];
  const appliedIncludes = new Set<string>();

  for (const external of appendEntries) {
    const { entry } = external;
    const included = await expandInclude(entry.include, external.packageRoot, external.artifactPaths, {
      ...options,
      nodeId: external.nodeId,
      optional: entry.optional === true,
      markers: entry.markers !== false,
      chain: [owner],
    });
    if (!included) continue;
    const identity = JSON.stringify(included.composedFrom);
    if (appliedIncludes.has(identity)) continue;
    appliedIncludes.add(identity);
    content = `${content.trimEnd()}\n\n${included.rendered}\n`;
    composedFrom.push(...included.composedFrom);
  }

  return {
    content,
    changed: content !== raw,
    composedFrom: uniqueComposedFrom(composedFrom),
  };
}

async function expandContent(
  content: string,
  packageRoot: string,
  chain: string[],
  artifactPaths: Map<string, string>,
  options: MarkdownIncludeOptions,
): Promise<{ content: string; composedFrom: ComposedFromEntry[] }> {
  const owner = chain[chain.length - 1] ?? "<unknown>";
  if (generatedPattern.test(content)) {
    throw new Error(`Generated OpenPack include block found in raw source ${owner}; escape literal examples as openpack\\:include.`);
  }

  const composedFrom: ComposedFromEntry[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const match of content.matchAll(includePattern)) {
    const selector = cleanSelector(match[2] ?? "");
    const included = await expandInclude(selector, packageRoot, artifactPaths, {
      ...options,
      optional: match[1] === "?",
      markers: true,
      chain,
    });
    replacements.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      value: included?.rendered ?? "",
    });
    if (included) composedFrom.push(...included.composedFrom);
  }

  let expanded = applyReplacements(content, replacements);
  expanded = expanded.replace(escapedIncludePattern, (_match, optional: string | undefined, selector: string) => {
    return `<!-- openpack:include${optional ?? ""} ${cleanSelector(selector)} -->`;
  });

  return { content: expanded, composedFrom: uniqueComposedFrom(composedFrom) };
}

async function expandInclude(
  selector: string,
  packageRoot: string,
  artifactPaths: Map<string, string>,
  options: MarkdownIncludeOptions & { optional: boolean; markers: boolean; chain: string[] },
): Promise<{ rendered: string; composedFrom: ComposedFromEntry[] } | undefined> {
  const parsed = parseOpenPackIncludeSelector(selector);
  let sourcePath: string;
  let sourceContent: string | undefined;
  let includePackageRoot = packageRoot;
  let includeArtifactPaths = artifactPaths;
  let includeNodeId = options.nodeId;
  let displaySelector = displaySelectorForInclude(parsed.selector, options.nodeId, options.originNodeId);
  if (parsed.alias) {
    if (!options.nodeId || !options.resolveCrossPackageInclude) {
      if (options.allowCrossPackage) return undefined;
      throw new Error(`Cross-package includes require dependency graph support: ${parsed.alias}:${parsed.selector}`);
    }
    const resolved = await options.resolveCrossPackageInclude({
      fromNodeId: options.nodeId,
      alias: parsed.alias,
      selector: parsed.selector,
      optional: options.optional,
    });
    if (!resolved) return undefined;
    sourcePath = resolved.sourcePath;
    sourceContent = resolved.sourceContent;
    includePackageRoot = resolved.packageRoot;
    includeArtifactPaths = resolved.artifactPaths;
    includeNodeId = resolved.toNodeId;
    displaySelector = `${resolved.toNodeId}:${parsed.selector}`;
  } else {
    sourcePath = artifactPaths.get(parsed.selector) ?? resolvePackageSelector(packageRoot, parsed.selector);
  }

  if (options.chain.includes(displaySelector)) {
    throw new Error(`OpenPack include cycle: ${[...options.chain, displaySelector].join(" -> ")}`);
  }

  if (!(await pathExists(sourcePath))) {
    if (options.optional) return undefined;
    throw new Error(`OpenPack include not found: ${displaySelector}`);
  }
  const stats = await stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error(`OpenPack include is not a file: ${displaySelector}`);
  }

  const raw = sourceContent ?? await readFile(sourcePath, "utf8");
  const { optional: _optional, markers: _markers, chain: _chain, ...childOptions } = options;
  const expanded = await expandContent(raw, includePackageRoot, [...options.chain, displaySelector], includeArtifactPaths, {
    ...childOptions,
    nodeId: includeNodeId,
  });
  const contentHash = sha256(expanded.content);
  const ownEntry = { selector: displaySelector, hash: contentHash };
  const composedFrom = uniqueComposedFrom([ownEntry, ...expanded.composedFrom]);
  if (!options.markers) return { rendered: expanded.content, composedFrom };

  return {
    rendered: [
      `<!-- BEGIN openpack:include ${displaySelector} sha256:${contentHash.slice(0, markerHashLength)} -->`,
      expanded.content.trimEnd(),
      `<!-- END openpack:include ${displaySelector} -->`,
    ].join("\n"),
    composedFrom,
  };
}

export function parseOpenPackIncludeSelector(selector: string): ParsedOpenPackIncludeSelector {
  const cleaned = cleanSelector(selector);
  const slash = cleaned.indexOf("/");
  const colon = cleaned.indexOf(":");
  let alias: string | undefined;
  let localSelector = cleaned;
  if (colon >= 0 && (slash < 0 || colon < slash)) {
    alias = cleaned.slice(0, colon);
    if (!alias || alias.includes("/")) {
      throw new Error(`Invalid OpenPack include alias: ${cleaned}`);
    }
    localSelector = cleaned.slice(colon + 1);
  }
  const localSlash = localSelector.indexOf("/");
  if (localSlash <= 0 || localSlash === localSelector.length - 1) {
    throw new Error(`Invalid OpenPack include selector: ${cleaned}. Expected fragments/<path>.`);
  }
  const type = localSelector.slice(0, localSlash);
  const parsedType = artifactTypeSchema.safeParse(type);
  if (!parsedType.success) {
    throw new Error(`Invalid OpenPack include type: ${type}`);
  }
  if (parsedType.data !== "fragments") {
    throw new Error(`OpenPack includes may inline only fragments: ${cleaned}`);
  }
  if (localSelector.includes("\\") || localSelector.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new Error(`Invalid OpenPack include path: ${cleaned}`);
  }
  return { alias, selector: localSelector };
}

export function extractOpenPackIncludeSelectors(content: string): Array<{ selector: ParsedOpenPackIncludeSelector; optional: boolean; raw: string }> {
  const selectors: Array<{ selector: ParsedOpenPackIncludeSelector; optional: boolean; raw: string }> = [];
  for (const match of content.matchAll(includePattern)) {
    const raw = cleanSelector(match[2] ?? "");
    selectors.push({ selector: parseOpenPackIncludeSelector(raw), optional: match[1] === "?", raw });
  }
  return selectors;
}

function resolvePackageSelector(packageRoot: string, selector: string): string {
  const root = resolve(packageRoot);
  const resolved = resolve(root, selector);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`OpenPack include escapes package root: ${selector}`);
  }
  return resolved;
}

async function markdownFilesForArtifact(artifact: Artifact): Promise<string[]> {
  const root = artifact.stagedPath ?? artifact.sourcePath;
  const stats = await stat(root);
  if (stats.isFile()) return extname(root).toLowerCase() === ".md" ? [root] : [];
  if (!stats.isDirectory()) return [];
  return listMarkdownFiles(root);
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function composeEntriesForFile(artifact: Artifact, file: string): PackageComposeEntry[] {
  if (!artifact.compose?.length) return [];
  if (artifact.kind === "file") return [resolve(artifact.stagedPath ?? artifact.sourcePath), resolve(file)].every(Boolean) && resolve(artifact.stagedPath ?? artifact.sourcePath) === resolve(file) ? artifact.compose : [];
  return basename(file) === "SKILL.md" && dirname(file) === resolve(artifact.stagedPath ?? artifact.sourcePath) ? artifact.compose : [];
}

function isPrimaryMarkdownFile(artifact: Artifact, file: string): boolean {
  if (artifact.kind === "file") return resolve(artifact.stagedPath ?? artifact.sourcePath) === resolve(file);
  return basename(file) === "SKILL.md" && dirname(file) === resolve(artifact.stagedPath ?? artifact.sourcePath);
}

function orderedForExpansion(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => Number(a.type === "fragments") - Number(b.type === "fragments"));
}

function applyReplacements(content: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  if (replacements.length === 0) return content;
  let cursor = 0;
  let out = "";
  for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
    out += content.slice(cursor, replacement.start);
    out += replacement.value;
    cursor = replacement.end;
  }
  return out + content.slice(cursor);
}

function relativeSelector(root: string, file: string): string {
  return relative(root, file).replaceAll("\\", "/");
}

function ownerSelector(root: string, file: string, nodeId: string | undefined): string {
  const selector = relativeSelector(root, file);
  return nodeId ? `${nodeId}:${selector}` : selector;
}

function displaySelectorForInclude(selector: string, nodeId: string | undefined, originNodeId: string | undefined): string {
  if (nodeId && originNodeId && nodeId !== originNodeId) return `${nodeId}:${selector}`;
  return selector;
}

function cleanSelector(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function uniqueComposedFrom(entries: ComposedFromEntry[]): ComposedFromEntry[] {
  if (entries.length === 0) return [];
  const byKey = new Map(entries.map((entry) => [`${entry.selector}\0${entry.hash}`, entry]));
  return [...byKey.values()].sort((a, b) => `${a.selector}:${a.hash}`.localeCompare(`${b.selector}:${b.hash}`));
}

function artifactKey(artifact: Artifact): string {
  return `${artifact.type}:${artifact.name}:${artifact.channel ?? "managed"}`;
}

function artifactPathMap(artifacts: Artifact[]): Map<string, string> {
  return new Map(artifacts.map((artifact) => [artifact.relativePath.replaceAll("\\", "/"), artifact.stagedPath ?? artifact.sourcePath]));
}
