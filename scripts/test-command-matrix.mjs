import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = process.cwd();
const require = createRequire(import.meta.url);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = path => readFile(join(root, path), "utf8");

export function counts(tests) {
  const pass = tests.filter(t => t.status === "passed").length;
  const fail = tests.filter(t => t.status === "failed").length;
  return { registered: tests.length, executed: pass + fail, pass, fail,
    skipped: tests.filter(t => t.status === "skipped").length,
    pending: tests.filter(t => t.status === "pending").length };
}

export function reconcile(commands, registered, results, links) {
  const byId = new Map(registered.map(t => [t.id, t]));
  const resultIds = new Set(results.map(t => t.id));
  if (byId.size !== registered.length || resultIds.size !== results.length
    || byId.size !== resultIds.size || [...byId.keys()].some(id => !resultIds.has(id))) {
    throw new Error("Registered and executed runner IDs do not reconcile");
  }
  const attributed = new Map(commands.map(command => [command, new Set()]));
  const assigned = new Set();
  const selectors = new Set();
  for (const link of links) {
    const key = `${link.file}::${link.name}`;
    if (selectors.has(key) || !link.evidence?.trim() || !link.commands.length) throw new Error(`Invalid mapping: ${key}`);
    selectors.add(key);
    const matches = registered.filter(t => t.file === link.file && t.name === link.name);
    if (matches.length !== 1) throw new Error(`Mapping must match exactly one registered test: ${key} (${matches.length})`);
    for (const command of link.commands) {
      if (!attributed.has(command)) throw new Error(`Unknown parser command: ${command}`);
      attributed.get(command).add(matches[0].id);
      assigned.add(matches[0].id);
    }
  }
  const rows = commands.map(command => {
    const tests = results.filter(t => attributed.get(command).has(t.id)).sort((a,b) => compare(a.id,b.id));
    return { command, ...counts(tests), tests };
  });
  return { rows, uniqueAttributed: assigned.size,
    unattributed: results.filter(t => !assigned.has(t.id)).sort((a,b) => compare(a.id,b.id)) };
}

async function parserCommands(scratch) {
  const source = await read("src/cli/index.ts");
  const marker = "try {\n  await main();";
  if (source.split(marker).length !== 2) throw new Error("CLI entry boundary changed; inspect inventory loader");
  // Load the actual Commander tree, replacing only the executable entrypoint.
  const code = `${source.slice(0, source.indexOf(marker))}\nexport { program };\n`;
  const output = join(scratch, "parser.mjs");
  await build({ stdin: { contents: code, resolveDir: join(root,"src/cli"), sourcefile: "index.ts", loader: "ts" },
    bundle: true, packages: "external", platform: "node", format: "esm", outfile: output, write: true });
  const { program } = await import(pathToFileURL(output));
  const commands = [program.name()];
  function visit(parent, prefix) {
    for (const command of parent.commands) {
      const path = [...prefix, command.name()];
      commands.push(path.join(" "));
      visit(command, path);
    }
  }
  visit(program, []);
  if (new Set(commands).size !== commands.length) throw new Error("Duplicate parser command path");
  return commands.sort(compare);
}

async function sourceReceipt() {
  // Hash exact source/test/script/config bytes; no absolute paths, timestamps or self-referential output.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const paths = tracked.filter(path => /^(src|test|scripts)\//.test(path)
    || ["package.json", "pnpm-lock.yaml", "vitest.config.ts", "tsconfig.json"].includes(path));
  const files = await Promise.all(paths.sort(compare).map(async path => [path, hash(await readFile(join(root,path)))]));
  return { inputDigest: hash(JSON.stringify(files.sort((a,b) => compare(a[0],b[0])))),
    parserSha256: hash(await read("src/cli/index.ts")),
    vitest: require("vitest/package.json").version,
    node: process.versions.node };
}

async function main() {
  // Inside the repository so external imports resolve the installed dependencies.
  const scratch = await mkdtemp(join(root, "scripts/.command-matrix-"));
  const reportRoot = await mkdtemp(join(tmpdir(), "command-matrix-"));
  try {
    const commands = await parserCommands(scratch);
    const report = join(reportRoot,"runner.json");
    const json = join(reportRoot,"vitest.json");
    const runner = spawnSync(process.execPath, [require.resolve("vitest/vitest.mjs"), "run",
      "--maxWorkers=2", "--reporter=json", "--reporter=./scripts/test-command-reporter.mjs", `--outputFile=${json}`], {
      cwd: root, env: { ...process.env, COMMAND_MATRIX_REPORT: report }, encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
    });
    if (runner.error) throw runner.error;
    const observed = JSON.parse(await readFile(report,"utf8"));
    const official = JSON.parse(await readFile(json,"utf8"));
    const officialTests = official.testResults.flatMap(file => file.assertionResults);
    if (officialTests.length !== observed.tests.length) throw new Error("JSON reporter test count mismatch");
    const mapping = JSON.parse(await read("scripts/test-command-map.json"));
    if (mapping.schemaVersion !== 1) throw new Error("Unsupported mapping schema");
    const matrix = reconcile(commands, observed.registered, observed.tests, mapping.links);
    const output = { schemaVersion: 1, receipt: await sourceReceipt(),
      commandCount: commands.length, zeroTestCommands: matrix.rows.filter(row => !row.registered).map(row => row.command),
      totals: counts(observed.tests), uniqueAttributed: matrix.uniqueAttributed,
      runnerExitCode: runner.status, moduleErrors: observed.moduleErrors, unhandledErrors: observed.unhandledErrors,
      commands: matrix.rows, unattributed: matrix.unattributed };
    const destination = resolve(process.argv[2] ?? "docs/test-command-matrix.json");
    await writeFile(destination, `${JSON.stringify(output,null,2)}\n`);
    console.log(JSON.stringify({ commandCount: output.commandCount, zeroTestCommands: output.zeroTestCommands.length,
      ...output.totals, uniqueAttributed: output.uniqueAttributed, output: relative(root,destination) }));
    if (runner.status !== 0 || observed.moduleErrors.length || observed.unhandledErrors) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(reportRoot, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
