import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const publishedSkillVersionExceptions = {
  "skills/agentwheel-artifact-evolution/SKILL.md": {
    expectedVersion: "0.1.0",
    reason: "independently versioned authoring workflow",
  },
  "skills/agentwheel-smoke/SKILL.md": {
    expectedVersion: null,
    reason: "unversioned diagnostic workflow",
  },
};

export const releaseVersionScanRoots = [
  "package.json",
  "openpack.json",
  "CHANGELOG.md",
  "README.md",
  "AGENT.md",
  "install.md",
  "llms.txt",
  "docs",
  "skills",
];

export const siteVersionMarkers = [
  {
    file: "docs/index.html",
    name: "hero version",
    pattern: /<span class="eyebrow"><span class="dot"><\/span> v([^<]+) - installation types &amp; harness matrix<\/span>/g,
    render: (version) => `<span class="eyebrow"><span class="dot"></span> v${version} - installation types &amp; harness matrix</span>`,
  },
  {
    file: "docs/index.html",
    name: "footer version",
    pattern: /<span>agentwheel is early \/ v([^<]+)\.<\/span>/g,
    render: (version) => `<span>agentwheel is early / v${version}.</span>`,
  },
  {
    file: "docs/catalogue.html",
    name: "footer version",
    pattern: /<span>agentwheel is early \/ v([^<]+)\.<\/span>/g,
    render: (version) => `<span>agentwheel is early / v${version}.</span>`,
  },
];

export function parseStableVersion(value, label = "version") {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a stable x.y.z version, got: ${String(value)}`);
  }
  return value.split(".").map(Number);
}

export function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export async function readText(file) {
  return readFile(join(root, file), "utf8");
}

export async function writeText(file, value) {
  await writeFile(join(root, file), value, "utf8");
}

export async function publishedSkillPaths(openpackContent) {
  const manifest = JSON.parse(openpackContent);
  const skillProvides = Array.isArray(manifest.provides)
    ? manifest.provides.filter((item) => item?.type === "skills" && typeof item.path === "string")
    : [];
  if (skillProvides.length === 0) throw new Error("openpack.json must publish at least one skills path");

  const files = new Set();
  for (const item of skillProvides) {
    const absolute = resolve(root, item.path);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error(`OpenPack skills path escapes the repository: ${item.path}`);
    }
    for (const file of await skillFilesUnder(absolute)) files.add(relative(root, file).split(sep).join("/"));
  }
  if (files.size === 0) throw new Error("openpack.json skills paths publish no SKILL.md files");
  return [...files].sort((left, right) => left.localeCompare(right));
}

export function productCoupledSkillPaths(publishedPaths) {
  const published = new Set(publishedPaths);
  for (const [file, exception] of Object.entries(publishedSkillVersionExceptions)) {
    if (!published.has(file)) {
      throw new Error(`Release skill exception is stale: ${file} (${exception.reason}) is not published by openpack.json`);
    }
  }
  return publishedPaths.filter((file) => !(file in publishedSkillVersionExceptions));
}

export async function releaseVersionFiles() {
  const files = new Set();
  for (const entry of releaseVersionScanRoots) {
    const absolute = join(root, entry);
    try {
      const details = await stat(absolute);
      if (details.isDirectory()) {
        for (const file of await textFilesUnder(absolute)) files.add(relative(root, file).split(sep).join("/"));
      } else if (details.isFile()) {
        files.add(entry);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

async function skillFilesUnder(path) {
  const details = await stat(path);
  if (details.isFile()) return basename(path) === "SKILL.md" ? [path] : [];
  if (!details.isDirectory()) return [];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`OpenPack skills path contains a symlink: ${join(path, entry.name)}`);
    if (entry.isDirectory()) result.push(...await skillFilesUnder(join(path, entry.name)));
    else if (entry.isFile() && entry.name === "SKILL.md") result.push(join(path, entry.name));
  }
  return result;
}

async function textFilesUnder(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await textFilesUnder(child));
    else if (entry.isFile() && /\.(?:html?|jsonc?|m?js|md|sh|txt|ya?ml)$/i.test(entry.name)) result.push(child);
  }
  return result;
}

export function jsonVersion(content, file) {
  JSON.parse(content);
  const matches = [...content.matchAll(/"version"\s*:\s*"([^"]+)"/g)];
  if (matches.length !== 1) {
    throw new Error(`${file} must contain exactly one version field; found ${matches.length}`);
  }
  return matches[0][1];
}

export function replaceJsonVersion(content, file, version) {
  jsonVersion(content, file);
  return content.replace(
    /("version"\s*:\s*)"[^"]+"/,
    `$1"${version}"`,
  );
}

export function frontmatterVersion(content, file) {
  const versions = frontmatterVersions(content, file);
  if (versions.length !== 1) {
    throw new Error(`${file} must contain exactly one quoted metadata version; found ${versions.length}`);
  }
  return versions[0];
}

export function frontmatterVersions(content, file) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (frontmatter === undefined) {
    throw new Error(`${file} is missing YAML frontmatter`);
  }
  const matches = [...frontmatter.matchAll(/^\s*version:\s*["']([^"']+)["']\s*$/gm)];
  return matches.map((match) => match[1]);
}

export function replaceFrontmatterVersion(content, file, version) {
  frontmatterVersion(content, file);
  const end = content.indexOf("\n---", 4);
  const frontmatter = content.slice(0, end);
  const updated = frontmatter.replace(
    /^(\s*version:\s*)["'][^"']+["']\s*$/m,
    `$1"${version}"`,
  );
  return updated + content.slice(end);
}

export function markerMatches(content, marker) {
  return [...content.matchAll(new RegExp(marker.pattern.source, marker.pattern.flags))];
}

export function changelogSections(content) {
  return [...content.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map((match) => ({
    heading: match[1].trim(),
    body: match[2].trim(),
    index: match.index,
    raw: match[0],
  }));
}
