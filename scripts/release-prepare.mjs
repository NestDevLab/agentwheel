#!/usr/bin/env node

import {
  changelogSections,
  frontmatterVersion,
  frontmatterVersions,
  jsonVersion,
  markerMatches,
  parseStableVersion,
  productCoupledSkillPaths,
  publishedSkillPaths,
  publishedSkillVersionExceptions,
  readText,
  replaceFrontmatterVersion,
  replaceJsonVersion,
  siteVersionMarkers,
  writeText,
} from "./release-shared.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  throw new Error("Usage: pnpm release:prepare <stable-semver>");
}

const version = args[0];
parseStableVersion(version, "release version");
const writes = new Map();

const packageText = await readText("package.json");
parseStableVersion(jsonVersion(packageText, "package.json"), "package.json version");
writes.set("package.json", replaceJsonVersion(packageText, "package.json", version));

const openpackText = await readText("openpack.json");
jsonVersion(openpackText, "openpack.json");
writes.set("openpack.json", replaceJsonVersion(openpackText, "openpack.json", version));

const publishedSkills = await publishedSkillPaths(openpackText);
for (const file of productCoupledSkillPaths(publishedSkills)) {
  const content = await readText(file);
  frontmatterVersion(content, file);
  writes.set(file, replaceFrontmatterVersion(content, file, version));
}
for (const [file, exception] of Object.entries(publishedSkillVersionExceptions)) {
  const versions = frontmatterVersions(await readText(file), file);
  const expected = exception.expectedVersion === null ? [] : [exception.expectedVersion];
  if (JSON.stringify(versions) !== JSON.stringify(expected)) {
    throw new Error(`${file} release exception (${exception.reason}) expected metadata versions ${JSON.stringify(expected)}, found ${JSON.stringify(versions)}`);
  }
}

const siteFiles = new Map();
for (const marker of siteVersionMarkers) {
  const content = siteFiles.get(marker.file) ?? await readText(marker.file);
  const matches = markerMatches(content, marker);
  if (matches.length !== 1) {
    throw new Error(`${marker.file} must contain exactly one ${marker.name} marker; found ${matches.length}`);
  }
  siteFiles.set(marker.file, content.replace(marker.pattern, marker.render(version)));
}
for (const [file, content] of siteFiles) writes.set(file, content);

const changelog = await readText("CHANGELOG.md");
const sections = changelogSections(changelog);
if (sections.length === 0) {
  throw new Error("CHANGELOG.md must contain at least one level-two release section");
}
if (sections.slice(1).some((section) => section.heading === version)) {
  throw new Error(`CHANGELOG.md already contains historical section ${version}; refusing to reorder history`);
}

const first = sections[0];
let updatedChangelog = changelog;
if (first.heading === version) {
  if (!first.body) throw new Error(`CHANGELOG.md ${version} section must not be empty`);
} else if (first.heading.toLowerCase() === "unreleased") {
  if (!first.body) throw new Error("CHANGELOG.md Unreleased section must not be empty");
  updatedChangelog = changelog.slice(0, first.index)
    + first.raw.replace(/^## Unreleased\n/i, `## ${version}\n`)
    + changelog.slice(first.index + first.raw.length);
} else {
  parseStableVersion(first.heading, "first CHANGELOG.md heading");
  throw new Error(
    `CHANGELOG.md must start with a non-empty Unreleased or ${version} section before release preparation`,
  );
}
writes.set("CHANGELOG.md", updatedChangelog);

for (const [file, content] of writes) await writeText(file, content);

console.log(`Prepared release metadata for v${version}.`);
