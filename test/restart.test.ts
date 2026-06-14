import { describe, expect, it } from "vitest";
import { restartAdviceForPlan, formatRestartAdvice } from "../src/runtime/restart.js";
import type { InstallPlan } from "../src/install/plan.js";
import type { RuntimeTarget } from "../src/runtime/target.js";

describe("runtime restart advice", () => {
  it("suggests configured gateway restarts for changed OpenClaw targets", () => {
    const advice = restartAdviceForPlan(plan("openclaw-native-clean", "update"), target({
      adapter: "openclaw",
      agentName: "ct110-native-clean",
      restart: { service: "openclaw-native-clean.service", sudo: true },
    }));

    expect(advice?.kind).toBe("restart");
    expect(advice?.command).toEqual(["sudo", "systemctl", "restart", "openclaw-native-clean.service"]);
    expect(formatRestartAdvice(advice!, { execute: true })).toContain("Running configured command");
  });

  it("suggests session refreshes for changed Codex targets without restart commands", () => {
    const advice = restartAdviceForPlan(plan("codex", "create"), target({ adapter: "codex" }));

    expect(advice?.kind).toBe("session");
    expect(advice?.command).toBeUndefined();
    expect(formatRestartAdvice(advice!)).toContain("new session");
  });

  it("does not suggest restarts when the plan has no runtime changes", () => {
    expect(restartAdviceForPlan(plan("openclaw", "skip"), target({ adapter: "openclaw" }))).toBeUndefined();
  });
});

function plan(adapter: string, action: InstallPlan["operations"][number]["action"]): InstallPlan {
  return {
    adapter,
    targetRoot: "/tmp/runtime",
    baseRevision: null,
    hasBlockingChanges: false,
    operations: [{
      action,
      artifactType: "skills",
      artifactName: "demo",
      kind: "dir",
      destPath: "/tmp/runtime/.runtime/skills/demo",
      relativeDestPath: ".runtime/skills/demo",
      reason: "test",
      channel: "managed",
    }],
  };
}

function target(overrides: Partial<RuntimeTarget>): RuntimeTarget {
  return {
    adapter: "openclaw",
    targetRoot: "/tmp/runtime",
    workspaceRoot: "/tmp/runtime",
    transport: "local",
    source: "target-root",
    ...overrides,
  };
}
