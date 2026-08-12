import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { getSourceDriver } from "../src/source/index.js";
import { gitAuthArguments, matchingGitAuthProfile } from "../src/source/auth.js";
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

describe("local Git auth profiles", () => {
  it("matches a repository without putting credentials in the source manifest", async () => {
    const config = await tempRoot("agentwheel-auth-config-");
    const configPath = join(config, "auth.json");
    await writeFile(configPath, JSON.stringify({
      profiles: {
        "github-yehonal": {
          provider: "gh",
          account: "Yehonal",
          repositories: ["github.com/NestDevLab/*"],
        },
      },
    }));

    const previousConfig = process.env.AGENTWHEEL_AUTH_CONFIG;
    process.env.AGENTWHEEL_AUTH_CONFIG = configPath;
    try {
      await expect(matchingGitAuthProfile("https://github.com/NestDevLab/agentwheel.git")).resolves.toMatchObject({
        provider: "gh",
        account: "Yehonal",
      });
      await expect(matchingGitAuthProfile("https://github.com/other-org/agentwheel.git")).resolves.toBeUndefined();
    } finally {
      if (previousConfig === undefined) delete process.env.AGENTWHEEL_AUTH_CONFIG;
      else process.env.AGENTWHEEL_AUTH_CONFIG = previousConfig;
    }
  });

  it("builds a scoped credential helper without exposing the token in Git arguments", async () => {
    const config = await tempRoot("agentwheel-auth-config-");
    const configPath = join(config, "auth.json");
    await writeFile(configPath, JSON.stringify({
      profiles: {
        "github-yehonal": {
          provider: "gh",
          account: "Yehonal",
          repositories: ["github.com/NestDevLab/*"],
        },
      },
    }));

    const previousConfig = process.env.AGENTWHEEL_AUTH_CONFIG;
    process.env.AGENTWHEEL_AUTH_CONFIG = configPath;
    try {
      const args = await gitAuthArguments("https://github.com/NestDevLab/agentwheel.git");
      expect(args).toContain("credential.helper=");
      expect(args.join(" ")).toContain("gh auth token --user 'Yehonal'");
      expect(args.join(" ")).not.toContain("gho_");
    } finally {
      if (previousConfig === undefined) delete process.env.AGENTWHEEL_AUTH_CONFIG;
      else process.env.AGENTWHEEL_AUTH_CONFIG = previousConfig;
    }
  });
});

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

  it("refreshes named SkillKit branches and keeps refs isolated by resolved commit", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const cloneCalls: Array<{ targetDir: string; branch?: string }> = [];
    const fakeCore = skillKitCoreFor(
      (targetDir, branch, revision) => writeSkill(join(targetDir, "demo"), `demo-${branch ?? "default"}-v${revision}`),
      cloneCalls,
    );
    const driver = new SkillKitSourceDriver(fakeCore);
    const source = "skillkit:github:example/demo";

    const first = await driver.fetch(await driver.resolve(source, { cacheRoot, ref: "release-1" }));
    const second = await driver.fetch(await driver.resolve(source, { cacheRoot, ref: "release-2" }));
    const repeatedFirst = await driver.fetch(await driver.resolve(source, { cacheRoot, ref: "release-1" }));

    expect(cloneCalls.map((call) => call.branch)).toEqual(["release-1", "release-2", "release-1"]);
    expect(first.resolvedPath).not.toBe(second.resolvedPath);
    expect(repeatedFirst.resolvedPath).not.toBe(first.resolvedPath);
    expect(first.resolvedCommit).not.toBe(repeatedFirst.resolvedCommit);
    await expect(readFile(join(first.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-release-1-v1");
    await expect(readFile(join(second.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-release-2-v2");
    await expect(readFile(join(repeatedFirst.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-release-1-v3");
  });

  it("refreshes the default tracking ref and publishes immutable commit snapshots", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const cloneCalls: Array<{ targetDir: string; branch?: string }> = [];
    const fakeCore = skillKitCoreFor(
      (targetDir, branch, revision) => writeSkill(join(targetDir, "demo"), `demo-${branch ?? "default"}-v${revision}`),
      cloneCalls,
    );
    const driver = new SkillKitSourceDriver(fakeCore);
    const source = "skillkit:github:example/demo";

    const first = await driver.fetch(await driver.resolve(source, { cacheRoot }));
    const second = await driver.fetch(await driver.resolve(source, { cacheRoot, mode: "tracking" }));

    expect(cloneCalls.map((call) => call.branch)).toEqual([undefined, undefined]);
    expect(first.resolvedPath).not.toBe(second.resolvedPath);
    expect(first.resolvedCommit).not.toBe(second.resolvedCommit);
    expect(first.resolvedPath).toContain(first.resolvedCommit);
    expect(second.resolvedPath).toContain(second.resolvedCommit);
    await expect(readFile(join(first.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-default-v1");
    await expect(readFile(join(second.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-default-v2");
  });

  it("reopens a skills.sh Git snapshot for frozen and offline use without provider calls", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const cloneCalls: Array<{ targetDir: string; branch?: string }> = [];
    const source = "skillkit:skills.sh/example/demo";
    const firstDriver = new SkillKitSourceDriver(skillKitCoreFor(
      (targetDir) => writeSkill(join(targetDir, "demo"), "skills-sh-demo"),
      cloneCalls,
    ));
    const first = await firstDriver.fetch(await firstDriver.resolve(source, { cacheRoot }));
    let providerCalls = 0;
    const coldDriver = new SkillKitSourceDriver({
      detectProvider() {
        providerCalls++;
        throw new Error("provider must not be called for a locked immutable snapshot");
      },
    });

    for (const mode of ["frozen", "offline"]) {
      const cached = await coldDriver.fetch(await coldDriver.resolve(source, {
        cacheRoot,
        ref: first.resolvedCommit,
        cacheIdentity: first.cacheIdentity,
        frozenLock: true,
      }));

      expect(cached.resolvedPath, mode).toBe(first.resolvedPath);
      expect(cached.resolvedCommit, mode).toBe(first.resolvedCommit);
      expect(cached.cacheIdentity, mode).toBe(first.cacheIdentity);
    }
    expect(cloneCalls).toHaveLength(1);
    expect(providerCalls).toBe(0);
  });

  it("keeps different SkillKit sources isolated when their readable cache slugs collide", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const cloneCalls: Array<{ targetDir: string; branch?: string }> = [];
    const fakeCore = skillKitCoreFor((targetDir, branch) => writeSkill(join(targetDir, "demo"), `demo-${branch ?? "default"}`), cloneCalls);
    const driver = new SkillKitSourceDriver(fakeCore);

    const first = await driver.fetch(await driver.resolve("skillkit:github:example/demo.one", { cacheRoot, ref: "release-1" }));
    const second = await driver.fetch(await driver.resolve("skillkit:github:example/demo-one", { cacheRoot, ref: "release-1" }));

    expect(first.resolvedPath).not.toBe(second.resolvedPath);
    expect(cloneCalls).toHaveLength(2);
  });

  it("publishes a provider subdirectory without copying it into its own candidate path", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const fakeCore = {
      detectProvider() {
        return {
          async clone(_source: string, targetDir: string) {
            const subdirectory = join(targetDir, "nested");
            await writeSkill(join(subdirectory, "demo"), "nested-demo");
            return { success: true, path: subdirectory };
          },
        };
      },
    };
    const driver = new SkillKitSourceDriver(fakeCore);

    const fetched = await driver.fetch(await driver.resolve("skillkit:github:example/nested", { cacheRoot, ref: "release-1" }));

    await expect(readFile(join(fetched.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("nested-demo");
  });

  it("reopens a WellKnown non-Git snapshot for frozen and offline use without provider calls", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const source = "skillkit:https://skills.example.test/.well-known/skills";
    let firstProviderCalls = 0;
    const firstDriver = new SkillKitSourceDriver({
      detectProvider() {
        firstProviderCalls++;
        return {
          async clone(_source: string, targetDir: string) {
            const subdirectory = join(targetDir, "nested");
            await writeSkill(join(subdirectory, "demo"), "well-known-demo");
            return { success: true, path: subdirectory };
          },
        };
      },
    });
    const first = await firstDriver.fetch(await firstDriver.resolve(source, { cacheRoot }));
    let coldProviderCalls = 0;
    const coldDriver = new SkillKitSourceDriver({
      detectProvider() {
        coldProviderCalls++;
        throw new Error("provider must not be called for a locked immutable snapshot");
      },
    });

    expect(first.resolvedCommit).toBeUndefined();
    expect(first.cacheIdentity).toMatch(/^content-[0-9a-f]{64}$/);
    for (const mode of ["frozen", "offline"]) {
      const cached = await coldDriver.fetch(await coldDriver.resolve(source, {
        cacheRoot,
        cacheIdentity: first.cacheIdentity,
        frozenLock: true,
      }));

      expect(cached.resolvedPath, mode).toBe(first.resolvedPath);
      expect(cached.resolvedCommit, mode).toBeUndefined();
      expect(cached.cacheIdentity, mode).toBe(first.cacheIdentity);
      await expect(readFile(join(cached.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("well-known-demo");
    }
    expect(firstProviderCalls).toBe(1);
    expect(coldProviderCalls).toBe(0);
  });

  it("checks out a requested SkillKit commit instead of treating it as a branch", async () => {
    const repository = await tempRoot("agentwheel-skillkit-repo-");
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.name", "Test"]);
    await git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeSkill(join(repository, "demo"), "demo-first");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "first"]);
    const requestedCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
    await writeSkill(join(repository, "demo"), "demo-second");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "second"]);

    const cloneCalls: Array<{ branch?: string }> = [];
    const fakeCore = {
      detectProvider() {
        return {
          async clone(_source: string, _targetDir: string, options?: { branch?: string }) {
            cloneCalls.push({ branch: options?.branch });
            const checkout = await tempRoot("agentwheel-skillkit-checkout-");
            await git(repository, ["clone", repository, checkout]);
            return { success: true, path: checkout, tempRoot: checkout };
          },
        };
      },
    };
    const driver = new SkillKitSourceDriver(fakeCore);

    const fetched = await driver.fetch(await driver.resolve("skillkit:github:example/demo", { cacheRoot, ref: requestedCommit }));
    const cached = await driver.fetch(await driver.resolve("skillkit:github:example/demo", { cacheRoot, ref: requestedCommit }));
    const frozen = await driver.fetch(await driver.resolve("skillkit:github:example/demo", {
      cacheRoot,
      ref: requestedCommit,
      frozenLock: true,
    }));

    expect(cloneCalls).toEqual([{ branch: undefined }]);
    expect(cached.resolvedPath).toBe(fetched.resolvedPath);
    expect(cached.resolvedCommit).toBe(requestedCommit);
    expect(frozen.resolvedPath).toBe(fetched.resolvedPath);
    await expect(readFile(join(fetched.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-first");
  });

  it("serializes concurrent SkillKit materialization without overwriting other refs", async () => {
    const cacheRoot = await tempRoot("agentwheel-skillkit-cache-");
    const cloneCalls: Array<{ targetDir: string; branch?: string }> = [];
    const fakeCore = skillKitCoreFor(async (targetDir, branch) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeSkill(join(targetDir, "demo"), `demo-${branch ?? "default"}`);
    }, cloneCalls);
    const driver = new SkillKitSourceDriver(fakeCore);
    const source = "skillkit:github:example/demo";

    const [first, duplicate, other] = await Promise.all([
      driver.resolve(source, { cacheRoot, ref: "release-1" }).then((resolved) => driver.fetch(resolved)),
      driver.resolve(source, { cacheRoot, ref: "release-1" }).then((resolved) => driver.fetch(resolved)),
      driver.resolve(source, { cacheRoot, ref: "release-2" }).then((resolved) => driver.fetch(resolved)),
    ]);

    expect(cloneCalls.map((call) => call.branch).sort()).toEqual(["release-1", "release-2"]);
    expect(duplicate.resolvedPath).toBe(first.resolvedPath);
    expect(other.resolvedPath).not.toBe(first.resolvedPath);
    await expect(readFile(join(first.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-release-1");
    await expect(readFile(join(other.resolvedPath, "demo", "SKILL.md"), "utf8")).resolves.toContain("demo-release-2");
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

function skillKitCoreFor(
  materialize: (targetDir: string, branch: string | undefined, revision: number) => Promise<void>,
  calls: Array<{ targetDir: string; branch?: string }>,
) {
  return {
    detectProvider() {
      return {
        async clone(_source: string, targetDir: string, options?: { branch?: string }) {
          calls.push({ targetDir, branch: options?.branch });
          const revision = calls.length;
          await materialize(targetDir, options?.branch, revision);
          return { success: true, path: targetDir, resolvedCommit: revision.toString(16).padStart(40, "0") };
        },
      };
    },
  };
}
