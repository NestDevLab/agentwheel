#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = pkg.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`Invalid package.json version: ${version}`);
}

const replacements = [
  {
    file: "docs/index.html",
    edits: [
      [
        /<span class="eyebrow"><span class="dot"><\/span> v[^<]+<\/span>/,
        `<span class="eyebrow"><span class="dot"></span> v${version} - installation types &amp; harness matrix</span>`,
      ],
      [
        /agentwheel is early \/ v\d+\.\d+(?:\.\d+)?\./g,
        `agentwheel is early / v${version}.`,
      ],
    ],
  },
  {
    file: "docs/catalogue.html",
    edits: [
      [
        /agentwheel is early \/ v\d+\.\d+(?:\.\d+)?\./g,
        `agentwheel is early / v${version}.`,
      ],
    ],
  },
];

for (const { file, edits } of replacements) {
  const path = join(root, file);
  let content = await readFile(path, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(content)) {
      throw new Error(`Version marker not found in ${file}: ${pattern}`);
    }
    content = content.replace(pattern, replacement);
  }
  await writeFile(path, content, "utf8");
}
