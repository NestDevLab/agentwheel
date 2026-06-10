import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeDependencySource } from "../src/resolve/identity.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-resolve-identity-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("dependency source identity normalization", () => {
  it("normalizes GitHub and git URL forms to the same comparable identity", async () => {
    const root = await tempRoot();
    const options = { declaringPackageRoot: root, workspaceRoot: root };
    const github = await normalizeDependencySource("github:NestDevLab/Core#main", options);
    const git = await normalizeDependencySource("git:https://github.com/nestdevlab/core#main", options);

    expect(github.driver).toBe("git");
    expect(github.requestedRef).toBe("main");
    expect(github.normalizedSource).toBe("git:https://github.com/nestdevlab/core.git#main");
    expect(git.normalizedSource).toBe(github.normalizedSource);
  });

  it("resolves local dependency sources relative to the declaring package root", async () => {
    const root = await tempRoot();
    const declaring = join(root, "packages", "app");
    await mkdir(declaring, { recursive: true });
    await mkdir(join(root, "packages", "dep"), { recursive: true });

    const normalized = await normalizeDependencySource("../dep", {
      declaringPackageRoot: declaring,
      workspaceRoot: root,
    });

    expect(normalized.driver).toBe("local");
    expect(normalized.source).toBe(resolve(root, "packages", "dep"));
    expect(normalized.normalizedSource).toBe(`local:${resolve(root, "packages", "dep")}`);
  });

  it("treats registry-prefixed and bare dependency names as registry-only", async () => {
    const root = await tempRoot();
    const registryClient = {
      async resolve(name: string) {
        return name === "core"
          ? { name, source: "github:NestDevLab/core#v1", type: "package" as const, description: "", tags: [] }
          : undefined;
      },
    };

    const bare = await normalizeDependencySource("core", {
      declaringPackageRoot: root,
      workspaceRoot: root,
      registryClient,
    });
    const explicit = await normalizeDependencySource("registry:core", {
      declaringPackageRoot: root,
      workspaceRoot: root,
      registryClient,
    });

    expect(bare.registryEntry?.name).toBe("core");
    expect(bare.source).toBe("git:https://github.com/nestdevlab/core.git#v1");
    expect(bare.normalizedSource).toBe("registry:core:git:https://github.com/nestdevlab/core.git#v1");
    expect(explicit.normalizedSource).toBe(bare.normalizedSource);
  });

  it("does not fall back to a matching local directory for bare dependency names", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "local-name"), { recursive: true });

    await expect(normalizeDependencySource("local-name", {
      declaringPackageRoot: root,
      workspaceRoot: root,
      registryClient: { async resolve() { return undefined; } },
    })).rejects.toThrow(/Bare dependency names are registry-only inside package manifests/);
  });

  it("keeps provider sources on canonical provider keys", async () => {
    const root = await tempRoot();
    const skillkit = await normalizeDependencySource("skillkit:github:acme/skills", {
      declaringPackageRoot: root,
      workspaceRoot: root,
    });
    const vercel = await normalizeDependencySource("vercel:skills.sh/acme/repo/demo#main", {
      declaringPackageRoot: root,
      workspaceRoot: root,
    });

    expect(skillkit).toMatchObject({
      driver: "skillkit",
      source: "skillkit:github:acme/skills",
      normalizedSource: "skillkit:github:acme/skills",
    });
    expect(vercel).toMatchObject({
      driver: "vercel-skills",
      source: "vercel:skills.sh/acme/repo/demo#main",
      normalizedSource: "vercel:skills.sh/acme/repo/demo#main",
    });
  });
});
