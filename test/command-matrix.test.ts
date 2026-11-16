import { expect, it } from "vitest";
// @ts-expect-error The CLI support script is native ESM JavaScript.
import { reconcile, counts } from "../scripts/test-command-matrix.mjs";

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
