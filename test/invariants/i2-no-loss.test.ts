import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { withReadEffects } from "../../src/effects/read-policy.js";
import { GitSourceDriver } from "../../src/source/git.js";
import { releaseGitSnapshotLease } from "../../src/source/cache.js";
import { pathExists } from "../../src/utils/fs.js";
import { readFixture } from "../helpers/read-effects.js";
import { diffEffects, snapshot } from "../helpers/effects.js";

async function observeIncompleteCacheRead(observe = false) {
  const root = await mkdtemp(join(tmpdir(), "invariant-i2-"));
  try {
    const driver = new GitSourceDriver();
    // Local nonexistent source: clone must fail without network access.
    const resolved = await driver.resolve(`git:file://${join(root, "missing.git")}`, { cacheRoot: join(root, "cache") });
    await mkdir(resolved.resolvedPath, { recursive: true });
    await writeFile(join(resolved.resolvedPath, "sentinel"), "preserve me");
    const before = await snapshot(root);
    const failure = await withReadEffects({ refresh: !observe }, () => driver.fetch(resolved)).then(() => undefined, error => error);
    const cachePath = relative(root, resolved.resolvedPath);
    return { failure, checkoutPath: resolved.resolvedPath, effects: diffEffects(before, await snapshot(root)),
      removedPaths: [`tree:${cachePath}`, `tree:${cachePath}/sentinel`] };

  } finally { await rm(root, { recursive: true, force: true }); }
}

// Expected: a read refuses an incomplete checkout without deleting existing bytes.
it("read_missing_git_preserves_cache", async () => {
  const observed = await observeIncompleteCacheRead();
  expect(observed.failure).toBeInstanceOf(Error);
  expect(observed.effects).toEqual([]);
});

it("read_missing_git_preserves_cache_requires_explicit_repair", async () => {
  const observed = await observeIncompleteCacheRead();
  expect(observed.failure).toBeInstanceOf(Error);
  expect(String(observed.failure)).toMatch(/Incomplete cached checkout preserved/);
  expect(observed.effects).toEqual([]);
});

it.each([false, true])("incomplete_cache_error_names_manual_move_observe_%s", async observe => {
  const observed = await observeIncompleteCacheRead(observe);
  expect(observed.failure).toBeInstanceOf(Error);
  const message = String(observed.failure);
  expect(message).toContain(JSON.stringify(observed.checkoutPath));
  expect(message).toMatch(/Manual repair: move this exact directory.*backup location outside the cache directory/);
  expect(message).toMatch(/Confirm the original directory is absent, then rerun the same scoped command with --refresh/);
  expect(observed.effects).toEqual([]);
});

it("manual_backup_allows_refresh_without_losing_incomplete_checkout_evidence", async () => {
  const fixture = await readFixture(true);
  try {
    await rm(join(fixture.resolved.resolvedPath, ".git"), { recursive: true });
    await writeFile(join(fixture.resolved.resolvedPath, "sentinel"), "preserved evidence");
    const driver = new GitSourceDriver();
    await expect(withReadEffects({refresh:true}, () => driver.fetch(fixture.resolved))).rejects.toThrow(JSON.stringify(fixture.resolved.resolvedPath));
    const backup = join(fixture.root, "checkout-backup");
    // This is the explicit operator step, outside the cache, against a new destination.
    await rename(fixture.resolved.resolvedPath, backup);
    const refreshed = await withReadEffects({refresh:true}, () => driver.fetch(fixture.resolved));
    await releaseGitSnapshotLease(refreshed.cacheLeasePath);
    expect(await readFile(join(backup, "sentinel"), "utf8")).toBe("preserved evidence");
    expect(await pathExists(join(fixture.resolved.resolvedPath, ".git"))).toBe(true);
  } finally { await fixture.dispose(); }
});
