import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveAdapter } from "../adapters/resolve.js";
import type { AdapterConfig } from "../model/adapter.js";
import { applyCombinedInstallPlan, applyInstallPlan, createOwnershipUninstallPlan, createUninstallPlan, normalizeTargetRoot, readInstallManifest, readSourceLock, uninstall } from "../install/index.js";
import { formatDependencyTree, formatDepsWhy, formatGraphPlan, formatLockDependencyTree, formatPlan } from "./format.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource } from "../staging/staging.js";
import { readMergedWorkspaceConfig, readWorkspaceConfig, upsertPackage, workspaceConfigPath, writeWorkspaceConfig } from "../model/workspace.js";
import type { WorkspacePackage } from "../model/workspace.js";
import { ejectArtifact, remember } from "../lifecycle/customization.js";
import { syncProfile } from "../lifecycle/profile.js";
import { createGraphSourcePlan, desiredArtifactsFromGraphBundle, createSourcePlan, graphLockPathForTarget } from "../lifecycle/source-plan.js";
import { shouldUpdatePackage } from "../lifecycle/update.js";
import { RegistryClient, resolvePackageSource } from "../registry/client.js";
import { resolveAllRuntimeTargets, resolveRuntimeTarget, type RuntimeTarget } from "../runtime/target.js";
import type { InstallPlan } from "../install/plan.js";
import type { GraphRootRequest } from "../resolve/graph.js";
import { filterArtifactsBySelection, normalizeArtifactSelectors, splitSelectorList } from "../model/selection.js";
import { maybeCheckForUpdate } from "./update-check.js";
import { pathExists } from "../utils/fs.js";
import { transportForTarget } from "../transport/index.js";
import { validatePackage } from "../model/package-validate.js";
import { migratePackageManifest } from "../model/package-migrate.js";
import { findPackageManifestPath } from "../model/package.js";
import { readGraphLock } from "../model/graph-lock.js";

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
  .option("--fleet-example", "scaffold example agents and profiles in workspace config", false)
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
    const config = await readWorkspaceConfig(root);
    const bootstrapPackage = config.bootstrapSkills === false ? undefined : await defaultBootstrapPackage(root);
    const withBootstrap = bootstrapPackage ? upsertPackage(config, bootstrapPackage) : config;
    await writeWorkspaceConfig(root, options.fleetExample ? withFleetExample(withBootstrap) : withBootstrap);
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
  .argument("[source]", "source directory")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter")
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
  .option("--no-deps", "resolve only root sources and ignore requires with a warning", false)
  .option("--only-source", "with a source argument, exclude configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (source, options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      if (source && options.noDeps && options.onlySource) {
        const { plan, bundle } = await buildPlan(source, target, options);
        console.log(formatPlan(plan));
        await rm(bundle.root, { recursive: true, force: true });
        if (plan.hasBlockingChanges) process.exitCode = 1;
        continue;
      }
      for (const result of await buildGraphPlansForTarget(target, source, options, { useUpdateDecision: false })) {
        console.log(formatGraphPlan(result));
        await rm(result.bundle.root, { recursive: true, force: true });
        if (result.plan.hasBlockingChanges) process.exitCode = 1;
      }
    }
  });

program
  .command("sync")
  .argument("[source]", "source directory")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter")
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
  .option("--no-deps", "resolve only root sources and ignore requires with a warning", false)
  .option("--only-source", "with a source argument, exclude configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
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
        noDeps: options.noDeps,
        frozenLock: options.frozenLock,
        yes: options.yes,
        trustPatterns: options.trust ?? [],
        isTTY: process.stdin.isTTY === true,
        warn: (message) => console.warn(message),
      });
      for (const result of results) {
        console.log(`Profile ${options.profile} / ${result.runtime} / ${result.packageName} at ${result.targetRoot} (${result.transport}):`);
        console.log(formatPlan(result.plan));
        if (result.plan.hasBlockingChanges) process.exitCode = 1;
      }
      if (!options.dryRun) console.log("Applied.");
      return;
    }
    const targets = await resolveCliTargets(options);
    if (!source) {
      for (const target of targets) {
        await runConfiguredGraphPackages(target, options, { useUpdateDecision: false });
      }
      return;
    }
    for (const target of targets) {
      if (options.noDeps && options.onlySource) {
        const { plan, bundle } = await buildPlan(source, target, options);
        console.log(formatPlan(plan));
        if (!options.dryRun) {
          await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins, transport: transportForTarget(target) });
          console.log(`Applied ${target.adapter} at ${target.targetRoot}.`);
        }
        await rm(bundle.root, { recursive: true, force: true });
        if (plan.hasBlockingChanges) process.exitCode = 1;
        continue;
      }
      for (const result of await buildGraphPlansForTarget(target, source, options, { useUpdateDecision: false })) {
        console.log(formatGraphPlan(result));
        if (!options.dryRun) {
          await applyCombinedInstallPlan(result.plan, {
            executePlugins: options.executePlugins,
            transport: transportForTarget(target),
            graphLockDigest: result.graphLockDigest,
            graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
          });
          console.log(`Applied ${result.plan.adapter} at ${result.plan.targetRoot}.`);
        }
        await rm(result.bundle.root, { recursive: true, force: true });
        if (result.plan.hasBlockingChanges) process.exitCode = 1;
      }
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
  .option("--no-deps", "resolve only root sources and ignore requires with a warning", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      await runConfiguredGraphPackages(target, options, { useUpdateDecision: true });
    }
  });

program
  .command("deps")
  .description("inspect the OpenPack dependency graph")
  .addCommand(
    new Command("tree")
      .argument("[source]", "optional source directory to resolve")
      .option("--adapter <adapter>", "built-in adapter")
      .option("--adapter-config <path>", "adapter JSON/JSONC file")
      .option("--adapter-module <path>", "local programmatic adapter module")
      .option("--allow-adapter-code", "allow loading local adapter code", false)
      .option("--target-root <path>", "runtime/project root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .option("--mode <mode>", "pinned or tracking")
      .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
      .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
      .option("--no-deps", "resolve only root sources and ignore requires with a warning", false)
      .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
      .option("--yes", "trust all new transitive sources", false)
      .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
      .action(async (source, options) => {
        const targets = await resolveCliTargets(options);
        for (const target of targets) {
          if (source) {
            for (const result of await buildGraphPlansForTarget(target, source, options, { useUpdateDecision: false })) {
              console.log(formatDependencyTree(result.graph).join("\n"));
              for (const decision of result.bundle.graphLock.canonical.namespacing) {
                console.log(`NAMESPACE ${decision.graphNodeId}:${decision.type}/${decision.name} -> ${decision.type}/${decision.installName} (${decision.reason})`);
              }
              await rm(result.bundle.root, { recursive: true, force: true });
            }
            continue;
          }
          const { lock } = await readTargetGraphLock(target, options);
          console.log(formatLockDependencyTree(lock));
        }
      }),
  )
  .addCommand(
    new Command("why")
      .argument("<selector>", "installed path, type/installName, or graphNodeId:type/name")
      .option("--adapter <adapter>", "built-in adapter")
      .option("--adapter-config <path>", "adapter JSON/JSONC file")
      .option("--adapter-module <path>", "local programmatic adapter module")
      .option("--allow-adapter-code", "allow loading local adapter code", false)
      .option("--target-root <path>", "runtime/project root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .action(async (selector, options) => {
        const targets = await resolveCliTargets(options);
        for (const target of targets) {
          const { lock, adapter } = await readTargetGraphLock(target, options);
          const manifest = await readInstallManifest(target.targetRoot, adapter.name, transportForTarget(target));
          console.log(formatDepsWhy(lock, manifest, selector));
        }
      }),
  );

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
  .command("package")
  .description("validate and migrate OpenPack packages")
  .addCommand(
    new Command("validate")
      .description("validate an OpenPack package manifest and local composition")
      .argument("[source]", "package directory", ".")
      .action(async (source) => {
        const result = await validatePackage(source);
        for (const finding of result.findings) {
          console.log(`${finding.level.toUpperCase()}: ${finding.message}${finding.path ? ` (${finding.path})` : ""}`);
        }
        if (result.findings.length === 0) {
          console.log(`Package validate ok${result.manifestPath ? `: ${result.manifestPath}` : ""}`);
        }
        if (!result.ok) process.exitCode = 1;
      }),
  )
  .addCommand(
    new Command("migrate")
      .description("rename agentwheel.json(c) to openpack.json(c) and upgrade schemaVersion")
      .argument("[path]", "package directory", ".")
      .action(async (path) => {
        const result = await migratePackageManifest(path);
        console.log(result.message);
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
  .argument("[package]", "configured package name or source to remove from the ownership graph")
  .option("--adapter <adapter>", "adapter")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--dry-run", "show removals without writing", false)
  .option("--force", "remove drifted managed files too", false)
  .option("--select <type/name>", "uninstall only selected artifact type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "uninstall only selected skill name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--frozen-lock", "resolve remaining packages strictly from the existing graph lock and cached sources", false)
  .option("--yes", "trust all new transitive sources while resolving remaining packages", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (packageName, options) => {
    const targets = await resolveCliTargets(options);
    for (const target of targets) {
      if (packageName) {
        await uninstallConfiguredPackage(target, packageName, options);
        continue;
      }
      const adapter = await resolveAdapterForTarget(target, options);
      const transport = transportForTarget(target);
      const manifest = await readInstallManifest(target.targetRoot, adapter.name, transport);
      if (!manifest) {
        console.log(`No install manifest for ${adapter.name} at ${target.targetRoot}`);
        continue;
      }
      const plan = filterUninstallPlanBySelection(await createUninstallPlan(manifest), selectedArtifactsFromOptions(options));
      console.log(formatPlan(plan));
      const result = await uninstall(plan, { dryRun: options.dryRun, force: options.force, transport });
      if (!options.dryRun) {
        if (transport.kind !== "local" && adapter.programmatic?.uninstall) {
          throw new Error(`Cannot execute programmatic adapter uninstall over ${transport.description}.`);
        }
        await adapter.programmatic?.uninstall?.({ targetRoot: target.targetRoot, adapterName: adapter.name });
        console.log(formatUninstallResult(result));
      }
      if (plan.hasBlockingChanges) process.exitCode = 1;
    }
  });

async function buildPlan(source: string, target: RuntimeTarget, options: { driver?: string; adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean; mode?: "pinned" | "tracking"; select?: string[]; skill?: string[]; skills?: string[] }) {
  const adapter = await resolveAdapterForTarget(target, options);
  const transport = transportForTarget(target);
  const result = await createSourcePlan({
    source,
    targetRoot: target.targetRoot,
    workspaceRoot: target.workspaceRoot,
    adapter,
    driver: options.driver,
    mode: options.mode,
    select: selectedArtifactsFromOptions(options),
    transport,
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

interface GraphCliOptions {
  dryRun?: boolean;
  executePlugins?: boolean;
  allowAdapterCode?: boolean;
  adapterConfig?: string;
  adapterModule?: string;
  adapter?: string;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skill?: string[];
  skills?: string[];
  noDeps?: boolean;
  onlySource?: boolean;
  frozenLock?: boolean;
  yes?: boolean;
  trust?: string[];
}

interface PackageGraphGroup {
  target: RuntimeTarget;
  adapterOptions: {
    adapterConfig?: string;
    adapterModule?: string;
    allowAdapterCode?: boolean;
  };
  packages: WorkspacePackage[];
  extraRoots: GraphRootRequest[];
}

async function runConfiguredGraphPackages(
  target: RuntimeTarget,
  options: GraphCliOptions,
  behavior: { useUpdateDecision: boolean },
): Promise<void> {
  const results = await buildGraphPlansForTarget(target, undefined, options, behavior);
  for (const result of results) {
    console.log(`${behavior.useUpdateDecision ? "Update" : "Sync"} ${result.plan.adapter} at ${result.plan.targetRoot}:`);
    console.log(formatGraphPlan(result));
    if (!options.dryRun) {
      await applyCombinedInstallPlan(result.plan, {
        executePlugins: options.executePlugins,
        transport: transportForTarget(target),
        graphLockDigest: result.graphLockDigest,
        graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
      });
      console.log(`Applied ${result.plan.adapter} at ${result.plan.targetRoot}.`);
    }
    await rm(result.bundle.root, { recursive: true, force: true });
    if (result.plan.hasBlockingChanges) process.exitCode = 1;
  }
}

async function buildGraphPlansForTarget(
  target: RuntimeTarget,
  source: string | undefined,
  options: GraphCliOptions,
  _behavior: { useUpdateDecision: boolean },
) {
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  const groups = new Map<string, PackageGraphGroup>();
  const selectedArtifacts = selectedArtifactsFromOptions(options);

  if (!source || !options.onlySource) {
    for (const pkg of config.packages) {
      const group = graphGroupForPackage(groups, target, pkg, options);
      group.packages.push(pkg);
    }
  }

  if (source) {
    const sourceTarget = target;
    const key = graphGroupKey(sourceTarget, {
      adapterConfig: options.adapterConfig,
      adapterModule: options.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
    });
    const group = groups.get(key) ?? {
      target: sourceTarget,
      adapterOptions: {
        adapterConfig: options.adapterConfig,
        adapterModule: options.adapterModule,
        allowAdapterCode: options.allowAdapterCode,
      },
      packages: [],
      extraRoots: [],
    };
    group.extraRoots.push({
      rootId: `source:${source}`,
      source,
      mode: options.mode ?? "pinned",
      select: selectedArtifacts,
    });
    groups.set(key, group);
  }

  if (groups.size === 0) {
    console.log(`No packages configured at ${target.workspaceRoot}.`);
    return [];
  }

  const results = [];
  for (const group of groups.values()) {
    const adapter = await resolveAdapterForTarget(group.target, group.adapterOptions);
    const roots: GraphRootRequest[] = [
      ...group.packages.map((pkg) => ({
        rootId: pkg.name,
        source: pkg.source,
        mode: pkg.mode,
        ref: pkg.requestedRef,
        select: selectedArtifacts ?? normalizeArtifactSelectors(pkg.select, pkg.skills),
        aliases: pkg.aliases,
      })),
      ...group.extraRoots,
    ];
    if (roots.length === 0) continue;
    results.push(await createGraphSourcePlan({
      roots,
      targetRoot: group.target.targetRoot,
      workspaceRoot: group.target.workspaceRoot,
      adapter,
      transport: transportForTarget(group.target),
      targetKey: group.target.agentName ?? group.target.source,
      targetFingerprintParts: targetFingerprintParts(group.target, adapter, group.adapterOptions),
      noDeps: options.noDeps,
      frozenLock: options.frozenLock,
      yes: options.yes,
      trustPatterns: options.trust ?? [],
      isTTY: process.stdin.isTTY === true,
    }));
  }
  return results;
}

async function uninstallConfiguredPackage(target: RuntimeTarget, packageName: string, options: GraphCliOptions & { force?: boolean }): Promise<void> {
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  const removed = config.packages.filter((pkg) => pkg.name === packageName || pkg.source === packageName);
  if (removed.length === 0) {
    throw new Error(`Configured package not found: ${packageName}`);
  }
  const remaining = config.packages.filter((pkg) => !removed.includes(pkg));
  const groups = new Map<string, PackageGraphGroup>();
  for (const pkg of remaining) {
    const group = graphGroupForPackage(groups, target, pkg, options);
    group.packages.push(pkg);
  }

  for (const pkg of removed) {
    const removedTarget = targetForPackage(target, pkg, options);
    const removedAdapterOptions = {
      adapterConfig: options.adapterConfig ?? pkg.adapterConfig,
      adapterModule: options.adapterModule ?? pkg.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
    };
    const adapter = await resolveAdapterForTarget(removedTarget, removedAdapterOptions);
    const transport = transportForTarget(removedTarget);
    const manifest = await readInstallManifest(removedTarget.targetRoot, adapter.name, transport);
    if (!manifest) {
      console.log(`No install manifest for ${adapter.name} at ${removedTarget.targetRoot}`);
      continue;
    }

    const key = graphGroupKey(removedTarget, removedAdapterOptions);
    const remainingGroup = groups.get(key);
    let remainingDesired: ReturnType<typeof desiredArtifactsFromGraphBundle> = [];
    let remainingGraphPlan: Awaited<ReturnType<typeof createGraphSourcePlan>> | undefined;
    let renderedRoot: string | undefined;
    if (remainingGroup && remainingGroup.packages.length > 0) {
      const remainingAdapter = await resolveAdapterForTarget(remainingGroup.target, remainingGroup.adapterOptions);
      const result = await createGraphSourcePlan({
        roots: remainingGroup.packages.map((pkg) => ({
          rootId: pkg.name,
          source: pkg.source,
          mode: pkg.mode,
          ref: pkg.requestedRef,
          select: normalizeArtifactSelectors(pkg.select, pkg.skills),
          aliases: pkg.aliases,
        })),
        targetRoot: remainingGroup.target.targetRoot,
        workspaceRoot: remainingGroup.target.workspaceRoot,
        adapter: remainingAdapter,
        transport,
        targetKey: remainingGroup.target.agentName ?? remainingGroup.target.source,
        targetFingerprintParts: targetFingerprintParts(remainingGroup.target, remainingAdapter, remainingGroup.adapterOptions),
        frozenLock: options.frozenLock,
        yes: options.yes,
        trustPatterns: options.trust ?? [],
        isTTY: process.stdin.isTTY === true,
      });
      remainingGraphPlan = result;
      remainingDesired = desiredArtifactsFromGraphBundle(result.bundle);
      renderedRoot = result.bundle.root;
    }

    const plan = await createOwnershipUninstallPlan(manifest, remainingDesired, adapter, transport, { graphLockDigest: remainingGraphPlan?.graphLockDigest });
    console.log(`Uninstall ${pkg.name} (${adapter.name} at ${removedTarget.targetRoot}):`);
    console.log(formatPlan(plan));
    const graphLockFinalState = remainingGraphPlan
      ? { graphLock: { path: remainingGraphPlan.graphLockPath, lock: remainingGraphPlan.bundle.graphLock } }
      : {
          removeGraphLockPath: graphLockPathForTarget(
            removedTarget.workspaceRoot,
            removedTarget.agentName ?? removedTarget.source,
            adapter.name,
            targetFingerprintParts(removedTarget, adapter, removedAdapterOptions),
          ),
        };
    const result = await uninstall(plan, {
      dryRun: options.dryRun,
      force: options.force,
      transport,
      ...graphLockFinalState,
      workspaceConfig: {
        path: workspaceConfigPath(target.workspaceRoot),
        data: { ...config, packages: remaining },
      },
    });
    if (!options.dryRun) {
      console.log(formatUninstallResult(result));
    }
    if (renderedRoot) await rm(renderedRoot, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
  }
}

function graphGroupForPackage(
  groups: Map<string, PackageGraphGroup>,
  target: RuntimeTarget,
  pkg: WorkspacePackage,
  options: GraphCliOptions,
): PackageGraphGroup {
  const packageTarget = targetForPackage(target, pkg, options);
  const adapterOptions = {
    adapterConfig: options.adapterConfig ?? pkg.adapterConfig,
    adapterModule: options.adapterModule ?? pkg.adapterModule,
    allowAdapterCode: options.allowAdapterCode,
  };
  const key = graphGroupKey(packageTarget, adapterOptions);
  const existing = groups.get(key);
  if (existing) return existing;
  const created = {
    target: packageTarget,
    adapterOptions,
    packages: [],
    extraRoots: [],
  };
  groups.set(key, created);
  return created;
}

function targetForPackage(target: RuntimeTarget, pkg: WorkspacePackage, options: GraphCliOptions): RuntimeTarget {
  return options.adapter || target.source !== "cwd" ? target : { ...target, adapter: pkg.adapter };
}

function graphGroupKey(target: RuntimeTarget, options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean }): string {
  return JSON.stringify({
    adapter: target.adapter,
    targetRoot: target.targetRoot,
    transport: target.transport,
    agentName: target.agentName,
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
  });
}

function targetFingerprintParts(target: RuntimeTarget, adapter: AdapterConfig, options: { adapterConfig?: string; adapterModule?: string }): unknown {
  return {
    adapter: adapter.name,
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
    adapterCodeHash: adapter.programmatic?.hash,
    agentName: target.agentName,
    targetRoot: target.targetRoot,
    transport: target.transport,
    ssh: target.ssh,
  };
}

async function readTargetGraphLock(
  target: RuntimeTarget,
  options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean },
) {
  const adapter = await resolveAdapterForTarget(target, options);
  const path = graphLockPathForTarget(
    target.workspaceRoot,
    target.agentName ?? target.source,
    adapter.name,
    targetFingerprintParts(target, adapter, options),
  );
  if (!(await pathExists(path))) {
    throw new Error(`No graph lock for ${adapter.name} at ${target.targetRoot}: ${path}`);
  }
  return { adapter, path, lock: await readGraphLock(path) };
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
      const transport = transportForTarget(targetForPackage);
      const lock = await readSourceLock(targetForPackage.targetRoot, adapter.name, transport);
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
      await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins, transport: transportForTarget(targetForPackage) });
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

function collectTrustOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  const manifestPath = join(root, "openpack.json");
  const manifest = {
    schemaVersion: 2,
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

async function defaultBootstrapPackage(_root: string): Promise<WorkspacePackage | undefined> {
  const packageRoot = await findAgentwheelPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) return undefined;
  return {
    name: "agentwheel",
    source: packageRoot,
    driver: "local",
    adapter: "openclaw",
    mode: "tracking",
    select: ["skills/agentwheel"],
  };
}

function withFleetExample(config: Awaited<ReturnType<typeof readWorkspaceConfig>>) {
  return {
    ...config,
    agents: {
      ...config.agents,
      "local-codex": config.agents["local-codex"] ?? {
        adapter: "codex",
        root: ".",
        transport: "local" as const,
      },
      "remote-codex": config.agents["remote-codex"] ?? {
        adapter: "codex",
        root: "/home/administrator/agent-runtime",
        transport: "ssh" as const,
        host: "remote-host.example",
        user: "administrator",
        port: 22,
        identityFile: "~/.ssh/id_ed25519",
      },
    },
    profiles: {
      ...config.profiles,
      fleet: config.profiles.fleet ?? {
        runtimes: [
          { agent: "local-codex" },
          { agent: "remote-codex" },
        ],
      },
    },
  };
}

async function findAgentwheelPackageRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    if (await findPackageManifestPath(current, { warnLegacy: false })) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
