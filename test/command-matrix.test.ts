import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
// @ts-expect-error The CLI support script is native ESM JavaScript.
import { reconcile, counts, runTests, matrixDestination, parserCommands } from "../scripts/test-command-matrix.mjs";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));

it("reconciles shared command attribution without double-counting unique runner IDs", () => {
  const registered = [{ id: "a", file: "case.ts", name: "parameter 1" }, { id: "b", file: "case.ts", name: "parameter 2" }];
  const results = registered.map(test => ({ ...test, status: "passed" }));
  const matrix = reconcile(["one", "two", "zero"], registered, results,
    [{ file: "case.ts", name: "parameter 1", commands: ["one", "two"], evidence: "shared fixture" }]);
  expect(matrix.uniqueAttributed).toBe(1);
  expect(matrix.rows.map((row: { registered: number }) => row.registered)).toEqual([1,1,0]);
  expect(matrix.unattributed.map((test: { id: string }) => test.id)).toEqual(["b"]);
  expect(() => reconcile(["one"], registered, [results[0]], [])).toThrow(/reconcile/);
  expect(() => reconcile(["one"], registered, results, [{ file: "case.ts", name: "missing", commands: ["one"], evidence: "fixture" }])).toThrow(/exactly one/);
  expect(() => reconcile(["one"], registered, results, [{ file: "case.ts", name: "parameter 1", commands: ["unknown"], evidence: "fixture" }])).toThrow(/Unknown/);
  expect(counts([{ status: "passed" }, { status: "failed" }, { status: "skipped" }, { status: "pending" }])).toEqual({ registered: 4, executed: 2, pass: 1, fail: 1, skipped: 1, pending: 1 });
});

it("rejects mappings without a commands array with an explicit validation error", () => {
  const registered = [{ id: "a", file: "case.ts", name: "case" }];
  for (const commands of [undefined, null, "one", []]) {
    expect(() => reconcile(["one"], registered, registered,
      [{ file: "case.ts", name: "case", evidence: "fixture", commands }])).toThrow(/Invalid mapping/);
  }
});

it("streams default reporter output and runner errors to CI", () => {
  runTests("runner.json", "vitest.json");
  expect(vi.mocked(spawnSync)).toHaveBeenCalledWith("pnpm", expect.arrayContaining(["test", "--reporter=default"]),
    expect.objectContaining({ stdio: "inherit" }));
});

it("keeps the default report outside the checkout in a temporary directory", async () => {
  const output = await matrixDestination();
  try {
    expect(relative(tmpdir(), output)).toMatch(/^command-matrix-output-[^/]+\/matrix\.json$/);
    expect(await matrixDestination("custom.json")).toBe(join(process.cwd(), "custom.json"));
  } finally { await rm(dirname(output), { recursive: true, force: true }); }
});

it("loads the Commander tree from a scratch directory outside the checkout", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "command-matrix-parser-test-"));
  try {
    const commands = await parserCommands(scratch);
    expect(commands).toEqual(expect.arrayContaining(["agentwheel", "cache prune", "registry publish", "doctor"]));
    expect(new Set(commands).size).toBe(commands.length);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
