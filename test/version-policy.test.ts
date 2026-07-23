import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPackageVersions } from "../src/version/policy.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("root package version policy", () => {
  it("selects latest allowed and still reports latest overall from Git semver tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentwheel-version-policy-"));
    roots.push(root);
    const repo = join(root, "pack");
    await mkdir(repo);
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "user.email", "test@example.com"]);
    await runGit(repo, ["config", "user.name", "Agentwheel Test"]);
    await writeFile(join(repo, "openpack.json"), JSON.stringify({
      schemaVersion: 2,
      name: "test/versioned-pack",
      version: "1.2.0",
      provides: [{ type: "instructions", path: "AGENTS.md" }],
    }));
    await writeFile(join(repo, "AGENTS.md"), "# fixture\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-m", "fixture"]);
    await runGit(repo, ["tag", "v1.2.0"]);
    for (const version of ["1.4.0", "2.0.0"]) {
      await writeFile(join(repo, "openpack.json"), JSON.stringify({
        schemaVersion: 2,
        name: "test/versioned-pack",
        version,
        provides: [{ type: "instructions", path: "AGENTS.md" }],
      }));
      await runGit(repo, ["add", "openpack.json"]);
      await runGit(repo, ["commit", "-m", `release ${version}`]);
      await runGit(repo, ["tag", `v${version}`]);
    }
    await runGit(repo, ["tag", "v9.0.0"]);
    await runGit(repo, ["remote", "add", "origin", repo]);

    const report = await discoverPackageVersions({
      name: "versioned-pack",
      source: `git:${repo}`,
      driver: "git",
      adapter: "codex",
      mode: "tracking",
      version: "^1.2.0",
    }, root, { forceRefresh: true });

    expect(report.latestAllowed).toBe("1.4.0");
    expect(report.latestAllowedRef).toBe("v1.4.0");
    expect(report.latestOverall).toBe("2.0.0");
    expect(report.stale).toBe(false);

    const localReport = await discoverPackageVersions({
      name: "versioned-pack-local",
      source: repo,
      driver: "local",
      adapter: "codex",
      mode: "tracking",
      version: "^1.2.0",
    }, root, { forceRefresh: true });
    expect(localReport.latestAllowed).toBe("1.4.0");
    expect(localReport.latestOverall).toBe("2.0.0");
  });
});

async function runGit(root: string, args: string[]) {
  await execFileAsync("git", args, { cwd: root });
}
