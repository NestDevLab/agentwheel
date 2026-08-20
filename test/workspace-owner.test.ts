import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkspaceOwner, workspaceOwnerForRoot } from "../src/model/workspace-owner.js";

describe("workspace owner identity", () => {
  it("keeps delimiter-bearing roots distinct from fleet-qualified owners and roundtrips both", () => {
    const delimiterRoot = resolve("/tmp/control|fleet-id:alpha");
    const ordinaryRoot = resolve("/tmp/control");
    const delimiterOwner = workspaceOwnerForRoot(delimiterRoot);
    const fleetOwner = workspaceOwnerForRoot(ordinaryRoot, "alpha");

    expect(delimiterOwner).not.toBe(fleetOwner);
    expect(parseWorkspaceOwner(delimiterOwner)).toEqual({ root: delimiterRoot });
    expect(parseWorkspaceOwner(fleetOwner)).toEqual({ root: ordinaryRoot, fleetId: "alpha" });
    expect(workspaceOwnerForRoot(parseWorkspaceOwner(delimiterOwner)!.root)).toBe(delimiterOwner);
    expect(workspaceOwnerForRoot(parseWorkspaceOwner(fleetOwner)!.root, parseWorkspaceOwner(fleetOwner)!.fleetId))
      .toBe(fleetOwner);
  });

  it("preserves the existing ordinary owner representation", () => {
    const root = resolve("/tmp/ordinary-control-plane");
    expect(workspaceOwnerForRoot(root)).toBe(`workspace-root:${root}`);
    expect(workspaceOwnerForRoot(root, "delivery")).toBe(`workspace-root:${root}|fleet-id:delivery`);
  });
});
