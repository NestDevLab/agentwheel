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

export async function expandMarkdownIncludes(artifacts: Artifact[], packageRoot: string): Promise<Artifact[]> {
  const byKey = new Map<string, Artifact>();
  for (const artifact of artifacts) byKey.set(artifactKey(artifact), artifact);
  const artifactPaths = artifactPathMap(artifacts);

  for (const artifact of orderedForExpansion(artifacts)) {
    const files = await markdownFilesForArtifact(artifact);
    if (files.length === 0) continue;

    const composedFrom: ComposedFromEntry[] = [];
    for (const file of files) {
      const result = await expandFile(file, packageRoot, composeEntriesForFile(artifact, file), artifactPaths);
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

export async function validateMarkdownIncludes(artifacts: Artifact[], packageRoot: string): Promise<void> {
  const artifactPaths = artifactPathMap(artifacts);
  for (const artifact of artifacts) {
    for (const file of await markdownFilesForArtifact(artifact)) {
      await expandFile(file, packageRoot, composeEntriesForFile(artifact, file), artifactPaths);
    }
  }
}

async function expandFile(
  file: string,
  packageRoot: string,
  appendEntries: PackageComposeEntry[],
  artifactPaths: Map<string, string>,
): Promise<{ content: string; changed: boolean; composedFrom: ComposedFromEntry[] }> {
  const raw = await readFile(file, "utf8");
  const owner = relativeSelector(packageRoot, file);
  const expanded = await expandContent(raw, packageRoot, [owner], artifactPaths);
  let content = expanded.content;
  const composedFrom = [...expanded.composedFrom];

  for (const entry of appendEntries) {
    const included = await expandInclude(entry.include, packageRoot, artifactPaths, {
      optional: entry.optional === true,
      markers: entry.markers !== false,
      chain: [owner],
    });
    if (!included) continue;
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
  options: { optional: boolean; markers: boolean; chain: string[] },
): Promise<{ rendered: string; composedFrom: ComposedFromEntry[] } | undefined> {
  const parsed = parseIncludeSelector(selector);
  if (options.chain.includes(parsed.selector)) {
    throw new Error(`OpenPack include cycle: ${[...options.chain, parsed.selector].join(" -> ")}`);
  }

  const sourcePath = artifactPaths.get(parsed.selector) ?? resolvePackageSelector(packageRoot, parsed.selector);
  if (!(await pathExists(sourcePath))) {
    if (options.optional) return undefined;
    throw new Error(`OpenPack include not found: ${parsed.selector}`);
  }
  const stats = await stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error(`OpenPack include is not a file: ${parsed.selector}`);
  }

  const raw = await readFile(sourcePath, "utf8");
  const expanded = await expandContent(raw, packageRoot, [...options.chain, parsed.selector], artifactPaths);
  const contentHash = sha256(expanded.content);
  const ownEntry = { selector: parsed.selector, hash: contentHash };
  const composedFrom = uniqueComposedFrom([ownEntry, ...expanded.composedFrom]);
  if (!options.markers) return { rendered: expanded.content, composedFrom };

  return {
    rendered: [
      `<!-- BEGIN openpack:include ${parsed.selector} sha256:${contentHash.slice(0, markerHashLength)} -->`,
      expanded.content.trimEnd(),
      `<!-- END openpack:include ${parsed.selector} -->`,
    ].join("\n"),
    composedFrom,
  };
}

function parseIncludeSelector(selector: string): { selector: string } {
  const cleaned = cleanSelector(selector);
  const slash = cleaned.indexOf("/");
  const colon = cleaned.indexOf(":");
  if (colon >= 0 && (slash < 0 || colon < slash)) {
    throw new Error(`Cross-package includes require dependency support in Phase C: ${cleaned}`);
  }
  if (slash <= 0 || slash === cleaned.length - 1) {
    throw new Error(`Invalid OpenPack include selector: ${cleaned}. Expected fragments/<path>.`);
  }
  const type = cleaned.slice(0, slash);
  const parsedType = artifactTypeSchema.safeParse(type);
  if (!parsedType.success) {
    throw new Error(`Invalid OpenPack include type: ${type}`);
  }
  if (parsedType.data !== "fragments") {
    throw new Error(`OpenPack includes may inline only fragments in Phase A: ${cleaned}`);
  }
  if (cleaned.includes("\\") || cleaned.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new Error(`Invalid OpenPack include path: ${cleaned}`);
  }
  return { selector: cleaned };
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
