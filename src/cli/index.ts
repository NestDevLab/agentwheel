import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { resolveAdapter } from "../adapters/resolve.js";
import { applyInstallPlan, createUninstallPlan, normalizeTargetRoot, readInstallManifest, readSourceLock, uninstall } from "../install/index.js";
import { formatPlan } from "./format.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource } from "../staging/staging.js";
import { readMergedWorkspaceConfig, readWorkspaceConfig, upsertPackage, writeWorkspaceConfig } from "../model/workspace.js";
import type { WorkspacePackage } from "../model/workspace.js";
import { ejectArtifact, remember } from "../lifecycle/customization.js";
import { syncProfile } from "../lifecycle/profile.js";
import { createSourcePlan } from "../lifecycle/source-plan.js";
import { shouldUpdatePackage } from "../lifecycle/update.js";
import { RegistryClient, resolvePackageSource } from "../registry/client.js";
import { resolveAllRuntimeTargets, resolveRuntimeTarget, type RuntimeTarget } from "../runtime/target.js";
import type { InstallPlan } from "../install/plan.js";
import { filterArtifactsBySelection, normalizeArtifactSelectors, splitSelectorList } from "../model/selection.js";
import { maybeCheckForUpdate } from "./update-check.js";

const program = new Command();

program
  .name("agentwheel")
  .description("Multi-runtime agent artifact orchestrator")
  .version("0.7.0")
  .option("--no-update-check", "disable npm version update check", false);

program
  .command("init")
  .argument("[kind]", "workspace or package", "workspace")
  .option("--target-root <path>", "workspace root", process.cwd())
  .action(async (kind, options) => {
    const root = normalizeTargetRoot(options.targetRoot);
    if (kind === "package") {
      await initPackage(root);
      console.log("Initialized agentwheel package.");
      return;
    }
    if (kind !== "workspace") {
      throw new Error(`Unknown init kind: ${kind}`);
    }
    await writeWorkspaceConfig(root, await readWorkspaceConfig(root));
    console.log("Initialized .agentwheel/config.json.");
  });

program
  .command("add")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver (local, git, skillkit, or vercel-skills)")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--target-root <path>", "workspace root", process.cwd())
  .option("--mode <mode>", "pinned or tracking", "pinned")
  .option("--name <name>", "package alias")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .action(async (source, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const selectedArtifacts = selectedArtifactsFromOptions(options);
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const resolvedSource = resolvedInput.source;
    const driverName = options.driver ?? inferSourceDriverName(resolvedSource);
    const driver = getSourceDriver(driverName);
    const adapter = await resolveAdapter({
      adapter: options.adapter,
      adapterConfig: options.adapterConfig,
      adapterModule: options.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
      baseDir: targetRoot,
      warn: (message) => console.warn(message),
    });
    const bundle = await stageSource(driver, resolvedSource, {
      workspaceRoot: targetRoot,
      adapter,
      cacheRoot: join(targetRoot, ".agentwheel", "cache"),
      mode: options.mode,
      select: selectedArtifacts,
    });
    const name = options.name ?? resolvedInput.registryEntry?.name ?? bundle.source.packageName ?? source;
    const entry: WorkspacePackage = {
      name,
      source: resolvedSource,
      driver: driverName,
      adapter: adapter.name,
      adapterConfig: options.adapterConfig,
      adapterModule: options.adapterModule,
      adapterCodeHash: adapter.programmatic?.hash,
      mode: options.mode,
      requestedRef: bundle.source.requestedRef,
      select: selectedArtifacts,
    };
    await writeWorkspaceConfig(targetRoot, upsertPackage(await readWorkspaceConfig(targetRoot), entry));
    await rm(bundle.root, { recursive: true, force: true });
    console.log(`Added ${name}.`);
  });

program
  .command("list")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("--target-root <path>", "workspace root", process.cwd())
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .action(async (source, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const selectedArtifacts = selectedArtifactsFromOptions(options);
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedInput.source));
    const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(resolvedInput.source, { cacheRoot: join(targetRoot, ".agentwheel", "cache") }))));
    const artifacts = filterArtifactsBySelection(await driver.list(resolved), selectedArtifacts);
    for (const artifact of artifacts) {
      console.log(`${artifact.type}\t${artifact.name}\t${artifact.relativePath}`);
    }
  });

program
  .command("scan")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("--target-root <path>", "workspace root", process.cwd())
  .action(async (source, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedInput.source));
    const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(resolvedInput.source, { cacheRoot: join(targetRoot, ".agentwheel", "cache") }))));
    const result = await driver.scan(resolved);
    if (result.findings.length === 0) {
      console.log("Scan ok: no findings");
    } else {
      for (const finding of result.findings) {
        console.log(`${finding.level.toUpperCase()}: ${finding.message}${finding.path ? ` (${finding.path})` : ""}`);
      }
    }
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("plan")
  .argument("<source>", "source directory")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--dry-run", "accepted for symmetry; plan never writes", false)
  .action(async (source, options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      const { plan, bundle } = await buildPlan(source, target, options);
      console.log(formatPlan(plan));
      await rm(bundle.root, { recursive: true, force: true });
      if (plan.hasBlockingChanges) process.exitCode = 1;
    }
  });

program
  .command("sync")
  .argument("[source]", "source directory")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plan without writing", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .action(async (source, options) => {
    if (options.profile) {
      const target = await resolveRuntimeTarget({ targetRoot: options.targetRoot, adapter: options.adapter, agent: options.agent });
      const results = await syncProfile({
        workspaceRoot: target.workspaceRoot,
        profile: options.profile,
        source,
        driver: options.driver,
        mode: options.mode,
        select: selectedArtifactsFromOptions(options),
        dryRun: options.dryRun,
        executePlugins: options.executePlugins,
        allowAdapterCode: options.allowAdapterCode,
        warn: (message) => console.warn(message),
      });
      for (const result of results) {
        console.log(`Profile ${options.profile} / ${result.runtime} / ${result.packageName} at ${result.targetRoot}:`);
        console.log(formatPlan(result.plan));
        if (result.plan.hasBlockingChanges) process.exitCode = 1;
      }
      if (!options.dryRun) console.log("Applied.");
      return;
    }
    const targets = await resolveCliTargets(options);
    if (!source) {
      for (const target of targets) {
        await runConfiguredPackages(target, options, { useUpdateDecision: false });
      }
      return;
    }
    for (const target of targets) {
      const { plan, bundle } = await buildPlan(source, target, options);
      console.log(formatPlan(plan));
      if (!options.dryRun) {
        await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins });
        console.log(`Applied ${target.adapter} at ${target.targetRoot}.`);
      }
      await rm(bundle.root, { recursive: true, force: true });
      if (plan.hasBlockingChanges) process.exitCode = 1;
    }
  });

program
  .command("update")
  .option("--adapter <adapter>", "built-in adapter")
  .option("--target-root <path>", "workspace root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--dry-run", "show plans without writing", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--allow-adapter-code", "allow loading local adapter code from configured packages", false)
  .option("--select <type/name>", "temporarily select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "temporarily select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .action(async (options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      await runConfiguredPackages(target, options, { useUpdateDecision: true });
    }
  });

program
  .command("registry")
  .description("manage optional registry indexes")
  .addCommand(
    new Command("update")
      .description("refresh the local registry cache")
      .option("--target-root <path>", "workspace root", process.cwd())
      .action(async (options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot) });
        const index = await client.getIndex({ refresh: true });
        console.log(`Registry refreshed: ${index.entries.length} entries from ${index.sources.join(", ")}`);
      }),
  )
  .addCommand(
    new Command("list")
      .description("list available registry entries")
      .option("--target-root <path>", "workspace root", process.cwd())
      .action(async (options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot) });
        printRegistryEntries((await client.getIndex()).entries);
      }),
  )
  .addCommand(
    new Command("search")
      .description("search registry entries")
      .argument("<query>", "search query")
      .option("--target-root <path>", "workspace root", process.cwd())
      .action(async (query, options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot) });
        printRegistryEntries(await client.search(query));
      }),
  );

program
  .command("remember")
  .requiredOption("--runtime <runtime>", "runtime/adapter name")
  .option("--target-root <path>", "workspace root", process.cwd())
  .argument("<text>", "text to append to the local instructions overlay")
  .action(async (text, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const result = await remember(targetRoot, options.runtime, text);
    console.log(`Remembered in ${result.overlayPath}. Run: agentwheel sync <source> --adapter ${options.runtime}`);
  });

program
  .command("eject")
  .argument("<item>", "package/type/name")
  .option("--target-root <path>", "workspace root", process.cwd())
  .action(async (item, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const result = await ejectArtifact(targetRoot, item);
    console.log(`Ejected ${item} to ${result.ejectedPath}.`);
  });

program
  .command("uninstall")
  .option("--adapter <adapter>", "adapter", "openclaw")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--dry-run", "show removals without writing", false)
  .option("--force", "remove drifted managed files too", false)
  .option("--select <type/name>", "uninstall only selected artifact type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "uninstall only selected skill name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .action(async (options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      const adapter = await resolveAdapterForTarget(target, options);
      const manifest = await readInstallManifest(target.targetRoot, adapter.name);
      if (!manifest) {
        console.log(`No install manifest for ${adapter.name} at ${target.targetRoot}`);
        continue;
      }
      const plan = filterUninstallPlanBySelection(await createUninstallPlan(manifest), selectedArtifactsFromOptions(options));
      console.log(formatPlan(plan));
      const result = await uninstall(plan, { dryRun: options.dryRun, force: options.force });
      if (!options.dryRun) {
        await adapter.programmatic?.uninstall?.({ targetRoot: target.targetRoot, adapterName: adapter.name });
        console.log(formatUninstallResult(result));
      }
      if (plan.hasBlockingChanges) process.exitCode = 1;
    }
  });

async function buildPlan(source: string, target: RuntimeTarget, options: { driver?: string; adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean; mode?: "pinned" | "tracking"; select?: string[]; skill?: string[]; skills?: string[] }) {
  const adapter = await resolveAdapterForTarget(target, options);
  const result = await createSourcePlan({
    source,
    targetRoot: target.targetRoot,
    workspaceRoot: target.workspaceRoot,
    adapter,
    driver: options.driver,
    mode: options.mode,
    select: selectedArtifactsFromOptions(options),
  });
  return { plan: result.plan, bundle: result.bundle };
}

async function resolveCliTargets(options: { targetRoot?: string; adapter?: string; agent?: string; all?: boolean }): Promise<RuntimeTarget[]> {
  if (options.all) {
    return resolveAllRuntimeTargets({ targetRoot: options.targetRoot, adapter: options.adapter, agent: options.agent, all: options.all });
  }
  return [await resolveRuntimeTarget({ targetRoot: options.targetRoot, adapter: options.adapter, agent: options.agent })];
}

async function resolveAdapterForTarget(target: RuntimeTarget, options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean }) {
  return resolveAdapter({
    adapter: target.adapter,
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
    allowAdapterCode: options.allowAdapterCode,
    baseDir: target.workspaceRoot,
    warn: (message) => console.warn(message),
  });
}

async function runConfiguredPackages(
  target: RuntimeTarget,
  options: { dryRun?: boolean; executePlugins?: boolean; allowAdapterCode?: boolean; adapterConfig?: string; adapterModule?: string; adapter?: string; select?: string[]; skill?: string[] },
  behavior: { useUpdateDecision: boolean },
): Promise<void> {
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  if (config.packages.length === 0) {
    console.log(`No packages configured at ${target.workspaceRoot}.`);
    return;
  }
  const selectedArtifacts = selectedArtifactsFromOptions(options);
  for (const pkg of config.packages) {
    const targetForPackage = options.adapter || target.source !== "cwd"
      ? target
      : { ...target, adapter: pkg.adapter };
    const adapter = await resolveAdapterForTarget(targetForPackage, {
      adapterConfig: options.adapterConfig ?? pkg.adapterConfig,
      adapterModule: options.adapterModule ?? pkg.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
    });
    if (behavior.useUpdateDecision) {
      const lock = await readSourceLock(targetForPackage.targetRoot, adapter.name);
      const decision = shouldUpdatePackage(pkg, lock);
      if (!decision.shouldUpdate) {
        console.log(`Skipping ${pkg.name}: ${decision.reason}.`);
        continue;
      }
    }
    const { plan, bundle } = await buildPlan(pkg.source, targetForPackage, {
      driver: pkg.driver,
      adapterConfig: options.adapterConfig ?? pkg.adapterConfig,
      adapterModule: options.adapterModule ?? pkg.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
      mode: pkg.mode,
      select: selectedArtifacts ?? pkg.select,
      skills: selectedArtifacts ? undefined : pkg.skills,
    });
    console.log(`${behavior.useUpdateDecision ? "Update" : "Sync"} ${pkg.name} (${adapter.name} at ${targetForPackage.targetRoot}):`);
    console.log(formatPlan(plan));
    if (!options.dryRun) {
      await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins });
      console.log(`Applied ${pkg.name}.`);
    }
    await rm(bundle.root, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
  }
}

function collectSelectOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function collectSkillOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function selectedArtifactsFromOptions(options: { select?: string[]; skill?: string[]; skills?: string[] }): string[] | undefined {
  return normalizeArtifactSelectors(options.select, options.skills ?? options.skill);
}

function filterUninstallPlanBySelection(plan: InstallPlan, selected?: string[]): InstallPlan {
  if (!selected?.length) return plan;
  const requested = normalizeArtifactSelectors(selected) ?? [];
  const available = new Set(plan.operations.map((operation) => `${operation.artifactType}/${operation.artifactName}`));
  const missing = requested.filter((selector) => !available.has(selector));
  if (missing.length > 0) {
    throw new Error(`Selected artifact not found in install manifest: ${missing.join(", ")}`);
  }
  const selectedSet = new Set(requested);
  const operations = plan.operations.map((operation) => {
    if (selectedSet.has(`${operation.artifactType}/${operation.artifactName}`)) return operation;
    return {
      ...operation,
      action: "skip" as const,
      desiredHash: operation.desiredHash ?? operation.manifestHash,
      reason: "not selected for uninstall",
    };
  });
  return {
    ...plan,
    operations,
    hasBlockingChanges: operations.some((operation) => operation.action === "conflict"),
  };
}

async function initPackage(root: string): Promise<void> {
  await mkdir(join(root, "instructions"), { recursive: true });
  await mkdir(join(root, "rules"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  const manifestPath = join(root, "agentwheel.json");
  const manifest = {
    schemaVersion: 1,
    name: "example/agentwheel-package",
    version: "0.1.0",
    provides: [
      { type: "instructions", path: "instructions/AGENTS.md" },
      { type: "rules", path: "rules" },
      { type: "skills", path: "skills" },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(root, "instructions", "AGENTS.md"), "# Agent Instructions\n", "utf8");
}

function formatUninstallResult(result: { removed: number; kept: number; removedDrifted: number }): string {
  const removedLabel = result.removed === 1 ? "managed file" : "managed files";
  if (result.removedDrifted > 0) {
    const driftedLabel = result.removedDrifted === 1 ? "drifted file" : "drifted files";
    return `Removed ${result.removed} ${removedLabel}, including ${result.removedDrifted} ${driftedLabel}.`;
  }
  if (result.kept === 0) return `Removed ${result.removed} ${removedLabel}.`;
  const keptLabel = result.kept === 1 ? "drifted file" : "drifted files";
  return `Removed ${result.removed} ${removedLabel}; kept ${result.kept} ${keptLabel} (use --force to remove).`;
}

function printRegistryEntries(entries: Array<{ name: string; type: string; source: string; description: string; tags?: string[] }>): void {
  for (const entry of entries) {
    const tags = entry.tags?.length ? ` [${entry.tags.join(",")}]` : "";
    console.log(`${entry.name}\t${entry.type}\t${entry.source}\t${entry.description}${tags}`);
  }
}

async function main(): Promise<void> {
  await maybeCheckForUpdate({
    currentVersion: "0.7.0",
    argv: process.argv,
    env: process.env,
    isTTY: process.stderr.isTTY === true,
  });
  await program.parseAsync();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
