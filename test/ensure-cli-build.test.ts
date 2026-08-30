import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCliBuildLock } from "./helpers/ensure-cli-build.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI test build lock", () => {
  it("reaps a lock whose recorded owner process is stale", async () => {
    const root = join(tmpdir(), `agentwheel-build-lock-test-${process.pid}-${Date.now()}`);
    roots.push(root);
    const lock = join(root, "build.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({
      version: 1,
      pid: process.pid + 10_000_000,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`, "utf8");

    const release = await acquireCliBuildLock(lock, 1_000);
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    await release();
  });
});
