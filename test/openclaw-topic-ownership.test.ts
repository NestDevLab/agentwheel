import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { inspectOpenClawTopicOwnership } from "../src/lifecycle/openclaw-topic-ownership.js";
import type { InstallManifestEntry } from "../src/model/manifest.js";

const source = "openclaw.user.topic-source";
const chatId = "-10012345";
const topicId = "85";
const sourceOwner = "workspace-root:/fixture/source";
const time = "2026-01-01T00:00:00Z";
const path = ".openclaw/openclaw.json";

function atTopic(topic: NonNullable<InstallManifestEntry["mergeRemoval"]>) {
  return { channels: { telegram: { groups: { [chatId]: { topics: { [topicId]: topic } } } } } };
}

async function withFixture(task: (root: string, writeClaim: (key: string, delta: InstallManifestEntry["mergeRemoval"]) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-topic-transfer-"));
  try {
    await mkdir(join(root, ".openclaw"));
    await writeFile(join(root, path), JSON.stringify({
      ...atTopic({ skills: ["fixture-skill"], systemPrompt: "private fixture wording", keep: true }),
      plugins: { entries: { independent: { enabled: true } } },
    }));
    const writeClaim = (stateKey: string, delta: InstallManifestEntry["mergeRemoval"]) => writeInstallManifest({
      version: 2, adapter: "openclaw", installationType: "user", stateKey, targetRoot: root,
      revision: "pending-fixture-revision", generatedAt: time, legacy: false,
      entries: [{
        path, artifactType: "settings", artifactName: "fixture.json", installName: "fixture.json", kind: "file",
        hash: "a".repeat(64), sourceHash: "b".repeat(64), updatedAt: time, channel: "managed",
        dependencyRole: "root", owners: ["fixture"], refCount: 1,
        workspaceOwner: stateKey === source ? sourceOwner : "workspace-root:/fixture/other",
        mergeStrategy: "openclaw-json-deep", ...(delta === undefined ? {} : { mergeRemoval: delta }),
      }],
    });
    await writeClaim(source, atTopic({ skills: ["fixture-skill"], systemPrompt: "private fixture wording", keep: true }));
    await task(root, writeClaim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function inspect(targetRoot: string) {
  return inspectOpenClawTopicOwnership({ targetRoot, installationType: "user", sourceStateKey: source, sourceOwner, chatId, topicId });
}

describe("OpenClaw topic transfer inspection", () => {
  it("binds the exact two keys, omits config values, and preserves all bytes", () => withFixture(async (root, claim) => {
    await claim("openclaw.user.independent", { plugins: { entries: { independent: { enabled: true } } } });
    const config = join(root, path);
    const manifest = installManifestPath(root, "openclaw", { installationType: "user", stateKey: source });
    const before = await Promise.all([readFile(config), readFile(manifest)]);
    const plan = await inspect(root);
    expect(plan).toMatchObject({ status: "verified", keys: ["skills", "systemPrompt"], conflicts: [] });
    expect(JSON.stringify(plan)).not.toContain("private fixture wording");
    expect(await inspect(root)).toEqual(plan);
    expect(await Promise.all([readFile(config), readFile(manifest)])).toEqual(before);
  }));

  it("holds four legacy claims without a delta and a second claim on the same setting", () => withFixture(async (root, claim) => {
    for (const name of ["one", "two", "three"]) await claim("openclaw.user." + name, {});
    await claim("openclaw.user.four", undefined);
    await claim("openclaw.user.overlap", atTopic({ skills: ["fixture-skill"] }));
    const plan = await inspect(root);
    expect(plan.status).toBe("blocked");
    expect(plan.conflicts.filter((conflict) => conflict.reason === "unknown-contribution")).toHaveLength(4);
    expect(plan.conflicts).toContainEqual({ stateKey: "openclaw.user.overlap", reason: "overlapping-contribution" });
  }));

  it("refuses settings whose recorded values are no longer present", () => withFixture(async (root) => {
    await writeFile(join(root, path), JSON.stringify(atTopic({ skills: ["fixture-skill"], systemPrompt: "changed", keep: true })));
    await expect(inspect(root)).rejects.toThrow("exact merge contribution differs");
  }));
});
