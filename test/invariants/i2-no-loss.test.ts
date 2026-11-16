import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitSourceDriver } from "../../src/source/git.js";
import { diffEffects, snapshot } from "../helpers/effects.js";

it("read_missing_git_preserves_cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "invariant-i2-"));
  try {
    const driver = new GitSourceDriver();
    // Local nonexistent source: clone must fail without network access.
    const resolved = await driver.resolve(`git:file://${join(root, "missing.git")}`, { cacheRoot: join(root, "cache") });
    await mkdir(resolved.resolvedPath, { recursive: true });
    await writeFile(join(resolved.resolvedPath, "sentinel"), "preserve me");
    const before = await snapshot(root);
    const failure = await driver.fetch(resolved).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    // Expected: a read refuses an incomplete checkout without deleting existing bytes.
    expect(diffEffects(before, await snapshot(root))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
