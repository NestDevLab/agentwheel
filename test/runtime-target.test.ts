import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { installRootForAdapterInstallationType, installRootForArtifacts } from "../src/model/adapter.js";
import type { ArtifactType } from "../src/model/artifact.js";
import { applyInstallPlan } from "../src/install/index.js";
import { stateKeyFor } from "../src/install/paths.js";
import { createSourcePlan } from "../src/lifecycle/source-plan.js";
import { syncProfile } from "../src/lifecycle/profile.js";
import { computeTargetFingerprint } from "../src/model/graph-lock.js";
import { readMergedWorkspaceConfig, writeWorkspaceConfig } from "../src/model/workspace.js";
import { resolveAllDetectedRuntimeTargets, resolveAllRuntimeTargets, resolveProfileRuntimeTarget, resolveRuntimeTarget } from "../src/runtime/target.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-target-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "fixture/runtime-target",
    version: "0.1.0",
    provides: [
      { type: "skills", path: "skills" },
    ],
  }, null, 2), "utf8");
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Fixture skill for tests.\n---\n\n# Runtime target skill\n", "utf8");
}

describe("runtime target resolution", () => {
  it("auto-detects cwd inside an OpenClaw runtime dir without nesting", async () => {
    const root = await tempRoot();
    const source = await tempRoot("agentwheel-target-source-");
    await mkdir(join(root, ".openclaw"), { recursive: true });
    await writePackage(source);

    const target = await resolveRuntimeTarget({ cwd: join(root, ".openclaw"), adapter: "openclaw" });
    expect(target.adapter).toBe("openclaw");
    expect(target.targetRoot).toBe(root);

    const result = await createSourcePlan({ source, targetRoot: target.targetRoot, workspaceRoot: target.workspaceRoot, adapter: openClawAdapter });
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).toContain("skills/demo");
    expect(result.plan.operations.map((operation) => operation.relativeDestPath)).not.toContain(".openclaw/skills/demo");
    await rm(result.bundle.root, { recursive: true, force: true });
  });

  it("auto-detects cwd containing a runtime dir as the runtime root", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".openclaw"), { recursive: true });
    const target = await resolveRuntimeTarget({ cwd: root, adapter: "openclaw" });
    expect(target.targetRoot).toBe(root);
    expect(target.source).toBe("auto-detect");
  });

  it("isolates local agents from user desired state", async () => {
    const globalRoot = await tempRoot("agentwheel-global-");
    const project = await tempRoot("agentwheel-project-");
    const globalAgentRoot = join(globalRoot, "global-openclaw");
    const projectAgentRoot = join(project, "project-openclaw");

    await writeWorkspaceConfig(globalRoot, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        lab: { adapter: "openclaw", root: globalAgentRoot, transport: "local" },
        globalOnly: { adapter: "hermes", root: join(globalRoot, "hermes"), transport: "local" },
      },
    });
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        lab: { adapter: "codex", root: projectAgentRoot, transport: "local" },
      },
    });

    const merged = await readMergedWorkspaceConfig(project, { globalRoot });
    expect(merged.agents.lab).toEqual({ adapter: "codex", root: projectAgentRoot, transport: "local" });
    expect(merged.agents.globalOnly).toBeUndefined();
  });

  it("resolves --agent and --all targets to distinct roots with separate manifests", async () => {
    const project = await tempRoot("agentwheel-fleet-");
    const globalRoot = await tempRoot("agentwheel-fleet-global-");
    const source = await tempRoot("agentwheel-fleet-source-");
    const alpha = join(project, "alpha-root");
    const beta = join(project, "beta-root");
    await writePackage(source);
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        alpha: { adapter: "openclaw", root: alpha, transport: "local" },
        beta: { adapter: "openclaw", root: beta, transport: "local" },
      },
    });

    const one = await resolveRuntimeTarget({ cwd: project, agent: "alpha" });
    expect(one.targetRoot).toBe(alpha);
    const all = await resolveAllRuntimeTargets({ cwd: project, all: true, globalRoot });
    expect(all.map((target) => target.targetRoot).sort()).toEqual([alpha, beta].sort());

    for (const target of all) {
      const result = await createSourcePlan({ source, targetRoot: target.targetRoot, workspaceRoot: target.workspaceRoot, adapter: openClawAdapter });
      await applyInstallPlan(result.plan, result.bundle.sourceLock);
      await rm(result.bundle.root, { recursive: true, force: true });
    }
    await expect(stat(join(alpha, ".agentwheel", "openclaw.local.install-manifest.json"))).resolves.toBeTruthy();
    await expect(stat(join(beta, ".agentwheel", "openclaw.local.install-manifest.json"))).resolves.toBeTruthy();
  });

  it("respects target resolution order", async () => {
    const cwd = await tempRoot("agentwheel-order-");
    const explicit = await tempRoot("agentwheel-explicit-");
    const agentRoot = await tempRoot("agentwheel-agent-");
    await mkdir(join(cwd, ".openclaw"), { recursive: true });
    await writeWorkspaceConfig(cwd, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        named: { adapter: "hermes", root: agentRoot, transport: "local" },
      },
    });

    expect((await resolveRuntimeTarget({ cwd, targetRoot: explicit, agent: "named", adapter: "codex" })).targetRoot).toBe(explicit);
    const agent = await resolveRuntimeTarget({ cwd, agent: "named" });
    expect(agent.targetRoot).toBe(agentRoot);
    expect(agent.adapter).toBe("hermes");
    const auto = await resolveRuntimeTarget({ cwd });
    expect(auto.source).toBe("auto-detect");
    expect(auto.targetRoot).toBe(cwd);
    await rm(join(cwd, ".openclaw"), { recursive: true, force: true });
    const fallback = await resolveRuntimeTarget({ cwd, adapter: "codex" });
    expect(fallback.source).toBe("cwd");
    expect(fallback.targetRoot).toBe(cwd);
    expect(fallback.adapter).toBe("codex");
  });

  it("uses an explicit agent state key instead of deriving install-state identity", async () => {
    const project = await tempRoot("agentwheel-explicit-state-");
    const targetRoot = join(project, "runtime");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {
        cutover: {
          runtimes: [{ agent: "legacy", adapter: "codex", stateKey: "codex.user.legacy-fixture" }],
        },
      },
      agents: {
        legacy: {
          adapter: "codex",
          root: targetRoot,
          transport: "local",
          installationType: "user",
          stateKey: "codex.user.original-fixture",
        },
      },
    });

    const agent = await resolveRuntimeTarget({ cwd: project, agent: "legacy" });
    expect(agent.stateKey).toBe("codex.user.original-fixture");
    const config = await readMergedWorkspaceConfig(project);
    const profile = config.profiles.cutover;
    const runtimes = profile && "runtimes" in profile ? profile.runtimes : undefined;
    if (!runtimes) throw new Error("expected leaf profile");
    const profileTarget = resolveProfileRuntimeTarget(runtimes[0]!, config, project);
    expect(profileTarget.stateKey).toBe("codex.user.legacy-fixture");
  });

  it("inherits agent adapter configuration in profile runtimes unless explicitly overridden", async () => {
    const project = await tempRoot("agentwheel-profile-adapter-config-");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      profiles: { selected: { runtimes: [{ agent: "odino", adapter: "hermes" }] } },
      agents: {
        odino: {
          adapter: "hermes",
          root: project,
          adapterConfig: "config/hermes.jsonc",
          adapterModule: "adapters/hermes.mjs",
        },
      },
    });
    const config = await readMergedWorkspaceConfig(project);
    const profile = config.profiles.selected;
    const runtimes = profile && "runtimes" in profile ? profile.runtimes : undefined;
    if (!runtimes) throw new Error("expected leaf profile");
    const target = resolveProfileRuntimeTarget(runtimes[0]!, config, project);
    expect(target.adapterConfig).toBe("config/hermes.jsonc");
    expect(target.adapterModule).toBe("adapters/hermes.mjs");
  });

  it("assigns fleet ownership only from an explicitly resolved fleet scope", async () => {
    const project = await tempRoot("agentwheel-explicit-fleet-target-");
    await writeWorkspaceConfig(project, {
      schemaVersion: 3,
      fleetId: "delivery",
      agents: { runtime: { adapter: "codex", root: project } },
    });

    const localTarget = await resolveRuntimeTarget({ cwd: project, agent: "runtime" });
    expect(localTarget.fleetId).toBeUndefined();

    const fleetTarget = await resolveRuntimeTarget({ cwd: project, agent: "runtime", fleetId: "delivery" });
    expect(fleetTarget.fleetId).toBe("delivery");
  });

  it("rejects unsafe explicit install-state keys", async () => {
    const project = await tempRoot("agentwheel-unsafe-state-");
    await expect(writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        legacy: { adapter: "codex", root: project, transport: "local", stateKey: "../escape" },
      },
    })).rejects.toThrow();
  });

  it("resolves all detected runtime directories without configured agents", async () => {
    const root = await tempRoot("agentwheel-detected-");
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });

    const targets = await resolveAllDetectedRuntimeTargets({ cwd: root });
    expect(targets.map((target) => `${target.adapter}:${target.targetRoot}`).sort()).toEqual([
      `claude:${root}`,
      `codex:${root}`,
    ]);
  });

  it("profiles can reference named agents", async () => {
    const project = await tempRoot("agentwheel-profile-agents-");
    const source = await tempRoot("agentwheel-profile-source-");
    const alpha = join(project, "alpha-root");
    await writePackage(source);
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {
        alpha: { adapter: "openclaw", root: alpha, transport: "local" },
      },
      profiles: {
        default: {
          runtimes: [{ agent: "alpha", adapter: "openclaw" }],
        },
      },
    });

    const results = await syncProfile({
      workspaceRoot: project,
      profile: "default",
      source,
      dryRun: false,
    });
    expect(results[0]?.targetRoot).toBe(alpha);
    await expect(stat(join(alpha, "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    const fingerprint = computeTargetFingerprint({
      adapter: "openclaw",
      installationType: "local",
      adapterConfig: undefined,
      adapterModule: undefined,
      adapterCodeHash: undefined,
      agentName: "alpha",
      targetRoot: alpha,
      transport: "local",
      ssh: undefined,
    });
    const stateKey = stateKeyFor("openclaw", { installationType: "local", targetFingerprint: fingerprint });
    await expect(stat(join(alpha, ".agentwheel", `${stateKey}.install-manifest.json`))).resolves.toBeTruthy();
  });

  it("resolves runtime reload commands from agents and profile overrides", async () => {
    const project = await tempRoot("agentwheel-profile-reload-commands-");
    const alpha = join(project, "alpha-root");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {
        alpha: {
          adapter: "openclaw",
          root: alpha,
          transport: "local",
          reloadCommands: [["systemctl", "restart", "openclaw-alpha.service"]],
        },
      },
      profiles: {
        inherited: {
          runtimes: [{ agent: "alpha" }],
        },
        override: {
          runtimes: [{ agent: "alpha", reloadRuntimes: true, reloadCommands: [["openclaw", "gateway", "reload"]] }],
        },
      },
    });

    const inherited = await resolveRuntimeTarget({ cwd: project, agent: "alpha" });
    const config = await readMergedWorkspaceConfig(project);
    const inheritedFromProfile = resolveProfileRuntimeTarget(
      { agent: "alpha", adapter: "openclaw" },
      config,
      project,
    );
    const overridden = resolveProfileRuntimeTarget(
      { agent: "alpha", adapter: "openclaw", reloadRuntimes: true, reloadCommands: [["openclaw", "gateway", "reload"]] },
      config,
      project,
    );

    expect(inherited.reloadCommands).toEqual([["systemctl", "restart", "openclaw-alpha.service"]]);
    expect(inheritedFromProfile.reloadCommands).toEqual([["systemctl", "restart", "openclaw-alpha.service"]]);
    expect(overridden.reloadRuntimes).toBe(true);
    expect(overridden.reloadCommands).toEqual([["openclaw", "gateway", "reload"]]);
  });

  it("profile runtimes inherit installation type from named agents", async () => {
    const project = await tempRoot("agentwheel-profile-agent-install-type-");
    const source = await tempRoot("agentwheel-profile-agent-install-source-");
    const alpha = join(project, "alpha-root");
    const adapterConfig = join(project, "adapter.json");
    await writePackage(source);
    await writeFile(adapterConfig, JSON.stringify({
      name: "fixture-agent-install-type",
      displayName: "Fixture agent installation type",
      targets: {
        skills: {
          local: { enabled: true, dest: "local-skills" },
          user: { enabled: true, dest: "user-skills" },
        },
      },
    }, null, 2), "utf8");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {
        alpha: { adapter: "openclaw", root: alpha, transport: "local", installationType: "user" },
      },
      profiles: {
        default: {
          runtimes: [{ agent: "alpha", adapterConfig }],
        },
      },
    });

    const results = await syncProfile({
      workspaceRoot: project,
      profile: "default",
      source,
      dryRun: false,
    });

    expect(results[0]?.runtime).toBe("fixture-agent-install-type");
    await expect(stat(join(alpha, "user-skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(alpha, "local-skills", "demo", "SKILL.md"))).rejects.toThrow();
  });

  it("named agents preserve adapter config paths", async () => {
    const project = await tempRoot("agentwheel-agent-adapter-config-");
    const alpha = join(project, "alpha-root");
    const adapterConfig = join(project, "adapter.json");
    await writeFile(adapterConfig, JSON.stringify({
      name: "fixture-agent-adapter-config",
      targets: {
        skills: {
          user: { enabled: true, dest: "user-skills" },
        },
      },
    }, null, 2), "utf8");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {
        alpha: { adapter: "openclaw", adapterConfig, root: alpha, transport: "local", installationType: "user" },
      },
    });

    const target = await resolveRuntimeTarget({ cwd: project, agent: "alpha" });

    expect(target.adapterConfig).toBe(adapterConfig);
    expect(target.installationType).toBe("user");
  });

  it("resolves ssh agents without local path expansion", async () => {
    const project = await tempRoot("agentwheel-ssh-agent-");
    await writeWorkspaceConfig(project, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      profiles: {},
      agents: {
        remote: {
          adapter: "codex",
          root: "/srv/agent-runtime",
          transport: "ssh",
          host: "ct110.example.test",
          user: "administrator",
          port: 2222,
          identityFile: ".ssh/id_ed25519",
        },
      },
    });

    const target = await resolveRuntimeTarget({ cwd: project, agent: "remote" });
    expect(target.adapter).toBe("codex");
    expect(target.targetRoot).toBe("/srv/agent-runtime");
    expect(target.transport).toBe("ssh");
    expect(target.ssh).toEqual({
      host: "ct110.example.test",
      user: "administrator",
      port: 2222,
      identityFile: join(project, ".ssh/id_ed25519"),
    });
  });

  it("can plan and apply through a non-local target transport", async () => {
    const project = await tempRoot("agentwheel-transport-project-");
    const source = await tempRoot("agentwheel-transport-source-");
    const remoteRoot = join(project, "remote-root");
    await writePackage(source);

    const transport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "fake ssh transport",
    };

    const result = await createSourcePlan({
      source,
      targetRoot: remoteRoot,
      workspaceRoot: project,
      adapter: openClawAdapter,
      transport,
    });
    await applyInstallPlan(result.plan, result.bundle.sourceLock, { transport });
    await rm(result.bundle.root, { recursive: true, force: true });

    await expect(stat(join(remoteRoot, "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(remoteRoot, ".agentwheel", "openclaw.local.install-manifest.json"))).resolves.toBeTruthy();
  });

  it("home-rooted user install uses the remote agent root over ssh, the local home otherwise", () => {
    const remoteHome = "/home/remote-user";
    // over ssh the user's home is the remote agent root (= targetRoot), not the orchestrator's local os.homedir()
    expect(installRootForAdapterInstallationType(openClawAdapter, remoteHome, "user", true)).toBe(remoteHome);
    expect(installRootForArtifacts(openClawAdapter, remoteHome, "user", ["skills"] as ArtifactType[], true)).toBe(remoteHome);
    // locally it stays the orchestrator's home, never the passed (remote) target root
    expect(installRootForAdapterInstallationType(openClawAdapter, remoteHome, "user", false)).not.toBe(remoteHome);
  });
});
