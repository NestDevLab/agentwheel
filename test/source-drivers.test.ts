import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan } from "../src/install/index.js";
import { getSourceDriver } from "../src/source/index.js";
import { SkillKitSourceDriver } from "../src/source/skillkit.js";
import { VercelSkillsSourceDriver } from "../src/source/vercel-skills.js";
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
    await expect(stat(join(target, ".openclaw", "skills", "skillkit-demo", "SKILL.md"))).resolves.toBeTruthy();
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
    expect(await readFile(join(target, ".openclaw", "skills", "vercel-demo", "SKILL.md"), "utf8")).toContain("vercel-demo");
    await rm(bundle.root, { recursive: true, force: true });
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
