import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { openClawAdapter } from "../src/adapters/openclaw.js";
import { applyInstallPlan, createInstallPlan, readInstallManifest } from "../src/install/index.js";
import { LocalSourceDriver } from "../src/source/local.js";
import { stageSource, type StagedBundle } from "../src/staging/staging.js";
import { localTransport } from "../src/transport/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-compose-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createPackage(options: {
  skill?: string;
  fragments?: Record<string, string>;
  itemCompose?: Array<{ include: string; markers?: boolean; optional?: boolean }>;
  itemRuntimes?: string[];
  provideRuntimes?: string[];
  name?: string;
} = {}): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "fragments"), { recursive: true });
  const skillBody = options.skill ?? "# Demo\n";
  await writeFile(join(root, "skills", "demo", "SKILL.md"), skillBody.startsWith("---") ? skillBody : `---\nname: demo\ndescription: Fixture skill for tests.\n---\n\n${skillBody}`, "utf8");
  for (const [name, content] of Object.entries(options.fragments ?? {})) {
    await writeFile(join(root, "fragments", name), content, "utf8");
  }
  await writeJson(join(root, "openpack.json"), {
    schemaVersion: 2,
    name: options.name ?? "acme/pkg",
    version: "1.0.0",
    provides: [
      { type: "fragments", path: "fragments" },
      {
        type: "skills",
        path: "skills",
        runtimes: options.provideRuntimes,
        items: {
          demo: {
            compose: options.itemCompose,
            runtimes: options.itemRuntimes,
          },
        },
      },
    ],
  });
  return root;
}

async function stage(source: string, options: Parameters<typeof stageSource>[2] = {}): Promise<StagedBundle> {
  return stageSource(new LocalSourceDriver(), source, options);
}

describe("OpenPack composition", () => {
  it("expands basic and nested fragment includes with provenance markers", async () => {
    const source = await createPackage({
      skill: "# Demo\n\n<!-- openpack:include fragments/a.md -->\n",
      fragments: {
        "a.md": "A\n<!-- openpack:include fragments/b.md -->\n",
        "b.md": "B\n",
      },
    });
    const bundle = await stage(source);
    const content = await readFile(join(bundle.root, "skills", "demo", "SKILL.md"), "utf8");

    expect(content).toContain("BEGIN openpack:include fragments/a.md sha256:");
    expect(content).toContain("BEGIN openpack:include fragments/b.md sha256:");
    expect(content).toContain("A");
    expect(content).toContain("B");
    expect(bundle.artifacts.find((artifact) => artifact.type === "skills")?.composedFrom?.map((entry) => entry.selector)).toEqual([
      "fragments/a.md",
      "fragments/b.md",
    ]);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("omits optional missing includes and fails required missing includes", async () => {
    const optional = await createPackage({
      skill: "# Demo\n\nBefore\n<!-- openpack:include? fragments/missing.md -->\nAfter\n",
    });
    const optionalBundle = await stage(optional);
    const optionalContent = await readFile(join(optionalBundle.root, "skills", "demo", "SKILL.md"), "utf8");
    expect(optionalContent).toContain("Before");
    expect(optionalContent).toContain("After");
    expect(optionalContent).not.toContain("missing.md");
    await rm(optionalBundle.root, { recursive: true, force: true });

    const required = await createPackage({
      skill: "# Demo\n\n<!-- openpack:include fragments/missing.md -->\n",
    });
    await expect(stage(required)).rejects.toThrow(/include not found: fragments\/missing.md/);
  });

  it("reports include cycles with the include chain", async () => {
    const source = await createPackage({
      skill: "# Demo\n\n<!-- openpack:include fragments/a.md -->\n",
      fragments: {
        "a.md": "<!-- openpack:include fragments/b.md -->\n",
        "b.md": "<!-- openpack:include fragments/a.md -->\n",
      },
    });

    await expect(stage(source)).rejects.toThrow(/skills\/demo\/SKILL.md -> fragments\/a.md -> fragments\/b.md -> fragments\/a.md/);
  });

  it("supports escaped literal include markers and rejects generated blocks in raw source", async () => {
    const escaped = await createPackage({
      skill: "# Demo\n\n<!-- openpack\\:include fragments/a.md -->\n",
      fragments: { "a.md": "A\n" },
    });
    const bundle = await stage(escaped);
    const content = await readFile(join(bundle.root, "skills", "demo", "SKILL.md"), "utf8");
    expect(content).toContain("<!-- openpack:include fragments/a.md -->");
    expect(content).not.toContain("BEGIN openpack:include");
    expect(bundle.artifacts.find((artifact) => artifact.type === "skills")?.composedFrom).toBeUndefined();
    await rm(bundle.root, { recursive: true, force: true });

    const generated = await createPackage({
      skill: "# Demo\n\n<!-- BEGIN openpack:include fragments/a.md sha256:0123456789abcdef -->\nA\n<!-- END openpack:include fragments/a.md -->\n",
      fragments: { "a.md": "A\n" },
    });
    await expect(stage(generated)).rejects.toThrow(/Generated OpenPack include block/);
  });

  it("is deterministic from raw input and supports manifest compose markers:false", async () => {
    const source = await createPackage({
      skill: "# Demo\n",
      fragments: { "a.md": "A\n" },
      itemCompose: [{ include: "fragments/a.md", markers: false }],
    });
    const first = await stage(source);
    const second = await stage(source);
    const firstContent = await readFile(join(first.root, "skills", "demo", "SKILL.md"), "utf8");
    const secondContent = await readFile(join(second.root, "skills", "demo", "SKILL.md"), "utf8");

    expect(firstContent).toBe(secondContent);
    expect(firstContent).toContain("# Demo\n\nA\n");
    expect(firstContent).not.toContain("BEGIN openpack:include");
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  });

  it("preserves repeated item-level compose entries", async () => {
    const source = await createPackage({
      skill: "# Demo\n",
      fragments: { "a.md": "Repeated item content\n" },
      itemCompose: [
        { include: "fragments/a.md" },
        { include: "fragments/a.md" },
      ],
    });
    const bundle = await stage(source);
    const content = await readFile(join(bundle.root, "skills", "demo", "SKILL.md"), "utf8");
    expect(content.match(/Repeated item content/g)).toHaveLength(2);
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("lists fragments but never plans them for Claude or Codex install targets", async () => {
    const source = await createPackage({
      skill: "# Demo\n\n<!-- openpack:include fragments/shared.md -->\n",
      fragments: { "shared.md": "Shared\n" },
    });
    const claudeBundle = await stage(source, { adapter: claudeAdapter });
    const codexBundle = await stage(source, { adapter: codexAdapter });
    expect(claudeBundle.artifacts.map((artifact) => `${artifact.type}:${artifact.name}`).sort()).toEqual([
      "fragments:shared.md",
      "skills:demo",
    ]);

    const claudePlan = await createInstallPlan(claudeBundle, claudeAdapter, await tempRoot(), undefined, localTransport, { installationType: "local" });
    const codexPlan = await createInstallPlan(codexBundle, codexAdapter, await tempRoot(), undefined, localTransport, { installationType: "local" });
    expect(claudePlan.operations.map((operation) => operation.artifactType)).toEqual(["skills"]);
    expect(codexPlan.operations.map((operation) => operation.artifactType)).toEqual(["skills"]);
    await rm(claudeBundle.root, { recursive: true, force: true });
    await rm(codexBundle.root, { recursive: true, force: true });
  });

  it("applies fragment overrides before expansion", async () => {
    const source = await createPackage({
      name: "acme/pkg",
      skill: "# Demo\n\n<!-- openpack:include fragments/shared.md -->\n",
      fragments: { "shared.md": "Upstream\n" },
    });
    const workspace = await tempRoot();
    await mkdir(join(workspace, ".agentwheel", "overrides", "acme", "pkg", "fragments"), { recursive: true });
    await writeFile(join(workspace, ".agentwheel", "overrides", "acme", "pkg", "fragments", "shared.md"), "Override\n", "utf8");

    const bundle = await stage(source, { workspaceRoot: workspace, adapter: claudeAdapter });
    const content = await readFile(join(bundle.root, "skills", "demo", "SKILL.md"), "utf8");
    expect(content).toContain("Override");
    expect(content).not.toContain("Upstream");
    await rm(bundle.root, { recursive: true, force: true });
  });

  it("records composedFrom in the install manifest and annotates included-fragment updates", async () => {
    const source = await createPackage({
      skill: "# Demo\n\n<!-- openpack:include fragments/shared.md -->\n",
      fragments: { "shared.md": "Version A\n" },
    });
    const target = await tempRoot();
    const first = await stage(source);
    await applyInstallPlan(await createInstallPlan(first, openClawAdapter, target, undefined, localTransport, { installationType: "local" }), first.sourceLock);
    await rm(first.root, { recursive: true, force: true });

    const manifest = await readInstallManifest(target, openClawAdapter.name);
    expect(manifest?.entries[0]?.composedFrom?.[0]?.selector).toBe("fragments/shared.md");

    await writeFile(join(source, "fragments", "shared.md"), "Version B\n", "utf8");
    const second = await stage(source);
    const plan = await createInstallPlan(second, openClawAdapter, target, manifest, localTransport, { installationType: "local" });
    const update = plan.operations.find((operation) => operation.artifactType === "skills");
    expect(update?.action).toBe("update");
    expect(update?.reason).toContain("included fragment changed: fragments/shared.md");
    await rm(second.root, { recursive: true, force: true });
  });

  it("skips artifacts whose runtimes exclude the current adapter", async () => {
    const source = await createPackage({
      skill: "# Demo\n",
      itemRuntimes: ["codex"],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const claudeBundle = await stage(source, { adapter: claudeAdapter });
      const codexBundle = await stage(source, { adapter: codexAdapter });
      expect(claudeBundle.artifacts.some((artifact) => artifact.type === "skills")).toBe(false);
      expect(codexBundle.artifacts.some((artifact) => artifact.type === "skills")).toBe(true);
      expect(warn).toHaveBeenCalledWith("skip (not targeted: runtimes=[codex]) skills/demo");
      await rm(claudeBundle.root, { recursive: true, force: true });
      await rm(codexBundle.root, { recursive: true, force: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("treats selected runtime-excluded artifacts as notices, not missing selectors", async () => {
    const source = await tempRoot();
    await mkdir(join(source, "skills", "a"), { recursive: true });
    await mkdir(join(source, "skills", "b"), { recursive: true });
    await writeFile(join(source, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: Fixture skill for tests.\n---\n\n# A\n", "utf8");
    await writeFile(join(source, "skills", "b", "SKILL.md"), "---\nname: b\ndescription: Fixture skill for tests.\n---\n\n# B\n", "utf8");
    await writeJson(join(source, "openpack.json"), {
      schemaVersion: 2,
      name: "acme/mixed-runtime",
      version: "1.0.0",
      provides: [
        {
          type: "skills",
          path: "skills",
          items: {
            a: { runtimes: ["codex"] },
            b: {},
          },
        },
      ],
    });

    const select = ["skills/a", "skills/b"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const claudeBundle = await stage(source, { adapter: claudeAdapter, select });
      const claudePlan = await createInstallPlan(claudeBundle, claudeAdapter, await tempRoot(), undefined, localTransport, { installationType: "local" });
      expect(claudePlan.operations.map((operation) => operation.artifactName)).toEqual(["b"]);
      expect(warn).toHaveBeenCalledWith("skip (selected but not targeted: runtimes=[codex]) skills/a");

      const codexBundle = await stage(source, { adapter: codexAdapter, select });
      const codexPlan = await createInstallPlan(codexBundle, codexAdapter, await tempRoot(), undefined, localTransport, { installationType: "local" });
      expect(codexPlan.operations.map((operation) => operation.artifactName)).toEqual(["a", "b"]);
      await rm(claudeBundle.root, { recursive: true, force: true });
      await rm(codexBundle.root, { recursive: true, force: true });
    } finally {
      warn.mockRestore();
    }
  });
});
