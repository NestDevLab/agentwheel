#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  changelogSections,
  compareVersions,
  frontmatterVersion,
  frontmatterVersions,
  jsonVersion,
  markerMatches,
  parseStableVersion,
  productCoupledSkillPaths,
  publishedSkillPaths,
  publishedSkillVersionExceptions,
  readText,
  releaseVersionFiles,
  root,
  siteVersionMarkers,
} from "./release-shared.mjs";

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name !== "--before" && name !== "--tag") throw new Error(`Unknown option: ${name}`);
    if (result[name]) throw new Error(`Duplicate option: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

async function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

const selected = options(process.argv.slice(2));
const packageText = await readText("package.json");
const version = jsonVersion(packageText, "package.json");
const parsedVersion = parseStableVersion(version, "package.json version");
const tag = `v${version}`;
const errors = [];

const openpackText = await readText("openpack.json");
const openpackVersion = jsonVersion(openpackText, "openpack.json");
if (openpackVersion !== version) {
  errors.push(`openpack.json version is ${openpackVersion}, expected ${version}`);
}

const publishedSkills = await publishedSkillPaths(openpackText);
const coupledSkills = productCoupledSkillPaths(publishedSkills);
for (const file of coupledSkills) {
  try {
    const skillVersion = frontmatterVersion(await readText(file), file);
    if (skillVersion !== version) errors.push(`${file} version is ${skillVersion}, expected ${version}`);
  } catch (error) {
    errors.push(error.message);
  }
}
for (const [file, exception] of Object.entries(publishedSkillVersionExceptions)) {
  try {
    const versions = frontmatterVersions(await readText(file), file);
    const expected = exception.expectedVersion === null ? [] : [exception.expectedVersion];
    if (JSON.stringify(versions) !== JSON.stringify(expected)) {
      errors.push(`${file} release exception (${exception.reason}) expected metadata versions ${JSON.stringify(expected)}, found ${JSON.stringify(versions)}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
}

for (const marker of siteVersionMarkers) {
  const matches = markerMatches(await readText(marker.file), marker);
  if (matches.length !== 1) {
    errors.push(`${marker.file} must contain exactly one ${marker.name} marker; found ${matches.length}`);
  } else if (matches[0][1] !== version) {
    errors.push(`${marker.file} ${marker.name} is ${matches[0][1]}, expected ${version}`);
  } else if (matches[0][0] !== marker.render(version)) {
    errors.push(`${marker.file} ${marker.name} does not match the exact release marker`);
  }
}

const changelogSectionsFound = changelogSections(await readText("CHANGELOG.md"));
const firstSection = changelogSectionsFound[0];
if (!firstSection) {
  errors.push("CHANGELOG.md has no level-two release section");
} else {
  if (firstSection.heading !== version) {
    errors.push(`first CHANGELOG.md heading is ${firstSection.heading}, expected ${version}`);
  }
  if (!firstSection.body) errors.push(`CHANGELOG.md ${version} section must not be empty`);
}

const expectedVersionCopies = new Map([
  ["package.json", 1],
  ["openpack.json", 1],
  ["CHANGELOG.md", 1],
]);
for (const file of coupledSkills) expectedVersionCopies.set(file, 1);
for (const [file, exception] of Object.entries(publishedSkillVersionExceptions)) {
  if (exception.expectedVersion === version) expectedVersionCopies.set(file, 1);
}
for (const marker of siteVersionMarkers) {
  expectedVersionCopies.set(marker.file, (expectedVersionCopies.get(marker.file) ?? 0) + 1);
}
for (const file of await releaseVersionFiles()) {
  const content = await readText(file);
  const actual = content.split(version).length - 1;
  const expected = expectedVersionCopies.get(file) ?? 0;
  if (actual !== expected) {
    errors.push(`${file} contains ${actual} current product-version copies, expected ${expected}`);
  }
}

if (selected["--tag"] && selected["--tag"] !== tag) {
  errors.push(`release tag is ${selected["--tag"]}, expected ${tag}`);
}

if (errors.length > 0) {
  throw new Error(`Release metadata validation failed:\n- ${errors.join("\n- ")}`);
}

let release = true;
if (selected["--before"]) {
  const previousPackage = JSON.parse(execFileSync(
    "git",
    ["show", `${selected["--before"]}:package.json`],
    { cwd: root, encoding: "utf8" },
  ));
  const previousVersion = previousPackage.version;
  const parsedPreviousVersion = parseStableVersion(previousVersion, "previous package.json version");
  if (previousVersion === version) {
    release = false;
    console.log(`Package version is unchanged at ${version}; no release tag is needed.`);
  } else if (compareVersions(parsedVersion, parsedPreviousVersion) <= 0) {
    throw new Error(`Version must increase: ${previousVersion} -> ${version}`);
  } else {
    console.log(`Validated release bump ${previousVersion} -> ${version}.`);
  }
}

await writeOutputs({ release: String(release), version, tag });
console.log(`Release metadata is aligned for ${tag}.`);
