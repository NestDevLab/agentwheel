import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, maybeCheckForUpdate } from "../src/cli/update-check.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-update-check-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fetchLatest(version: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ "dist-tags": { latest: version } }),
  })) as unknown as typeof fetch;
}

describe("update check", () => {
  it("warns on stderr when npm latest is newer than the current version", async () => {
    const root = await tempRoot();
    let output = "";
    await maybeCheckForUpdate({
      currentVersion: "0.5.0",
      cachePath: join(root, "update-check.json"),
      fetchImpl: fetchLatest("0.5.1"),
      stderr: { write: (message) => { output += message; } },
      env: {},
      argv: [],
      isTTY: true,
      now: () => new Date("2026-06-08T00:00:00Z"),
    });

    expect(output).toContain("agentwheel 0.5.1 is available (you have 0.5.0)");
  });

  it("does not warn when versions are equal", async () => {
    const root = await tempRoot();
    let output = "";
    await maybeCheckForUpdate({
      currentVersion: "0.5.0",
      cachePath: join(root, "update-check.json"),
      fetchImpl: fetchLatest("0.5.0"),
      stderr: { write: (message) => { output += message; } },
      env: {},
      argv: [],
      isTTY: true,
      now: () => new Date("2026-06-08T00:00:00Z"),
    });

    expect(output).toBe("");
  });

  it("uses fresh cache and avoids network for 24 hours", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "update-check.json");
    await writeFile(cachePath, JSON.stringify({ checkedAt: "2026-06-08T00:00:00.000Z", latest: "0.5.2" }), "utf8");
    const fetchImpl = fetchLatest("9.9.9");
    let output = "";

    await maybeCheckForUpdate({
      currentVersion: "0.5.0",
      cachePath,
      fetchImpl,
      stderr: { write: (message) => { output += message; } },
      env: {},
      argv: [],
      isTTY: true,
      now: () => new Date("2026-06-08T12:00:00Z"),
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toContain("agentwheel 0.5.2 is available");
  });

  it("refreshes expired cache and stores the latest version", async () => {
    const root = await tempRoot();
    const cachePath = join(root, "update-check.json");
    await writeFile(cachePath, JSON.stringify({ checkedAt: "2026-06-06T00:00:00.000Z", latest: "0.5.0" }), "utf8");

    await maybeCheckForUpdate({
      currentVersion: "0.5.0",
      cachePath,
      fetchImpl: fetchLatest("0.5.3"),
      stderr: { write: () => undefined },
      env: {},
      argv: [],
      isTTY: true,
      now: () => new Date("2026-06-08T00:00:00Z"),
    });

    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ latest: "0.5.3" });
  });

  it("skips when disabled by env, flag, CI, or non-interactive stderr", async () => {
    for (const options of [
      { env: { AGENTWHEEL_NO_UPDATE_CHECK: "1" }, argv: [], isTTY: true },
      { env: {}, argv: ["agentwheel", "--no-update-check"], isTTY: true },
      { env: {}, argv: ["agentwheel", "install", "--offline"], isTTY: true },
      { env: { CI: "true" }, argv: [], isTTY: true },
      { env: {}, argv: [], isTTY: false },
    ]) {
      const fetchImpl = fetchLatest("0.5.9");
      let output = "";
      await maybeCheckForUpdate({
        currentVersion: "0.5.0",
        cachePath: join(await tempRoot(), "update-check.json"),
        fetchImpl,
        stderr: { write: (message) => { output += message; } },
        ...options,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(output).toBe("");
    }
  });

  it("compares dotted semantic versions", () => {
    expect(compareVersions("0.5.10", "0.5.2")).toBe(1);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
    expect(compareVersions("0.4.9", "0.5.0")).toBe(-1);
  });
});
