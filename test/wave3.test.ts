import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { attachOpenClawProgrammatic } from "../src/adapters/openclaw.js";
import { loadProgrammaticAdapter } from "../src/adapters/programmatic.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../src/install/index.js";
import { syncProfile } from "../src/lifecycle/profile.js";
import { writeWorkspaceConfig } from "../src/model/workspace.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource } from "../src/staging/staging.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-wave3-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "mcp"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "settings"), { recursive: true });
  await writeFile(join(root, "openpack.json"), JSON.stringify({
    schemaVersion: 2,
    name: "acme/wave3",
    version: "0.3.0",
    provides: [
      { type: "instructions", path: "instructions/AGENTS.md" },
      { type: "skills", path: "skills" },
      { type: "mcp", path: "mcp" },
      { type: "hooks", path: "hooks" },
      { type: "settings", path: "settings/settings.json" },
    ],
  }, null, 2));
  await writeFile(join(root, "instructions", "AGENTS.md"), "# Wave 3\n", "utf8");
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
  await writeFile(join(root, "mcp", "server.json"), JSON.stringify({
    mcpServers: { managed: { command: "managed" } },
    order: ["managed"],
  }, null, 2), "utf8");
  await writeFile(join(root, "hooks", "events.json"), JSON.stringify({
    hooks: { managed: { command: "managed-hook" } },
  }, null, 2), "utf8");
  await writeFile(join(root, "settings", "settings.json"), JSON.stringify({
    feature: { managed: true },
    order: ["managed"],
  }, null, 2), "utf8");
}

describe("v0.3 wave 3", () => {
  it("loads programmatic adapters only with an explicit code flag and records their hash", async () => {
    const root = await tempRoot();
    const modulePath = join(root, "adapter.js");
    await writeFile(modulePath, `
      import { mkdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";

      export const adapter = {
        name: "private-runtime",
        displayName: "Private Runtime",
        targets: {
          skills: { enabled: true, dest: ".private/skills" }
        },
        capabilities: ["programmatic-test"],
        plan() {
          return [{ name: "marker", reason: "write marker" }];
        },
        async apply(operation, context) {
          await mkdir(context.targetRoot, { recursive: true });
          await writeFile(join(context.targetRoot, "programmatic-marker.txt"), operation.name, "utf8");
        },
        async uninstall(context) {
          await writeFile(join(context.targetRoot, "programmatic-uninstall.txt"), "ok", "utf8");
        }
      };
    `, "utf8");

    await expect(loadProgrammaticAdapter(modulePath, { allowCode: false })).rejects.toThrow("--allow-adapter-code");
    const adapter = await loadProgrammaticAdapter(modulePath, { allowCode: true });
    expect(adapter.programmatic?.capabilities).toEqual(["programmatic-test"]);

    const source = await tempRoot();
    await writePackage(source);
    const bundle = await stageSource(new LocalSourceDriver(), source);
    const plan = await createInstallPlan(bundle, adapter, root);
    expect(plan.operations.some((operation) => operation.action === "program")).toBe(true);
    const manifest = await applyInstallPlan(plan, bundle.sourceLock);

    expect(await readFile(join(root, "programmatic-marker.txt"), "utf8")).toBe("marker");
    expect(manifest.adapterCode?.modulePath).toBe(modulePath);
    expect(manifest.adapterCode?.hash).toBe(adapter.programmatic?.hash);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("loads local TypeScript adapter modules when code execution is explicitly allowed", async () => {
    const root = await tempRoot();
    const modulePath = join(root, "adapter.ts");
    await writeFile(modulePath, `
      import type { ProgrammaticAdapterOperation } from "${join(process.cwd(), "src", "model", "adapter.ts").replaceAll("\\", "/")}";

      export const adapter = {
        name: "private-ts-runtime",
        targets: {
          skills: { enabled: true, dest: ".private-ts/skills" }
        },
        plan(): ProgrammaticAdapterOperation[] {
          return [{ name: "typed" }];
        }
      };
    `, "utf8");

    const adapter = await loadProgrammaticAdapter(modulePath, { allowCode: true });
    expect(adapter.name).toBe("private-ts-runtime");
    expect(await adapter.programmatic?.plan?.({ targetRoot: root, adapterName: adapter.name })).toEqual([{ name: "typed" }]);
  });

  it("deep-merges JSON artifacts while preserving user-owned keys", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);
    await mkdir(join(target, ".openclaw", "mcp"), { recursive: true });
    await writeFile(join(target, ".openclaw", "mcp", "server.json"), JSON.stringify({
      mcpServers: { user: { command: "user" } },
      userOnly: true,
      order: ["user", "managed"],
    }, null, 2), "utf8");

    const bundle = await stageSource(new LocalSourceDriver(), source);
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    const merge = plan.operations.find((operation) => operation.relativeDestPath === ".openclaw/mcp/server.json");
    expect(merge?.action).toBe("update");
    expect(merge?.mergeStrategy).toBe("json-deep");
    await applyInstallPlan(plan, bundle.sourceLock);

    const merged = JSON.parse(await readFile(join(target, ".openclaw", "mcp", "server.json"), "utf8"));
    expect(merged.mcpServers.user.command).toBe("user");
    expect(merged.mcpServers.managed.command).toBe("managed");
    expect(merged.userOnly).toBe(true);
    expect(merged.order).toEqual(["user", "managed"]);
    const manifest = await readInstallManifest(target, "openclaw");
    expect(manifest?.entries.find((entry) => entry.path === ".openclaw/mcp/server.json")?.mergeStrategy).toBe("json-deep");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("updates explicit OpenClaw per-agent skill allowlists when enabled by adapter config", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);
    await mkdir(join(target, ".openclaw"), { recursive: true });
    await writeFile(join(target, ".openclaw", "openclaw.json"), JSON.stringify({
      agents: {
        list: [
          { id: "main", name: "Main" },
          { id: "guardian", name: "Guardian", skills: [] },
          { id: "reviewer", name: "Reviewer", skills: ["existing"] },
          { id: "light-test", name: "Light Test", skills: [] },
        ],
      },
    }, null, 2), "utf8");

    const adapter = attachOpenClawProgrammatic({
      ...openClawAdapter,
      openclaw: {
        agentSkills: {
          enabled: true,
          configPath: ".openclaw/openclaw.json",
          mode: "append-managed",
          agents: { include: ["guardian", "reviewer"], exclude: ["light-test"] },
          includeAgentsWithoutExplicitSkills: false,
        },
      },
    });
    const bundle = await stageSource(new LocalSourceDriver(), source);
    const plan = await createInstallPlan(bundle, adapter, target);

    const program = plan.operations.find((operation) => operation.relativeDestPath === "programmatic/openclaw-agent-skills");
    expect(program?.action).toBe("program");
    expect(program?.reason).toContain("guardian");
    expect(program?.reason).toContain("reviewer");
    expect(program?.reason).not.toContain("light-test");

    const manifest = await applyInstallPlan(plan, bundle.sourceLock);
    const config = JSON.parse(await readFile(join(target, ".openclaw", "openclaw.json"), "utf8"));
    expect(config.agents.list.find((agent: { id: string }) => agent.id === "main").skills).toBeUndefined();
    expect(config.agents.list.find((agent: { id: string }) => agent.id === "guardian").skills).toEqual(["demo"]);
    expect(config.agents.list.find((agent: { id: string }) => agent.id === "reviewer").skills).toEqual(["existing", "demo"]);
    expect(config.agents.list.find((agent: { id: string }) => agent.id === "light-test").skills).toEqual([]);
    expect(manifest.entries.find((entry) => entry.path === "programmatic/openclaw-agent-skills")?.sourceHash).toBe(program?.desiredHash);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("combines OpenClaw agent skill maintenance with custom programmatic adapters", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writePackage(source);
    await mkdir(join(target, ".openclaw"), { recursive: true });
    await writeFile(join(target, ".openclaw", "openclaw.json"), JSON.stringify({
      agents: { list: [{ id: "custom", skills: [] }] },
    }, null, 2), "utf8");

    const adapter = attachOpenClawProgrammatic({
      ...openClawAdapter,
      name: "openclaw-custom",
      programmatic: {
        modulePath: "custom-adapter",
        hash: "custom-hash",
        capabilities: ["custom"],
        plan: () => [{ name: "custom-marker", hash: "custom-marker-hash", reason: "custom marker" }],
        apply: async (operation, context) => {
          await writeFile(join(context.targetRoot, `${operation.name}.txt`), "ok", "utf8");
        },
      },
      openclaw: {
        agentSkills: {
          enabled: true,
          configPath: ".openclaw/openclaw.json",
          mode: "append-managed",
          agents: { include: ["custom"] },
          includeAgentsWithoutExplicitSkills: false,
        },
      },
    });

    const bundle = await stageSource(new LocalSourceDriver(), source);
    const plan = await createInstallPlan(bundle, adapter, target);
    expect(plan.operations.some((operation) => operation.relativeDestPath === "programmatic/custom-marker")).toBe(true);
    expect(plan.operations.some((operation) => operation.relativeDestPath === "programmatic/openclaw-agent-skills")).toBe(true);

    await applyInstallPlan(plan, bundle.sourceLock);
    expect(await readFile(join(target, "custom-marker.txt"), "utf8")).toBe("ok");
    const config = JSON.parse(await readFile(join(target, ".openclaw", "openclaw.json"), "utf8"));
    expect(config.agents.list.find((agent: { id: string }) => agent.id === "custom").skills).toEqual(["demo"]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("syncs a profile across multiple runtimes", async () => {
    const source = await tempRoot();
    const workspace = await tempRoot();
    await writePackage(source);
    await writeWorkspaceConfig(workspace, {
      schemaVersion: 1,
      packages: [],
      registry: {},
      agents: {},
      profiles: {
        lab: {
          runtimes: [
            { adapter: "openclaw" },
            { adapter: "hermes" },
          ],
        },
      },
    });

    const results = await syncProfile({
      workspaceRoot: workspace,
      profile: "lab",
      source,
    });

    expect(results.map((result) => result.runtime).sort()).toEqual(["hermes", "openclaw"]);
    await expect(stat(join(workspace, ".openclaw", "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(workspace, ".hermes", "skills", "demo", "SKILL.md"))).resolves.toBeTruthy();
  });
});
