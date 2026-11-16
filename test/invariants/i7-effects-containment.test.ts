import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readFixture } from "../helpers/read-effects.js";

it.each([false,true])("read_effects_match_explicit_policy_status_warm_%s", async warm => {
  const fixture = await readFixture(warm);
  try {
    const observed = await fixture.probe();
    expect(observed.result.error).toBeUndefined();
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    const report = JSON.parse(observed.result.stdout);
    expect(report.command).toBe("status");
    if (warm) expect(report.targets[0].pendingCount).toBeGreaterThan(0);
    expect(observed.calls.filter(call => call.kind === "network")).toEqual([]);
    expect.soft(observed.calls.filter(call => /\b(fetch|clone|ls-remote)\b/.test(JSON.stringify(call.args)))).toEqual([]);
    expect.soft(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_never_evicts_snapshot", async () => {
  const fixture = await readFixture(true);
  try {
    const observed = await fixture.probe(["--offline"]);
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect.soft(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_missing_git_preserves_cache_status", async () => {
  const fixture = await readFixture(true);
  try {
    await rm(join(fixture.resolved.resolvedPath,".git"), { recursive: true });
    await writeFile(join(fixture.resolved.resolvedPath,"sentinel"),"preserve incomplete checkout");
    const observed = await fixture.probe();
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect.soft(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_effects_match_explicit_policy_diagnostics_consumer", async () => {
  const fixture = await readFixture(true);
  try {
    const consumer = join(fixture.root,"diagnostics.mjs");
    await writeFile(consumer, `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [process.env.SYNTHETIC_CLI,...process.argv.slice(2)], {stdio:"inherit"});
process.exitCode = result.status ?? 1;`);
    const observed = await fixture.probe([],consumer,{ SYNTHETIC_CLI: resolve("dist/index.js") });
    expect(observed.result.stdout,observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.calls.filter(call => call.kind === "network")).toEqual([]);
    expect(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("unqualified_cli_does_not_build_on_read", async () => {
  const fixture = await readFixture(false);
  try {
    const observed = await fixture.probe([],resolve("scripts/agentwheel-local.mjs"),{ AGENTWHEEL_REPO_DIR: fixture.root });
    expect(observed.result.status).toBe(127);
    expect(observed.result.stderr).toMatch(/Build explicitly.*never builds implicitly/);
    expect(observed.calls).toEqual([]);
    expect(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_effects_match_explicit_policy_local_wrapper", async () => {
  const fixture = await readFixture(true);
  try {
    const observed = await fixture.probe([],resolve("scripts/agentwheel-local.mjs"),{ AGENTWHEEL_REPO_DIR: process.cwd() });
    expect(observed.result.stdout,observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.calls.filter(call => call.kind === "network")).toEqual([]);
    expect(observed.calls.filter(call => /\b(pnpm|flock|clone|fetch|ls-remote)\b/.test(JSON.stringify(call.args)))).toEqual([]);
    expect(observed.changes).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_effects_match_explicit_policy_explicit_refresh", async () => {
  const fixture = await readFixture(false);
  try {
    const observed = await fixture.probe(["--refresh"]);
    expect(observed.result.stdout,observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.changes.length).toBeGreaterThan(0);
    expect(observed.changes.every(path => path.startsWith("tree:workspace/.agentwheel/cache"))).toBe(true);
    expect(observed.calls.filter(call => call.kind === "network")).toEqual([]);
  } finally { await fixture.dispose(); }
}, 30_000);

it("read_never_evicts_snapshot_warm_cache", async () => {
  const fixture = await readFixture(true);
  try {
    await mkdir(join(fixture.cacheRoot,"synthetic-checkout/.git"),{recursive:true});
    for (const suffix of ["aaaaaaaaaaaa","bbbbbbbbbbbb","cccccccccccc","dddddddddddd"]) {
      const dir = join(fixture.cacheRoot,`synthetic-checkout-${suffix}`);
      await mkdir(dir); await writeFile(join(dir,"sentinel"),"recovery evidence");
    }
    const observed = await fixture.probe([],process.env.SYNTHETIC_READ_CLI);
    expect(observed.result.stdout, observed.result.stderr).not.toBe("");
    expect(JSON.parse(observed.result.stdout).command).toBe("status");
    expect(observed.changes).toEqual([]);
  } finally {await fixture.dispose();}
},30_000);
