import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, createUninstallPlan, readInstallManifest, uninstall, type DesiredArtifact } from "../src/install/index.js";
import { managedInstructionBanner, managedInstructionPhysicalKey } from "../src/install/instructions-block.js";
import { targetMappingSchema, type AdapterConfig } from "../src/model/adapter.js";
import { manifestEntrySchema } from "../src/model/manifest.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath } from "../src/utils/fs.js";

const tempRoots: string[] = [];

const managedInstructionsAdapter: AdapterConfig = {
  name: "managed-instructions",
  targets: {
    instructions: {
      local: targetMappingSchema.parse({ enabled: true, dest: "AGENTS.md", mode: "managed-block" }),
    },
  },
};

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(prefix = "agentwheel-instructions-block-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("managed instruction blocks", () => {
  it("inserts and updates a managed block without owning user content", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const first = await instructionArtifact(sourceRoot, "Use the managed guidance.\n");

    const createPlan = await createCombinedInstallPlan([first], managedInstructionsAdapter, targetRoot);
    expect(createPlan.operations).toMatchObject([{ action: "create", mode: "managed-block" }]);
    await applyCombinedInstallPlan(createPlan);

    const dest = join(targetRoot, "AGENTS.md");
    let content = await readFile(dest, "utf8");
    expect(content).toContain("<!-- BEGIN openpack:include instructions/AGENTS.md sha256:");
    expect(content).toContain(managedInstructionBanner);
    expect(content).toContain("Use the managed guidance.");

    await writeFile(dest, `# User notes\n\n${content}`, "utf8");
    const updated = await instructionArtifact(sourceRoot, "Use the updated guidance.\n");
    const manifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const updatePlan = await createCombinedInstallPlan([updated], managedInstructionsAdapter, targetRoot, manifest);
    expect(updatePlan.operations).toMatchObject([{ action: "update", mode: "managed-block" }]);

    await applyCombinedInstallPlan(updatePlan);
    content = await readFile(dest, "utf8");
    expect(content).toContain("# User notes");
    expect(content).toContain("Use the updated guidance.");
    expect(content).not.toContain("Use the managed guidance.");

    const nextManifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const entry = nextManifest?.entries[0];
    expect(entry?.mode).toBe("managed-block");
    if (!entry) throw new Error("expected managed instruction manifest entry");
    expect(manifestEntrySchema.parse(entry).mode).toBe("managed-block");
  });

  it("keeps drifted managed blocks blocked unless force-drift is requested", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const first = await instructionArtifact(sourceRoot, "Use the managed guidance.\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([first], managedInstructionsAdapter, targetRoot));

    const dest = join(targetRoot, "AGENTS.md");
    await driftManagedBlock(dest, "Use the managed guidance.\n");
    const updated = await instructionArtifact(sourceRoot, "Use the updated guidance.\n");
    const manifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const driftPlan = await createCombinedInstallPlan([updated], managedInstructionsAdapter, targetRoot, manifest);

    expect(driftPlan.hasBlockingChanges).toBe(true);
    expect(driftPlan.operations).toMatchObject([{ action: "drift", mode: "managed-block" }]);
    await expect(applyCombinedInstallPlan(driftPlan)).rejects.toThrow(/Refusing to apply with blocking changes/);
  });

  it("force-drift replaces a drifted managed block", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const first = await instructionArtifact(sourceRoot, "Use the managed guidance.\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([first], managedInstructionsAdapter, targetRoot));

    const dest = join(targetRoot, "AGENTS.md");
    await driftManagedBlock(dest, "Use the managed guidance.\n");
    const updated = await instructionArtifact(sourceRoot, "Use the updated guidance.\n");
    const manifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const forcedPlan = await createCombinedInstallPlan([updated], managedInstructionsAdapter, targetRoot, manifest, localTransport, { forceDrift: true });

    expect(forcedPlan.hasBlockingChanges).toBe(false);
    expect(forcedPlan.operations).toMatchObject([{ action: "update", mode: "managed-block", overrideDrift: true }]);

    await applyCombinedInstallPlan(forcedPlan);
    const content = await readFile(dest, "utf8");
    expect(content).toContain("Use the updated guidance.");
    expect(content).not.toContain("manual edit");
    expect(content).not.toContain("Use the managed guidance.");
  });

  it("skips Claude instruction writes when CLAUDE.md imports AGENTS.md", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    await writeFile(join(targetRoot, "AGENTS.md"), "# Shared instructions\n", "utf8");
    await writeFile(join(targetRoot, "CLAUDE.md"), "@import AGENTS.md\n", "utf8");

    const artifact = await instructionArtifact(sourceRoot, "Claude should see AGENTS.\n");
    const plan = await createCombinedInstallPlan([artifact], claudeAdapter, targetRoot, undefined, localTransport, { installationType: "local" });

    expect(plan.operations).toEqual([]);
    expect(await readFile(join(targetRoot, "CLAUDE.md"), "utf8")).toBe("@import AGENTS.md\n");
  });

  it("detects a symlinked Claude bridge by realpath", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const agentsPath = join(targetRoot, "AGENTS.md");
    const claudePath = join(targetRoot, "CLAUDE.md");
    await writeFile(agentsPath, "# Shared instructions\n", "utf8");
    await symlink("AGENTS.md", claudePath);
    expect(await managedInstructionPhysicalKey(agentsPath, localTransport)).toBe(await managedInstructionPhysicalKey(claudePath, localTransport));

    const artifact = await instructionArtifact(sourceRoot, "Claude should see symlinked AGENTS.\n");
    const plan = await createCombinedInstallPlan([artifact], claudeAdapter, targetRoot, undefined, localTransport, { installationType: "local" });

    expect(plan.operations).toEqual([]);
  });

  it("warns when separate CLAUDE.md and AGENTS.md files may be double-read by Copilot", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    await writeFile(join(targetRoot, "AGENTS.md"), "# Shared instructions\n", "utf8");
    await writeFile(join(targetRoot, "CLAUDE.md"), "# Claude-only notes\n", "utf8");
    const warnings: string[] = [];

    const artifact = await instructionArtifact(sourceRoot, "Claude guidance.\n");
    const plan = await createCombinedInstallPlan([artifact], claudeAdapter, targetRoot, undefined, localTransport, {
      installationType: "local",
      warn: (message) => warnings.push(message),
    });

    expect(plan.operations[0]?.action).toBe("conflict");
    expect(warnings).toContain("CLAUDE.md and AGENTS.md are separate instruction files; if Copilot is active it may read the managed instructions twice.");
  });

  it("refuses to adopt an unmanaged instruction file without force", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    await writeFile(join(targetRoot, "AGENTS.md"), "# User-owned instructions\n", "utf8");

    const artifact = await instructionArtifact(sourceRoot, "Managed content.\n");
    const plan = await createCombinedInstallPlan([artifact], managedInstructionsAdapter, targetRoot);

    expect(plan.hasBlockingChanges).toBe(true);
    expect(plan.operations).toMatchObject([{ action: "conflict", reason: "destination exists but is not managed" }]);
  });

  it("deduplicates multiple instruction artifacts targeting the same physical file", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const first = await instructionArtifact(sourceRoot, "First instruction.\n");
    const second = await instructionArtifact(sourceRoot, "Second instruction.\n", "second.md");
    const warnings: string[] = [];

    const plan = await createCombinedInstallPlan([first, second], managedInstructionsAdapter, targetRoot, undefined, localTransport, {
      warn: (message) => warnings.push(message),
    });

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]?.logicalSelector).toBe("instructions/AGENTS.md");
    expect(warnings[0]).toMatch(/Multiple instruction targets resolve to AGENTS\.md/);
  });

  it("uninstalls only the managed block", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const artifact = await instructionArtifact(sourceRoot, "Managed guidance.\n");
    const installPlan = await createCombinedInstallPlan([artifact], managedInstructionsAdapter, targetRoot);
    await applyCombinedInstallPlan(installPlan);

    const dest = join(targetRoot, "AGENTS.md");
    await writeFile(dest, `# Keep me\n\n${await readFile(dest, "utf8")}# Also keep me\n`, "utf8");
    const manifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const uninstallPlan = await createUninstallPlan(manifest!);
    expect(uninstallPlan.operations).toMatchObject([{ action: "remove", mode: "managed-block" }]);

    await uninstall(uninstallPlan);
    const content = await readFile(dest, "utf8");
    expect(content).toContain("# Keep me");
    expect(content).toContain("# Also keep me");
    expect(content).not.toContain("openpack:include instructions/AGENTS.md");
    expect(content).not.toContain("Managed guidance.");
  });

  it("force uninstall removes a drifted managed block while preserving user content", async () => {
    const sourceRoot = await tempRoot();
    const targetRoot = await tempRoot();
    const artifact = await instructionArtifact(sourceRoot, "Managed guidance.\n");
    await applyCombinedInstallPlan(await createCombinedInstallPlan([artifact], managedInstructionsAdapter, targetRoot));

    const dest = join(targetRoot, "AGENTS.md");
    await writeFile(dest, `# Keep me\n\n${await readFile(dest, "utf8")}# Also keep me\n`, "utf8");
    await driftManagedBlock(dest, "Managed guidance.\n");
    const manifest = await readInstallManifest(targetRoot, managedInstructionsAdapter.name);
    const uninstallPlan = await createUninstallPlan(manifest!);
    expect(uninstallPlan.operations).toMatchObject([{ action: "keep", mode: "managed-block" }]);

    await uninstall(uninstallPlan, { force: true });
    const content = await readFile(dest, "utf8");
    expect(content).toContain("# Keep me");
    expect(content).toContain("# Also keep me");
    expect(content).not.toContain("openpack:include instructions/AGENTS.md");
    expect(content).not.toContain("Managed guidance.");
    expect(content).not.toContain("manual edit");
  });
});

async function instructionArtifact(root: string, content: string, name = "AGENTS.md"): Promise<DesiredArtifact> {
  const sourcePath = join(root, name);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content, "utf8");
  return {
    type: "instructions",
    name,
    sourcePath,
    stagedPath: sourcePath,
    relativePath: name,
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: {
      logicalSelector: `instructions/${name}`,
      dependencyRole: "root",
      owners: ["root"],
    },
  };
}

async function driftManagedBlock(path: string, needle: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const drifted = content.replace(needle, `${needle}manual edit\n`);
  if (drifted === content) throw new Error(`test fixture did not contain '${needle.trim()}'`);
  await writeFile(path, drifted, "utf8");
}
