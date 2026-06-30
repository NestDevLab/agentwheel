import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { getSourceDriver } from "../src/source/index.js";
import { ClawHubSourceDriver } from "../src/source/clawhub.js";
import { McpRegistrySourceDriver } from "../src/source/mcp-registry.js";
import { SkillKitSourceDriver } from "../src/source/skillkit.js";
import { resolveVercelSkillSubpath, VercelSkillsSourceDriver } from "../src/source/vercel-skills.js";
import { stageSource } from "../src/staging/staging.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-source-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeSkill(dir: string, name: string, description = "A deterministic offline test skill."): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Use this skill for offline agentwheel tests.",
    "",
  ].join("\n"), "utf8");
}

describe("v0.3 source drivers", () => {
  it("registers skill ecosystem source drivers", () => {
    expect(getSourceDriver("skillkit").name).toBe("skillkit");
    expect(getSourceDriver("vercel-skills").name).toBe("vercel-skills");
    expect(getSourceDriver("mcp-registry").name).toBe("mcp-registry");
    expect(getSourceDriver("clawhub").name).toBe("clawhub");
  });

  it("stages SkillKit skills through the SourceDriver contract without network", async () => {
    const source = await tempRoot();
    const target = await tempRoot();
    await writeSkill(join(source, "skillkit-demo"), "skillkit-demo");

    const calls = { discover: 0, scan: 0, translate: 0 };
    const fakeCore = {
      discoverSkills(rootDir: string) {
        calls.discover++;
        return [{ name: "skillkit-demo", path: join(rootDir, "skillkit-demo") }];
      },
      translateSkill() {
        calls.translate++;
        return { success: true, content: "", filename: "SKILL.md" };
      },
      SkillScanner: class {
        async scan() {
          calls.scan++;
          return { verdict: "pass", findings: [] };
        }
      },
    };

    const driver = new SkillKitSourceDriver(fakeCore);
    const resolved = await driver.resolve(`skillkit:${source}`);
    const scan = await driver.scan(resolved);
    const bundle = await stageSource(driver, `skillkit:${source}`);
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    await applyInstallPlan(plan, bundle.sourceLock);

    expect(scan.ok).toBe(true);
    expect(calls.discover).toBeGreaterThanOrEqual(2);
    expect(calls.scan).toBe(1);
    expect(calls.translate).toBe(1);
    expect(bundle.source.driver).toBe("skillkit");
    expect(bundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`)).toEqual(["skills:skillkit-demo"]);
    await expect(stat(join(target, "skills", "skillkit-demo", "SKILL.md"))).resolves.toBeTruthy();
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("stages Vercel skills from a local git repo and syncs them to OpenClaw", async () => {
    const repo = await tempRoot("agentwheel-vercel-repo-");
    const target = await tempRoot("agentwheel-vercel-target-");
    await writeSkill(join(repo, "skills", "vercel-demo"), "vercel-demo");
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "agentwheel-test"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "add skill"]);
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const driver = new VercelSkillsSourceDriver();
    const bundle = await stageSource(driver, `vercel:git:${repo}#main`, {
      cacheRoot: join(target, ".agentwheel", "cache"),
    });
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    await applyInstallPlan(plan, bundle.sourceLock);

    expect(bundle.source.driver).toBe("vercel-skills");
    expect(bundle.source.resolvedCommit).toBe(commit);
    expect(bundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`)).toEqual(["skills:vercel-demo"]);
    expect(await readFile(join(target, "skills", "vercel-demo", "SKILL.md"), "utf8")).toContain("vercel-demo");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("resolves skills.sh skill names from package-level skills directories", async () => {
    const repo = await tempRoot("agentwheel-vercel-subpath-");
    await writeSkill(join(repo, "skills", "interview-me"), "interview-me");

    await expect(resolveVercelSkillSubpath(repo, "interview-me")).resolves.toBe(join(repo, "skills", "interview-me"));
  });

  it("stages installable MCP registry remotes into a generated OpenPack package", async () => {
    const cache = await tempRoot("agentwheel-mcp-registry-cache-");
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            server: {
              name: "io.example/demo-mcp",
              title: "Demo MCP",
              description: "Demo remote MCP server.",
              version: "1.2.3",
              remotes: [
                {
                  type: "streamable-http",
                  url: "https://example.com/mcp",
                },
              ],
            },
          };
        },
      } as Response;
    };

    const driver = new McpRegistrySourceDriver(fetchImpl as typeof fetch);
    const bundle = await stageSource(driver, "mcp-registry:io.example/demo-mcp", { cacheRoot: cache });

    expect(calls[0]).toContain("/servers/io.example%2Fdemo-mcp/versions/latest");
    expect(bundle.source.driver).toBe("mcp-registry");
    expect(bundle.source.packageName).toBe("mcp-registry/io.example/demo-mcp");
    expect(bundle.source.packageVersion).toBe("1.2.3");
    expect(bundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`)).toEqual(["mcp:demo-mcp.json"]);
    expect(await readFile(join(bundle.source.resolvedPath, "mcp", "demo-mcp.json"), "utf8")).toContain("https://example.com/mcp");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("rejects MCP registry entries that require secret remote headers", async () => {
    const cache = await tempRoot("agentwheel-mcp-registry-cache-");
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          server: {
            name: "io.example/secret-mcp",
            remotes: [
              {
                type: "streamable-http",
                url: "https://example.com/mcp",
                headers: [{ isRequired: true, isSecret: true }],
              },
            ],
          },
        };
      },
    }) as Response;

    const driver = new McpRegistrySourceDriver(fetchImpl as typeof fetch);
    await expect(stageSource(driver, "mcp-registry:io.example/secret-mcp", { cacheRoot: cache }))
      .rejects.toThrow(/discovery-only/);
  });

  it("stages ClawHub packages into OpenClaw semantic plugin installs", async () => {
    const cache = await tempRoot("agentwheel-clawhub-cache-");
    const target = await tempRoot("agentwheel-clawhub-target-");
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            package: {
              name: "@openclaw/whatsapp",
              displayName: "WhatsApp",
              runtimeId: "whatsapp",
              latestVersion: "2026.6.10",
              family: "code-plugin",
              summary: "OpenClaw WhatsApp provider plugin.",
              artifact: {
                format: "tgz",
                kind: "npm-pack",
                sha256: "abc123",
              },
              verification: {
                trustedOpenClawPlugin: true,
              },
            },
          };
        },
      } as Response;
    };

    const driver = new ClawHubSourceDriver(fetchImpl as typeof fetch);
    const bundle = await stageSource(driver, "clawhub:@openclaw/whatsapp", { cacheRoot: cache });
    const plan = await createInstallPlan(bundle, openClawAdapter, target);
    const plugin = plan.operations.find((operation) => operation.artifactType === "plugins");

    expect(calls[0]).toContain("/packages/%40openclaw%2Fwhatsapp");
    expect(bundle.source.driver).toBe("clawhub");
    expect(bundle.source.packageName).toBe("clawhub/@openclaw/whatsapp");
    expect(bundle.source.packageVersion).toBe("2026.6.10");
    expect(bundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}:${artifact.format}`)).toEqual([
      "plugins:whatsapp:openclaw-clawhub-plugin",
    ]);
    expect(await readFile(join(bundle.source.resolvedPath, "plugins", "whatsapp", "clawhub.json"), "utf8"))
      .toContain("clawhub:@openclaw/whatsapp");
    expect(plugin?.semanticCommand).toEqual(["openclaw", "plugins", "install", "--force", "clawhub:@openclaw/whatsapp"]);
    expect(plugin?.semanticPlugin?.uninstallCommands).toEqual([["openclaw", "plugins", "uninstall", "whatsapp", "--force"]]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("rejects ClawHub packages that are not OpenClaw plugin artifacts", async () => {
    const cache = await tempRoot("agentwheel-clawhub-cache-");
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          package: {
            name: "@openclaw/not-a-plugin",
            family: "skill",
          },
        };
      },
    }) as Response;

    const driver = new ClawHubSourceDriver(fetchImpl as typeof fetch);
    await expect(stageSource(driver, "clawhub:@openclaw/not-a-plugin", { cacheRoot: cache }))
      .rejects.toThrow(/not an OpenClaw plugin/);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
