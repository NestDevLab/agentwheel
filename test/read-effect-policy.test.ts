import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withReadEffects, isObservation, readEffectPolicy } from "../src/effects/read-policy.js";
import { createGitSnapshotLease, pruneGitCache } from "../src/source/cache.js";
import { maybeCheckForUpdate } from "../src/cli/update-check.js";
import { collectCompositeMembers } from "../src/profile/members.js";
import { diffEffects, snapshot } from "./helpers/effects.js";

it("preserves context across asynchronous work and restores the caller scope", async () => {
  expect(isObservation()).toBe(false);
  await withReadEffects({}, async () => {
    await Promise.resolve(); expect(isObservation()).toBe(true);
    await withReadEffects({refresh:true}, async () => { expect(isObservation()).toBe(false); });
    expect(isObservation()).toBe(true);
  });
  expect(isObservation()).toBe(false);
  expect(readEffectPolicy({refresh:true,offline:true})).toBe("observe");
});

it("refuses persistent lease and prune helpers before touching an observation tree", async () => {
  const root = await mkdtemp(join(tmpdir(),"synthetic-policy-"));
  try {
    const before = await snapshot(root);
    await withReadEffects({}, async () => {
      await expect(createGitSnapshotLease(join(root,"snapshot"))).rejects.toThrow(/Observation refuses/);
      await expect(pruneGitCache(root)).rejects.toThrow(/Observation refuses/);
    });
    expect(diffEffects(before,await snapshot(root))).toEqual([]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

it("does not fetch or write update notices on an interactive status read", async () => {
  let calls=0;
  await maybeCheckForUpdate({currentVersion:"1.0.0",argv:["node","cli","status"],env:{},isTTY:true,
    fetchImpl: async () => {calls++; throw new Error("unexpected network");}});
  expect(calls).toBe(0);
});

it("does not invoke or cache an uncached composite member during observation", async () => {
  const root = await mkdtemp(join(tmpdir(),"synthetic-members-"));
  try {
    const before = await snapshot(root);
    const members = await withReadEffects({}, () => collectCompositeMembers({cliVersion:"1.0.0",workspaceRoot:root,
      profileName:"synthetic",profileTtlSeconds:1,members:[{id:"leaf",workspace:root,profile:"synthetic",transport:"local"}]}));
    expect(members[0]?.error).toMatch(/No cached member status/);
    expect(diffEffects(before,await snapshot(root))).toEqual([]);
  } finally {await rm(root,{recursive:true,force:true});}
});
