import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { refuseNewPinCollisions } from "../../src/lifecycle/pin-preflight.js";
import { diffEffects, snapshot } from "../helpers/effects.js";

it.fails("pin_provenance_and_feature_floor_enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "invariant-i7-"));
  try {
    const before = await snapshot(root);
    const warnings: string[] = [];
    const failure = await refuseNewPinCollisions(root, {
      schemaVersion: 1, packages: [{ name: "synthetic-pin", source: join(root, "unresolvable"), mode: "pinned" }],
    }, message => warnings.push(message)).then(() => undefined, error => error);
    expect(diffEffects(before, await snapshot(root))).toEqual([]);
    // Expected: an unresolved approved pin refuses; warning and success are insufficient.
    expect({ refused: failure instanceof Error, warnings }).toMatchObject({ refused: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
