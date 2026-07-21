#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`${label} must be a stable x.y.z version, got: ${value}`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function text(path) {
  return readFile(join(root, path), "utf8");
}

async function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const content = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(process.env.GITHUB_OUTPUT, `${content}\n`);
}

const packageJson = await json("package.json");
const openpack = await json("openpack.json");
const skill = await text("skills/agentwheel/SKILL.md");
const index = await text("docs/index.html");
const catalogue = await text("docs/catalogue.html");
const changelog = await text("CHANGELOG.md");
const version = packageJson.version;
const parsedVersion = parseStableVersion(version, "package.json version");
const tag = `v${version}`;
const errors = [];

if (openpack.version !== version) {
  errors.push(`openpack.json is ${openpack.version}, expected ${version}`);
}

const skillVersion = skill.match(/^\s*version:\s*["']([^"']+)["']\s*$/m)?.[1];
if (skillVersion !== version) {
  errors.push(`skills/agentwheel/SKILL.md is ${skillVersion ?? "missing"}, expected ${version}`);
}

const expectedIndexMarkers = [
  `v${version} - installation types &amp; harness matrix`,
  `agentwheel is early / v${version}.`,
];
for (const marker of expectedIndexMarkers) {
  if (!index.includes(marker)) errors.push(`docs/index.html is missing: ${marker}`);
}

const catalogueMarker = `agentwheel is early / v${version}.`;
if (!catalogue.includes(catalogueMarker)) {
  errors.push(`docs/catalogue.html is missing: ${catalogueMarker}`);
}

if (!changelog.includes(`## ${version}\n`)) {
  errors.push(`CHANGELOG.md is missing a ${version} section`);
}

const expectedTag = option("--tag");
if (expectedTag && expectedTag !== tag) {
  errors.push(`release tag is ${expectedTag}, expected ${tag}`);
}

if (errors.length > 0) {
  throw new Error(`Release version validation failed:\n- ${errors.join("\n- ")}`);
}

const before = option("--before");
if (before) {
  const previousPackage = JSON.parse(
    execFileSync("git", ["show", `${before}:package.json`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const previousVersion = previousPackage.version;

  if (previousVersion === version) {
    await writeOutputs({ release: "false", version, tag });
    console.log(`Package version is unchanged at ${version}; no release tag is needed.`);
    process.exit(0);
  }

  const parsedPreviousVersion = parseStableVersion(previousVersion, "previous package.json version");
  if (compareVersions(parsedVersion, parsedPreviousVersion) <= 0) {
    throw new Error(`Version must increase: ${previousVersion} -> ${version}`);
  }

  console.log(`Validated release bump ${previousVersion} -> ${version}.`);
}

await writeOutputs({ release: "true", version, tag });
console.log(`Release metadata is aligned for ${tag}.`);
