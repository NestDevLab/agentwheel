import { expect, it } from "vitest";
import { readFixture } from "../helpers/read-effects.js";

it.each([false,true])("read_effects_match_explicit_policy_status_warm_%s", async warm => {
  const fixture = await readFixture(warm);
  try {
    const observed = await fixture.probe();
    expect(observed.result.error).toBeUndefined();
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.calls.filter(call => call.kind === "network")).toEqual([]);
    expect(observed.calls.filter(call => /\b(fetch|clone|ls-remote)\b/.test(JSON.stringify(call.args)))).toEqual([]);
    expect(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_never_evicts_snapshot", async () => {
  const fixture = await readFixture(true);
  try {
    const observed = await fixture.probe(["--offline"]);
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);
