import { describe, expect, it, vi } from "vitest";
import { createOpenClawCapabilityDetector, openClawPluginInstallCommand } from "../src/targets/plugins/openclaw.js";

describe("OpenClaw plugin capability consent", () => {
  it.each([
    ["Usage: openclaw plugins install\nOptions:\n  --force\n  --accept-capabilities  Accept managed plugin capabilities", true],
    ["Usage: openclaw plugins install\nOptions:\n  --force  Replace installed plugin", false],
  ])("detects support from command help: %s", async (help, supported) => {
    const run = vi.fn(async () => help);
    const detect = createOpenClawCapabilityDetector(run);
    expect(await detect()).toBe(supported);
    expect(run.mock.calls).toEqual([[["plugins", "install", "--help"]]]);
    expect(openClawPluginInstallCommand({ path: "plugin-source", dryRun: false, acceptCapabilities: await detect() }))
      .toEqual(["openclaw", "plugins", "install", "--force", ...(supported ? ["--accept-capabilities"] : []), "plugin-source"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["2026.7.2-beta.7", false],
    ["2026.8.1-beta.1", false],
    ["2026.8.1", true],
    ["OpenClaw 2026.9.34\n", true],
    ["v2026.9.34+build.1", true],
    ["unknown", false],
  ])("falls back to semantic version %s", async (version, supported) => {
    const run = vi.fn<(args: string[]) => Promise<string>>()
      .mockRejectedValueOnce(new Error("help unavailable"))
      .mockResolvedValueOnce(version);
    const detect = createOpenClawCapabilityDetector(run);
    expect(await detect()).toBe(supported);
    expect(run.mock.calls).toEqual([[["plugins", "install", "--help"]], [["--version"]]]);
  });

  it("caches concurrent probes within one run and probes again in a new run", async () => {
    const run = vi.fn(async () => "--accept-capabilities");
    const detect = createOpenClawCapabilityDetector(run);
    expect(await Promise.all([detect(), detect(), detect()])).toEqual([true, true, true]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await createOpenClawCapabilityDetector(run)()).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back on empty help output", async () => {
    const run = vi.fn<(args: string[]) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2026.8.1");
    expect(await createOpenClawCapabilityDetector(run)()).toBe(true);
  });

  it("keeps the existing command and caches failure when both probes fail", async () => {
    const run = vi.fn(async () => { throw new Error("runtime unavailable"); });
    const detect = createOpenClawCapabilityDetector(run);
    expect(await detect()).toBe(false);
    expect(openClawPluginInstallCommand({ path: "plugin-source", dryRun: false, acceptCapabilities: await detect() }))
      .toEqual(["openclaw", "plugins", "install", "--force", "plugin-source"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing command when a transport cannot return output", async () => {
    const detect = createOpenClawCapabilityDetector(async () => undefined);
    expect(await detect()).toBe(false);
  });
});
