import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { GitSourceDriver } from "../../src/source/git.js";
import { diffEffects, snapshot } from "../helpers/effects.js";

async function observeIncompleteCacheRead() {
  const root = await mkdtemp(join(tmpdir(), "invariant-i2-"));
  try {
    const driver = new GitSourceDriver();
    // Local nonexistent source: clone must fail without network access.
    const resolved = await driver.resolve(`git:file://${join(root, "missing.git")}`, { cacheRoot: join(root, "cache") });
    await mkdir(resolved.resolvedPath, { recursive: true });
    await writeFile(join(resolved.resolvedPath, "sentinel"), "preserve me");
    const before = await snapshot(root);
    const failure = await driver.fetch(resolved).then(() => undefined, error => error);
    const cachePath = relative(root, resolved.resolvedPath);
    return { failure, effects: diffEffects(before, await snapshot(root)),
      removedPaths: [`tree:${cachePath}`, `tree:${cachePath}/sentinel`] };

  } finally { await rm(root, { recursive: true, force: true }); }
}

// Expected: a read refuses an incomplete checkout without deleting existing bytes.
it.fails("read_missing_git_preserves_cache", async () => {
  const observed = await observeIncompleteCacheRead();
  expect(observed.failure).toBeInstanceOf(Error);
  expect(observed.effects).toEqual([]);
});

it("read_missing_git_preserves_cache_current_defect_deletes_only_sentinel_tree", async () => {
  const observed = await observeIncompleteCacheRead();
  expect(observed.failure).toBeInstanceOf(Error);
  expect(observed.effects).toEqual(observed.removedPaths);
});
