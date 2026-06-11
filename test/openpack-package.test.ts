import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPackageManifestPath, readPackageManifest } from "../src/model/package.js";
import { migratePackageManifest } from "../src/model/package-migrate.js";
import { validatePackage } from "../src/model/package-validate.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-openpack-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("OpenPack package manifests", () => {
  it("discovers openpack.json before legacy manifests and warns once for legacy aliases", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "agentwheel.json"), {
      schemaVersion: 1,
      name: "legacy/pkg",
      version: "1.0.0",
      provides: [{ type: "rules", path: "rules" }],
    });
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 2,
      name: "open/pkg",
      version: "1.0.0",
      provides: [{ type: "rules", path: "rules" }],
    });

    expect(await findPackageManifestPath(root)).toBe(join(root, "openpack.json"));
    expect((await readPackageManifest(root))?.name).toBe("open/pkg");

    const legacyRoot = await tempRoot();
    await writeJson(join(legacyRoot, "agentwheel.json"), {
      schemaVersion: 1,
      name: "legacy/pkg",
      version: "1.0.0",
      provides: [{ type: "rules", path: "rules" }],
    });
    const warn = vi.fn();
    expect(await findPackageManifestPath(legacyRoot, { warn })).toBe(join(legacyRoot, "agentwheel.json"));
    expect(await findPackageManifestPath(legacyRoot, { warn })).toBe(join(legacyRoot, "agentwheel.json"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Deprecated package manifest agentwheel.json");
  });

  it("reads openpack jsonc manifests", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "openpack.jsonc"), [
      "{",
      "  // draft package",
      "  \"schemaVersion\": 2,",
      "  \"name\": \"jsonc/pkg\",",
      "  \"version\": \"1.0.0\",",
      "  \"provides\": [{ \"type\": \"fragments\", \"path\": \"fragments\" }],",
      "}",
      "",
    ].join("\n"), "utf8");

    expect((await readPackageManifest(root))?.name).toBe("jsonc/pkg");
  });

  it("parses schema v2 dependencies, items, compose, fragments, and runtimes", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 2,
      name: "v2/pkg",
      version: "1.0.0",
      runtimes: ["claude"],
      requires: {
        core: {
          source: "registry:core",
          ref: "main",
          version: "^1.0.0",
          select: ["rules/core.md"],
          mode: "pinned",
          optional: false,
          integrity: "sha256-demo",
          runtimes: ["claude"],
        },
      },
      provides: [
        { type: "fragments", path: "fragments" },
        {
          type: "skills",
          path: "skills",
          runtimes: ["claude", "codex"],
          items: {
            demo: {
              requires: ["rules/core.md"],
              compose: [{ include: "fragments/shared.md", markers: false }],
              runtimes: ["codex"],
            },
          },
        },
      ],
    });

    const manifest = await readPackageManifest(root);
    expect(manifest?.schemaVersion).toBe(2);
    expect(manifest?.provides.map((provide) => provide.type)).toEqual(["fragments", "skills"]);
  });

  it("rejects v1 manifests that masquerade as dependency or fragment packages", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "agentwheel.json"), {
      schemaVersion: 1,
      name: "bad/pkg",
      version: "1.0.0",
      requires: { core: { source: "registry:core" } },
      provides: [{ type: "fragments", path: "fragments" }],
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(readPackageManifest(root)).rejects.toThrow(/schemaVersion 2 is required/);
    } finally {
      warn.mockRestore();
    }
  });

  it("validates selectors and compose include declarations", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await mkdir(join(root, "fragments"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
    await writeFile(join(root, "fragments", "shared.md"), "Shared\n", "utf8");
    await writeJson(join(root, "openpack.json"), {
      schemaVersion: 2,
      name: "bad-selectors/pkg",
      version: "1.0.0",
      requires: { core: { source: "registry:core", select: ["not-a-selector"] } },
      provides: [
        { type: "fragments", path: "fragments" },
        {
          type: "skills",
          path: "skills",
          items: {
            demo: {
              requires: ["core:missing"],
              compose: [{ include: "../escape.md" }],
            },
          },
        },
      ],
    });

    const result = await validatePackage(root);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.message).join("\n")).toMatch(/invalid selector/);
    expect(result.findings.map((finding) => finding.message).join("\n")).toMatch(/include path|selector/);
  });

  it("migrates legacy manifests and is idempotent", async () => {
    const root = await tempRoot();
    await writeJson(join(root, "agentwheel.json"), {
      schemaVersion: 1,
      name: "migrate/pkg",
      version: "1.0.0",
      provides: [{ type: "rules", path: "rules" }],
    });

    const first = await migratePackageManifest(root);
    expect(first.changed).toBe(true);
    expect(await readPackageManifest(root)).toMatchObject({ schemaVersion: 2, name: "migrate/pkg" });

    const second = await migratePackageManifest(root);
    expect(second.changed).toBe(false);
    expect(second.message).toContain("already uses openpack.json");
  });

  it("migrates jsonc while preserving comments", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "agentwheel.jsonc"), [
      "{",
      "  // keep me",
      "  \"schemaVersion\": 1,",
      "  \"name\": \"jsonc-migrate/pkg\",",
      "  \"version\": \"1.0.0\",",
      "  \"provides\": [{ \"type\": \"rules\", \"path\": \"rules\" }],",
      "}",
      "",
    ].join("\n"), "utf8");

    const result = await migratePackageManifest(root);
    expect(result.changed).toBe(true);
    const migrated = await readFile(join(root, "openpack.jsonc"), "utf8");
    expect(migrated).toContain("// keep me");
    expect(migrated).toContain("\"schemaVersion\": 2");
  });
});
