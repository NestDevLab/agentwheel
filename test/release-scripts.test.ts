import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release scripts", () => {
  it("passes release arguments through pnpm without forwarding an extra separator", async () => {
    for (const workflow of ["auto-release-tag.yml", "release.yml"]) {
      const content = await readFile(join(repoRoot, ".github/workflows", workflow), "utf8");
      expect(content).not.toContain("pnpm release:check -- --");
    }
    expect(await readFile(join(repoRoot, ".github/workflows/auto-release-tag.yml"), "utf8"))
      .toContain('pnpm release:check --before "$BEFORE_SHA"');
    expect(await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8"))
      .toContain('pnpm release:check --tag "$RELEASE_TAG"');
  });

  it("checks the repository release metadata", async () => {
    const { stdout } = await execFileAsync("node", ["scripts/release-check.mjs"], { cwd: repoRoot });
    const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string };
    expect(stdout).toContain(`Release metadata is aligned for v${version}.`);
  });

  it("prepares every product-coupled copy from non-empty Unreleased notes without changing history", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\n- Named fleets.\n\n## 0.17.0\n\n- Existing release.\n",
    );
    const historical = await readFile(join(root, "CHANGELOG.md"), "utf8");

    await run(root, "release-prepare.mjs", ["0.18.0"]);

    expect(await jsonVersion(root, "package.json")).toBe("0.18.0");
    expect(await jsonVersion(root, "openpack.json")).toBe("0.18.0");
    expect(await skillVersion(root, "agentwheel")).toBe("0.18.0");
    expect(await skillVersion(root, "agentwheel-discovery")).toBe("0.18.0");
    expect(await skillVersion(root, "new-published-skill")).toBe("0.18.0");
    expect(await skillVersion(root, "agentwheel-artifact-evolution")).toBe("0.1.0");
    expect(await skillVersions(root, "agentwheel-smoke")).toEqual([]);

    const index = await readFile(join(root, "docs/index.html"), "utf8");
    const catalogue = await readFile(join(root, "docs/catalogue.html"), "utf8");
    expect(index).toContain("v0.18.0 - installation types &amp; harness matrix");
    expect(index).toContain("agentwheel is early / v0.18.0.");
    expect(catalogue).toContain("agentwheel is early / v0.18.0.");

    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog.startsWith("# Changelog\n\n## 0.18.0\n\n- Named fleets.\n\n")).toBe(true);
    expect(changelog.endsWith(historical.slice(historical.indexOf("## 0.17.0")))).toBe(true);
  });

  it("renames a non-empty Unreleased section instead of duplicating it", async () => {
    const root = await fixture();
    const changelogPath = join(root, "CHANGELOG.md");
    await writeFile(changelogPath, "# Changelog\n\n## Unreleased\n\n- Named fleets.\n\n## 0.17.0\n\n- Earlier.\n");

    await run(root, "release-prepare.mjs", ["0.18.0"]);

    const changelog = await readFile(changelogPath, "utf8");
    expect(changelog).toBe("# Changelog\n\n## 0.18.0\n\n- Named fleets.\n\n## 0.17.0\n\n- Earlier.\n");
  });

  it("rejects unstable versions and empty Unreleased notes", async () => {
    const root = await fixture();
    await expectFailure(root, "release-prepare.mjs", ["0.18.0-rc.1"], "stable x.y.z version");
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## 0.17.0\n\n- Earlier.\n");
    await expectFailure(root, "release-prepare.mjs", ["0.18.0"], "Unreleased section must not be empty");
    expect(await jsonVersion(root, "package.json")).toBe("0.17.0");
  });

  it("refuses to invent release-note placeholders", async () => {
    const root = await fixture();
    await expectFailure(root, "release-prepare.mjs", ["0.18.0"], "must start with a non-empty Unreleased");
    expect(await jsonVersion(root, "package.json")).toBe("0.17.0");
  });

  it.each([
    ["OpenPack", async (root: string) => {
      const openpack = JSON.parse(await readFile(join(root, "openpack.json"), "utf8"));
      openpack.version = "0.17.9";
      await writeFile(join(root, "openpack.json"), `${JSON.stringify(openpack)}\n`);
    }, "openpack.json version is 0.17.9"],
    ["management skill", async (root: string) => {
      const path = join(root, "skills/agentwheel/SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")).replace("0.18.0", "0.17.9"));
    }, "skills/agentwheel/SKILL.md version is 0.17.9"],
    ["discovery skill", async (root: string) => {
      const path = join(root, "skills/agentwheel-discovery/SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")).replace("0.18.0", "0.17.9"));
    }, "skills/agentwheel-discovery/SKILL.md version is 0.17.9"],
    ["independent skill exception", async (root: string) => {
      const path = join(root, "skills/agentwheel-artifact-evolution/SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")).replace("0.1.0", "0.2.0"));
    }, "release exception"],
    ["unversioned skill exception", async (root: string) => {
      const path = join(root, "skills/agentwheel-smoke/SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")).replace("name: agentwheel-smoke", "name: agentwheel-smoke\nmetadata:\n  version: \"0.18.0\""));
    }, "release exception"],
    ["site marker version", async (root: string) => {
      const path = join(root, "docs/index.html");
      await writeFile(path, (await readFile(path, "utf8")).replace("v0.18.0 -", "v0.17.9 -"));
    }, "docs/index.html hero version is 0.17.9"],
    ["duplicate site marker", async (root: string) => {
      const path = join(root, "docs/catalogue.html");
      const content = await readFile(path, "utf8");
      await writeFile(path, `${content}${content}`);
    }, "must contain exactly one footer version marker; found 2"],
    ["changelog order", async (root: string) => {
      await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.17.0\n\n- Old.\n\n## 0.18.0\n\n- New.\n");
    }, "first CHANGELOG.md heading is 0.17.0"],
    ["unexpected current-version copy", async (root: string) => {
      await writeFile(join(root, "README.md"), "Do not hard-code v0.18.0 here.\n");
    }, "README.md contains 1 current product-version copies, expected 0"],
  ])("detects deliberate %s drift", async (_name, mutate, message) => {
    const root = await fixture("0.18.0");
    await mutate(root);
    await expectFailure(root, "release-check.mjs", [], message);
  });

  it("validates a release bump and appends GitHub outputs", async () => {
    const root = await fixture();
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "release@example.com"]);
    await git(root, ["config", "user.name", "Release Test"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "0.17.0"]);
    const before = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\n- Named fleets.\n\n## 0.17.0\n\n- Existing release.\n",
    );
    await run(root, "release-prepare.mjs", ["0.18.0"]);
    const output = join(root, "github-output.txt");
    await writeFile(output, "existing=value\n");

    const result = await run(root, "release-check.mjs", ["--before", before, "--tag", "v0.18.0"], {
      GITHUB_OUTPUT: output,
    });

    expect(result.stdout).toContain("Validated release bump 0.17.0 -> 0.18.0.");
    expect(await readFile(output, "utf8")).toBe(
      "existing=value\nrelease=true\nversion=0.18.0\ntag=v0.18.0\n",
    );
  });

  it("reports an unchanged version and rejects a mismatched tag", async () => {
    const root = await fixture();
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "release@example.com"]);
    await git(root, ["config", "user.name", "Release Test"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "0.17.0"]);
    const before = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const output = join(root, "github-output.txt");

    const result = await run(root, "release-check.mjs", ["--before", before], { GITHUB_OUTPUT: output });
    expect(result.stdout).toContain("Package version is unchanged at 0.17.0");
    expect(await readFile(output, "utf8")).toBe("release=false\nversion=0.17.0\ntag=v0.17.0\n");
    await expectFailure(root, "release-check.mjs", ["--tag", "v0.18.0"], "release tag is v0.18.0");
  });
});

async function fixture(version = "0.17.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-release-"));
  roots.push(root);
  for (const directory of [
    "scripts",
    "docs",
    "skills/agentwheel",
    "skills/agentwheel-artifact-evolution",
    "skills/agentwheel-discovery",
    "skills/agentwheel-smoke",
    "skills/new-published-skill",
  ]) await mkdir(join(root, directory), { recursive: true });
  for (const script of ["release-shared.mjs", "release-prepare.mjs", "release-check.mjs"]) {
    await copyFile(join(repoRoot, "scripts", script), join(root, "scripts", script));
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name: "fixture",
    version,
    provides: [{ type: "skills", path: "skills" }],
  }, null, 2)}\n`);
  for (const name of ["agentwheel", "agentwheel-discovery", "new-published-skill"]) {
    await writeFile(join(root, `skills/${name}/SKILL.md`), skill(name, version));
  }
  await writeFile(
    join(root, "skills/agentwheel-artifact-evolution/SKILL.md"),
    skill("agentwheel-artifact-evolution", "0.1.0"),
  );
  await writeFile(join(root, "skills/agentwheel-smoke/SKILL.md"), skill("agentwheel-smoke"));
  await writeFile(join(root, "docs/index.html"), [
    `<span class="eyebrow"><span class="dot"></span> v${version} - installation types &amp; harness matrix</span>`,
    `<span>agentwheel is early / v${version}.</span>`,
    "",
  ].join("\n"));
  await writeFile(join(root, "docs/catalogue.html"), `<span>agentwheel is early / v${version}.</span>\n`);
  await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n\n- Existing release.\n`);
  await writeFile(join(root, "README.md"), "# Fixture\n");
  return root;
}

function skill(name: string, version?: string): string {
  const metadata = version === undefined ? "" : `metadata:\n  version: "${version}"\n`;
  return `---\nname: ${name}\n${metadata}---\n\n# ${name}\n`;
}

async function jsonVersion(root: string, file: string): Promise<string> {
  return JSON.parse(await readFile(join(root, file), "utf8")).version;
}

async function skillVersion(root: string, name: string): Promise<string> {
  return (await readFile(join(root, `skills/${name}/SKILL.md`), "utf8"))
    .match(/^\s*version:\s*"([^"]+)"/m)![1]!;
}

async function skillVersions(root: string, name: string): Promise<string[]> {
  return [...(await readFile(join(root, `skills/${name}/SKILL.md`), "utf8"))
    .matchAll(/^\s*version:\s*"([^"]+)"/gm)].map((match) => match[1]!);
}

async function run(
  root: string,
  script: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return execFileAsync("node", [`scripts/${script}`, ...args], { cwd: root, env: { ...process.env, ...env } });
}

async function expectFailure(root: string, script: string, args: string[], message: string) {
  await expect(run(root, script, args)).rejects.toSatisfy((error: { stderr?: string; message?: string }) =>
    `${error.stderr ?? ""}\n${error.message ?? ""}`.includes(message),
  );
}

async function git(root: string, args: string[]) {
  return execFileAsync("git", args, { cwd: root });
}
