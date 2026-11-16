import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { diffEffects, snapshot } from "./helpers/effects.js";

it("detects bytes, modes, symlinks, claims, index and refs without following links", async () => {
  const root = await mkdtemp(join(tmpdir(), "effects-harness-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "-b", "main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    await writeFile(join(root, "file"), Buffer.from([0,255,1]));
    await writeFile(join(root, "manifest.json"), JSON.stringify({ entries: [{ owner: "alpha" }] }));
    await symlink("file", join(root,"link"));
    git("add", "file"); git("commit", "-m", "fixture");
    const policy = { manifests: ["manifest.json"], git: true };
    const before = await snapshot(root, policy);
    expect(diffEffects(before, await snapshot(root,policy))).toEqual([]);
    await writeFile(join(root,"file"), Buffer.from([0,255,2]));
    await chmod(join(root,"file"), 0o755);
    await rm(join(root,"link")); await symlink("missing",join(root,"link"));
    await writeFile(join(root,"manifest.json"), JSON.stringify({ entries: [{ owner: "beta" }] }));
    git("add", "file"); git("branch", "other");
    const changes = diffEffects(before, await snapshot(root,policy));
    expect(changes).toEqual(expect.arrayContaining(["tree:file", "tree:link", "claims:manifest.json", "git:index", "git:refs"]));
    await expect(snapshot(root, { exclude: { "**": "invalid" } })).rejects.toThrow(/exact/);
    await expect(snapshot(root, { exclude: { "file": "" } })).rejects.toThrow(/reason/);
    const excluded = { exclude: { "file": "This fixture explicitly ignores the mutable file payload." } };
    expect((await snapshot(root,excluded)).tree.file).toBeUndefined();
    await expect(snapshot(root, { manifests: ["manifest.json"], exclude: { "manifest.json": "invalid claim exclusion" } })).rejects.toThrow(/claims/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
