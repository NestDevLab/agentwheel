import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveAdapter } from "../adapters/resolve.js";
import {
  installRootForAdapterInstallationType,
  resolveInstallationTypeForAdapter,
  resolveInstallationTypeForArtifacts,
  type AdapterConfig,
} from "../model/adapter.js";
import { applyCombinedInstallPlan, createOwnershipUninstallPlan, createUninstallPlan, normalizeTargetRoot, readInstallManifest, uninstall } from "../install/index.js";
import { stateKeyFor } from "../install/paths.js";
import { formatDependencyTree, formatDepsWhy, formatGraphPlan, formatLockDependencyTree, formatPlan } from "./format.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource } from "../staging/staging.js";
import { readMergedWorkspaceConfig, readWorkspaceConfig, upsertPackage, workspaceConfigPath, writeWorkspaceConfig } from "../model/workspace.js";
import type { WorkspacePackage } from "../model/workspace.js";
import { ejectArtifact, remember } from "../lifecycle/customization.js";
import { syncProfile } from "../lifecycle/profile.js";
import { forgetTrustedSources } from "../lifecycle/trust.js";
import { createGraphSourcePlan, desiredArtifactsFromGraphBundle, graphLockPathForTarget, type GraphSourcePlanResult } from "../lifecycle/source-plan.js";
import { RegistryClient, resolvePackageSource } from "../registry/client.js";
import { resolveAllDetectedRuntimeTargets, resolveAllRuntimeTargets, resolveProfileRuntimeTargets, resolveRuntimeTarget, type RuntimeTarget } from "../runtime/target.js";
import { isPendingInstallOperation, type InstallOperation, type InstallPlan } from "../install/plan.js";
import type { InstallManifest } from "../model/manifest.js";
import type { GraphRootRequest } from "../resolve/graph.js";
import { filterArtifactsBySelection, normalizeArtifactSelectors, splitSelectorList } from "../model/selection.js";
import { maybeCheckForUpdate } from "./update-check.js";
import { pathExists } from "../utils/fs.js";
import { transportForTarget } from "../transport/index.js";
import { validatePackage } from "../model/package-validate.js";
import { migratePackageManifest } from "../model/package-migrate.js";
import { findPackageManifestPath } from "../model/package.js";
import { computeTargetFingerprint, readGraphLock } from "../model/graph-lock.js";
import { resolveCliVersion } from "./version.js";

const CLI_VERSION = resolveCliVersion();

const program = new Command();

program
  .name("agentwheel")
  .description("Multi-runtime agent artifact orchestrator")
  .version(CLI_VERSION)
  .showSuggestionAfterError(false)
  .option("--no-update-check", "disable npm version update check", false)
  .addHelpText("after", `

Core flow:
  $ agentwheel add github:org/agent-pack --adapter codex
  $ agentwheel plan
  $ agentwheel install
`);

program
  .command("init")
  .description("initialize an agentwheel workspace or package")
  .argument("[kind]", "workspace or package", "workspace")
  .option("-t, --target-root <path>", "workspace root", process.cwd())
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
    console.log(`Initialized ${workspaceConfigPath(root)}.`);
    if (bootstrapPackage) console.log("Auto-added the agentwheel bootstrap skill for openclaw.");
    console.log(nextInstallNudge());
  });

program
  .command("add")
  .description("add a package to .agentwheel/config.json without touching runtimes")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver (local, git, skillkit, or vercel-skills)")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "workspace root")
  .option("--mode <mode>", "pinned or tracking", "pinned")
  .option("--name <name>", "package alias")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--override <source-or-package::type/name>", "allow this package to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .action(async (source, options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targetRoot = normalizeTargetRoot(normalizedOptions.targetRoot ?? process.cwd());
    const entry = await packageEntryFromSource(source, targetRoot, normalizedOptions);
    await writeWorkspaceConfig(targetRoot, upsertPackage(await readWorkspaceConfig(targetRoot), entry));
    console.log(`Added ${entry.name}. Preview: agentwheel plan - Apply: agentwheel install`);
  });

program
  .command("list")
  .description("list artifacts exposed by a package source")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("-t, --target-root <path>", "workspace root", process.cwd())
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
  .description("scan a package source for validation findings")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("-t, --target-root <path>", "workspace root", process.cwd())
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
  .description("preview what install would reconcile without writing")
  .argument("[name-or-source]", "configured package name/source or package source to preview")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--all-detected", "run for every runtime directory detected in the target root", false)
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--override <source-or-package::type/name>", "for source previews, allow the source to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--dry-run", "accepted for symmetry; plan never writes", false)
  .option("--force-drift", "replace drifted managed artifacts during install planning", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "with a source argument, exclude configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (source, options) => {
    await runInstallCommand(source, { ...options, dryRun: true }, { apply: false });
  });

program
  .command("install")
  .description("install configured packages into runtime targets")
  .argument("[name-or-source]", "configured package name/source or package source to add and install")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--all-detected", "run for every runtime directory detected in the target root", false)
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--override <source-or-package::type/name>", "when adding a source, allow it to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plan without writing", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "with a source argument, exclude configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .addHelpText("after", "\nScoped install never removes files owned only by other configured packages; run a full install to reconcile those removals.\n")
  .action(async (source, options) => {
    await runInstallCommand(source, options, { apply: !options.dryRun });
  });

program
  .command("sync", { hidden: true })
  .argument("[name-or-source]", "configured package name/source or package source")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--all-detected", "run for every runtime directory detected in the target root", false)
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--override <source-or-package::type/name>", "when adding a source, allow it to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plan without writing", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "with a source argument, exclude configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (source, options) => {
    console.error("warning: 'agentwheel sync' is deprecated and will be removed in 0.10. Use 'agentwheel install'.");
    await runInstallCommand(source, options, { apply: !options.dryRun });
  });

program
  .command("update")
  .description("re-resolve tracking packages, then apply the result")
  .argument("[name]", "configured package name or source to update")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("-t, --target-root <path>", "workspace root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plans without writing", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--allow-adapter-code", "allow loading local adapter code from configured packages", false)
  .option("--select <type/name>", "temporarily select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "temporarily select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (name, options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targets = await resolveCliTargets(normalizedOptions, { preferAllProfile: true });
    for (const target of targets) {
      await runConfiguredGraphPackages(target, { ...normalizedOptions, scope: name }, { mode: "update" });
    }
  });

program
  .command("deps")
  .description("inspect the OpenPack dependency graph")
  .addCommand(
    new Command("tree")
      .description("print the OpenPack dependency graph")
      .argument("[source]", "optional package source to resolve")
      .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
      .option("-i, --installation-type <type>", "installation type (for example local or user)")
      .option("--user", "shortcut for --installation-type user and home-scoped state", false)
      .option("--local", "shortcut for --installation-type local", false)
      .option("--adapter-config <path>", "adapter JSON/JSONC file")
      .option("--adapter-module <path>", "local programmatic adapter module")
      .option("--allow-adapter-code", "allow loading local adapter code", false)
      .option("-t, --target-root <path>", "runtime/project root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .option("--mode <mode>", "pinned or tracking")
      .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
      .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
      .option("--no-deps", "resolve only root sources and ignore requires with a warning")
      .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
      .option("--offline", "resolve strictly from graph locks and local caches", false)
      .option("--yes", "trust all new transitive sources", false)
      .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
      .action(async (source, options) => {
        const normalizedOptions = normalizeRuntimeScopeOptions(options, { defaultUser: shouldDefaultUserInstall(source, options) });
        const targets = await resolveCliTargets(normalizedOptions);
        for (const target of targets) {
          if (source) {
            for (const result of await buildGraphPlansForTarget(target, source, normalizedOptions, { mode: "install" })) {
              console.log(formatDependencyTree(result.graph).join("\n"));
              for (const decision of result.bundle.graphLock.canonical.namespacing) {
                console.log(`NAMESPACE ${decision.graphNodeId}:${decision.type}/${decision.name} -> ${decision.type}/${decision.installName} (${decision.reason})`);
              }
              for (const decision of result.bundle.graphLock.canonical.overrides) {
                console.log(`OVERRIDE ${decision.graphNodeId}:${decision.type}/${decision.name} replaces ${decision.overriddenGraphNodeId}:${decision.type}/${decision.name} via ${decision.rootId} (${decision.selector})`);
              }
              await rm(result.bundle.root, { recursive: true, force: true });
            }
            continue;
          }
          const { lock } = await readTargetGraphLock(target, normalizedOptions);
          console.log(formatLockDependencyTree(lock));
        }
      }),
  )
  .addCommand(
    new Command("why")
      .description("explain why an artifact is installed")
      .argument("<selector>", "installed path, type/installName, or graphNodeId:type/name")
      .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
      .option("-i, --installation-type <type>", "installation type (for example local or user)")
      .option("--user", "shortcut for --installation-type user and home-scoped state", false)
      .option("--local", "shortcut for --installation-type local", false)
      .option("--adapter-config <path>", "adapter JSON/JSONC file")
      .option("--adapter-module <path>", "local programmatic adapter module")
      .option("--allow-adapter-code", "allow loading local adapter code", false)
      .option("-t, --target-root <path>", "runtime/project root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .action(async (selector, options) => {
        const normalizedOptions = normalizeRuntimeScopeOptions(options);
        const targets = await resolveCliTargets(normalizedOptions);
        for (const target of targets) {
          const { lock, adapter } = await readTargetGraphLock(target, normalizedOptions);
          const installationType = normalizedOptions.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
          const state = installStateForTarget(target, adapter, normalizedOptions, installationType);
          const manifest = await readInstallManifest(state.installRoot, adapter.name, transportForTarget(target), state);
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
      .option("-t, --target-root <path>", "workspace root", process.cwd())
      .action(async (options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot), warn: (message) => console.warn(message) });
        const index = await client.getIndex({ refresh: true });
        console.log(`Registry refreshed: ${index.entries.length} entries from ${index.sources.join(", ")}`);
      }),
  )
  .addCommand(
    new Command("list")
      .description("list available registry entries")
      .option("-t, --target-root <path>", "workspace root", process.cwd())
      .action(async (options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot), warn: (message) => console.warn(message) });
        printRegistryEntries((await client.getIndex()).entries);
      }),
  )
  .addCommand(
    new Command("search")
      .description("search registry entries")
      .argument("<query>", "search query")
      .option("-t, --target-root <path>", "workspace root", process.cwd())
      .action(async (query, options) => {
        const client = new RegistryClient({ workspaceRoot: normalizeTargetRoot(options.targetRoot), warn: (message) => console.warn(message) });
        printRegistryEntries(await client.search(query));
      }),
  );

program
  .command("trust")
  .description("manage persisted source trust decisions")
  .addCommand(
    new Command("forget")
      .description("forget a persisted trusted source pattern")
      .argument("<pattern>", "trusted source glob to revoke")
      .option("-t, --target-root <path>", "workspace root", process.cwd())
      .action(async (pattern, options) => {
        const removed = await forgetTrustedSources(normalizeTargetRoot(options.targetRoot), pattern);
        if (removed.length === 0) {
          console.log(`No persisted trust matched ${pattern}.`);
          return;
        }
        console.log(`Forgot ${removed.length} trusted source${removed.length === 1 ? "" : "s"}:`);
        for (const source of removed) console.log(`- ${source}`);
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
  .description("append text to the local instructions overlay")
  .requiredOption("--runtime <runtime>", "runtime/adapter name")
  .option("-t, --target-root <path>", "workspace root", process.cwd())
  .argument("<text>", "text to append to the local instructions overlay")
  .action(async (text, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const result = await remember(targetRoot, options.runtime, text);
    console.log(`Remembered in ${result.overlayPath}.`);
    console.log(nextInstallNudge());
  });

program
  .command("eject")
  .description("copy a managed artifact into local ownership")
  .argument("<item>", "package/type/name")
  .option("-t, --target-root <path>", "workspace root", process.cwd())
  .action(async (item, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const result = await ejectArtifact(targetRoot, item);
    console.log(`Ejected ${item} to ${result.ejectedPath}.`);
    console.log(nextInstallNudge());
  });

program
  .command("uninstall")
  .description("remove configured packages or managed runtime files")
  .argument("[package]", "configured package name or source to remove from the ownership graph")
  .option("--adapter <adapter>", "adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--dry-run", "show removals without writing", false)
  .option("--force", "remove drifted managed files too", false)
  .option("--keep-files", "remove from config and manifest but leave runtime files unmanaged", false)
  .option("--select <type/name>", "uninstall only selected artifact type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "uninstall only selected skill name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--frozen-lock", "resolve remaining packages strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve remaining packages strictly from graph locks and local caches", false)
  .option("--yes", "trust all new transitive sources while resolving remaining packages", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (packageName, options) => {
    if (options.keepFiles && options.force) {
      throw new Error("--keep-files cannot be combined with --force.");
    }
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targets = await resolveCliTargets(normalizedOptions);
    for (const target of targets) {
      if (packageName) {
        await uninstallConfiguredPackage(target, packageName, normalizedOptions);
        continue;
      }
      if (normalizedOptions.keepFiles) {
        throw new Error("--keep-files requires a configured package name or source.");
      }
      const adapter = await resolveAdapterForTarget(target, normalizedOptions);
      const transport = transportForTarget(target);
      const installationType = normalizedOptions.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
      const state = installStateForTarget(target, adapter, normalizedOptions, installationType);
      const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
      if (!manifest) {
        console.log(`No install manifest for ${adapter.name}/${installationType} at ${state.installRoot}`);
        continue;
      }
      const plan = filterUninstallPlanBySelection(await createUninstallPlan(manifest), selectedArtifactsFromOptions(options));
      console.log(formatPlan(plan));
      const result = await uninstall(plan, { dryRun: normalizedOptions.dryRun, force: normalizedOptions.force, transport });
      if (!normalizedOptions.dryRun) {
        if (transport.kind !== "local" && adapter.programmatic?.uninstall) {
          throw new Error(`Cannot execute programmatic adapter uninstall over ${transport.description}.`);
        }
        await adapter.programmatic?.uninstall?.({ targetRoot: state.installRoot, adapterName: adapter.name });
        console.log(formatUninstallResult(result));
      }
      if (plan.hasBlockingChanges) process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("show configured packages and runtime install state")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "shortcut for --installation-type user and home-scoped state", false)
  .option("--local", "shortcut for --installation-type local", false)
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--profile <name>", "workspace runtime profile")
  .action(async (options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targets = await resolveCliTargets(normalizedOptions, { preferAllProfile: true });
    for (const target of targets) {
      await printStatus(target, normalizedOptions);
    }
  });

async function runInstallCommand(
  nameOrSource: string | undefined,
  options: GraphCliOptions & {
    profile?: string;
    targetRoot?: string;
    agent?: string;
    all?: boolean;
    allDetected?: boolean;
    adapter?: string;
    installationType?: string;
    multiAdapterSource?: boolean;
  },
  behavior: { apply: boolean },
): Promise<void> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options, { defaultUser: shouldDefaultUserInstall(nameOrSource, options) });
  if (options.profile) {
    const target = await resolveRuntimeTarget({
      targetRoot: normalizedOptions.targetRoot,
      adapter: normalizedOptions.adapter,
      installationType: normalizedOptions.installationType,
      agent: normalizedOptions.agent,
    });
    const results = await syncProfile({
      workspaceRoot: target.workspaceRoot,
      profile: options.profile,
      source: nameOrSource,
      driver: normalizedOptions.driver,
      mode: normalizedOptions.mode,
      select: selectedArtifactsFromOptions(normalizedOptions),
      installationType: normalizedOptions.installationType,
      dryRun: !behavior.apply,
      executePlugins: normalizedOptions.executePlugins,
      allowAdapterCode: normalizedOptions.allowAdapterCode,
      forceDrift: normalizedOptions.forceDrift,
      forceConflict: normalizedOptions.forceConflict,
      replaceConflict: normalizedOptions.replaceConflict,
      noDeps: noDepsFromOptions(normalizedOptions),
      lockedResolution: true,
      frozenLock: normalizedOptions.frozenLock,
      offline: normalizedOptions.offline,
      yes: normalizedOptions.yes,
      trustPatterns: normalizedOptions.trust ?? [],
      readOnly: !behavior.apply,
      isTTY: process.stdin.isTTY === true,
      warn: (message) => console.warn(message),
    });
    for (const result of results) {
      console.log(`Profile ${normalizedOptions.profile} / ${result.runtime} / ${result.packageName} at ${result.targetRoot} (${result.transport}):`);
      console.log(formatPlan(result.plan));
      if (result.plan.hasBlockingChanges) process.exitCode = 1;
    }
    if (behavior.apply) console.log("Applied.");
    return;
  }

  const targets = await resolveCliTargets(normalizedOptions);
  for (const target of targets) {
    const targetOptions = optionsForResolvedTarget(normalizedOptions, target);
    const config = await readMergedWorkspaceConfig(target.workspaceRoot);
    const configured = nameOrSource ? findConfiguredPackageForTarget(config.packages, nameOrSource, targetOptions, target) : undefined;
    let source: string | undefined;
    let scope = configured?.name;
    let extraPackage: WorkspacePackage | undefined;

    if (nameOrSource && !configured) {
      try {
        let entry = await packageEntryFromSource(nameOrSource, target.workspaceRoot, { ...targetOptions, adapter: targetOptions.adapter ?? target.adapter });
        if (targetOptions.multiAdapterSource) {
          entry = packageEntryWithAdapterSuffix(entry);
        }
        scope = entry.name;
        source = nameOrSource;
        extraPackage = entry;
      } catch (error) {
        throw teachingInstallError(nameOrSource, error);
      }
    }

    for (const result of await buildGraphPlansForTarget(target, source, { ...targetOptions, scope, extraPackage }, { mode: "install" })) {
      console.log(formatGraphPlan(result));
      if (behavior.apply) {
        await applyCombinedInstallPlan(result.plan, {
          executePlugins: targetOptions.executePlugins,
          transport: transportForTarget(target),
          graphLockDigest: result.graphLockDigest,
          graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
        });
        console.log(`Applied ${result.plan.adapter} at ${result.plan.targetRoot}.`);
      }
      await rm(result.bundle.root, { recursive: true, force: true });
      if (result.plan.hasBlockingChanges) process.exitCode = 1;
    }

    if (behavior.apply && extraPackage && !targetOptions.onlySource) {
      await writeWorkspaceConfig(target.workspaceRoot, upsertPackage(await readWorkspaceConfig(target.workspaceRoot), extraPackage));
    }
  }
}

async function packageEntryFromSource(
  source: string,
  targetRoot: string,
  options: {
    driver?: string;
    adapter?: string;
    adapterConfig?: string;
    adapterModule?: string;
    allowAdapterCode?: boolean;
    mode?: "pinned" | "tracking";
    name?: string;
    select?: string[];
    skill?: string[];
    skills?: string[];
    override?: string[];
    overrides?: string[];
    frozenLock?: boolean;
    offline?: boolean;
    installationType?: string;
  },
): Promise<WorkspacePackage> {
  const selectedArtifacts = selectedArtifactsFromOptions(options);
  const lockMode = options.frozenLock === true || options.offline === true;
  const resolvedInput = await resolvePackageSource(source, targetRoot, { offline: lockMode });
  const resolvedSource = resolvedInput.source;
  const driverName = (options.driver ?? inferSourceDriverName(resolvedSource)) as WorkspacePackage["driver"];
  const driver = getSourceDriver(driverName);
  const adapter = await resolveAdapter({
    adapter: options.adapter ?? "openclaw",
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
    frozenLock: lockMode,
    select: selectedArtifacts,
  });
  const installationType = resolveInstallationTypeForArtifacts(adapter, bundle.artifacts.map((artifact) => artifact.type), options.installationType);
  try {
    return {
      name: options.name ?? resolvedInput.registryEntry?.name ?? bundle.source.packageName ?? source,
      source: resolvedSource,
      driver: driverName,
      adapter: adapter.name,
      installationType,
      adapterConfig: options.adapterConfig,
      adapterModule: options.adapterModule,
      adapterCodeHash: adapter.programmatic?.hash,
      mode: options.mode ?? "pinned",
      requestedRef: bundle.source.requestedRef,
      select: selectedArtifacts,
      overrides: overrideArtifactsFromOptions(options),
    };
  } finally {
    await rm(bundle.root, { recursive: true, force: true });
  }
}

function findConfiguredPackage(packages: WorkspacePackage[], value: string): WorkspacePackage | undefined {
  return packages.find((pkg) => pkg.name === value || pkg.source === value);
}

function findConfiguredPackageForTarget(
  packages: WorkspacePackage[],
  value: string,
  options: { multiAdapterSource?: boolean },
  target: RuntimeTarget,
): WorkspacePackage | undefined {
  const matches = packages.filter((pkg) => pkg.name === value || pkg.source === value);
  return options.multiAdapterSource ? matches.find((pkg) => pkg.adapter === target.adapter) : matches[0];
}

function noDepsFromOptions(options: { noDeps?: boolean; deps?: boolean }): boolean {
  return options.noDeps === true || options.deps === false;
}

function packageEntryWithAdapterSuffix(entry: WorkspacePackage): WorkspacePackage {
  const suffix = `-${entry.adapter}`;
  return entry.name.endsWith(suffix) ? entry : { ...entry, name: `${entry.name}${suffix}` };
}

function teachingInstallError(input: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `'${input}' is not a configured package and could not be resolved as a source.\n`
    + "  To add and install a new package:   agentwheel install <source>   (e.g. github:org/pack)\n"
    + "  To see what's configured:   agentwheel status\n"
    + `\nResolver error: ${message}`,
  );
}

function nextInstallNudge(): string {
  return "Preview: agentwheel plan - Apply: agentwheel install";
}

async function resolveCliTargets(
  options: { targetRoot?: string; adapter?: string; installationType?: string; agent?: string; profile?: string; all?: boolean; allDetected?: boolean },
  behavior: { preferAllProfile?: boolean } = {},
): Promise<RuntimeTarget[]> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options);
  if (normalizedOptions.all && normalizedOptions.allDetected) {
    throw new Error("Choose either --all for configured agents or --all-detected for detected runtime directories.");
  }
  if (normalizedOptions.profile && (normalizedOptions.all || normalizedOptions.allDetected || normalizedOptions.agent)) {
    throw new Error("--profile cannot be combined with --all, --all-detected, or --agent.");
  }
  const adapters = adapterListFromOption(normalizedOptions.adapter);
  if (adapters.length > 1) {
    if (normalizedOptions.all || normalizedOptions.allDetected || normalizedOptions.agent || normalizedOptions.profile) {
      throw new Error("--adapter <a,b> cannot be combined with --all, --all-detected, --agent, or --profile. Use a profile for mixed configured targets.");
    }
    const targets = [];
    for (const adapter of adapters) {
      targets.push(await resolveRuntimeTarget({
        targetRoot: normalizedOptions.targetRoot,
        adapter,
        installationType: normalizedOptions.installationType,
      }));
    }
    return targets;
  }
  if (normalizedOptions.profile) {
    return resolveProfileRuntimeTargets({
      cwd: process.cwd(),
      targetRoot: normalizedOptions.targetRoot,
      installationType: normalizedOptions.installationType,
      profile: normalizedOptions.profile,
    });
  }
  if (normalizedOptions.all) {
    if (behavior.preferAllProfile && !normalizedOptions.agent) {
      const profileTargets = await tryResolveProfileAllRuntimeTargets(normalizedOptions);
      if (profileTargets) return profileTargets;
    }
    return resolveAllRuntimeTargets({
      targetRoot: normalizedOptions.targetRoot,
      adapter: normalizedOptions.adapter,
      installationType: normalizedOptions.installationType,
      agent: normalizedOptions.agent,
      all: normalizedOptions.all,
    });
  }
  if (normalizedOptions.allDetected) {
    return resolveAllDetectedRuntimeTargets({
      targetRoot: normalizedOptions.targetRoot,
      adapter: normalizedOptions.adapter,
      installationType: normalizedOptions.installationType,
      agent: normalizedOptions.agent,
      allDetected: normalizedOptions.allDetected,
    });
  }
  return [await resolveRuntimeTarget({
    targetRoot: normalizedOptions.targetRoot,
    adapter: normalizedOptions.adapter,
    installationType: normalizedOptions.installationType,
    agent: normalizedOptions.agent,
  })];
}

async function tryResolveProfileAllRuntimeTargets(options: { targetRoot?: string; installationType?: string }): Promise<RuntimeTarget[] | undefined> {
  try {
    return await resolveProfileRuntimeTargets({
      cwd: process.cwd(),
      targetRoot: options.targetRoot,
      installationType: options.installationType,
      profile: "all",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unknown profile: all") return undefined;
    throw error;
  }
}

function optionsForResolvedTarget<T extends { adapter?: string; multiAdapterSource?: boolean }>(options: T, target: RuntimeTarget): T {
  return adapterListFromOption(options.adapter).length > 1
    ? { ...options, adapter: target.adapter, multiAdapterSource: true }
    : options;
}

async function resolveAdapterForTarget(target: RuntimeTarget, options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean }) {
  const adapterOptions = adapterOptionsForTarget(target, options);
  return resolveAdapter({
    adapter: target.adapter,
    adapterConfig: adapterOptions.adapterConfig,
    adapterModule: adapterOptions.adapterModule,
    allowAdapterCode: adapterOptions.allowAdapterCode,
    baseDir: target.workspaceRoot,
    warn: (message) => console.warn(message),
  });
}

function adapterOptionsForTarget(
  target: RuntimeTarget,
  options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean },
) {
  return {
    adapterConfig: options.adapterConfig ?? target.adapterConfig,
    adapterModule: options.adapterModule ?? target.adapterModule,
    allowAdapterCode: options.allowAdapterCode,
  };
}

function targetKeyForTarget(target: RuntimeTarget, adapterName?: string): string {
  return target.targetKey ?? target.agentName ?? adapterName ?? target.source;
}

interface GraphCliOptions {
  dryRun?: boolean;
  executePlugins?: boolean;
  allowAdapterCode?: boolean;
  adapterConfig?: string;
  adapterModule?: string;
  adapter?: string;
  installationType?: string;
  user?: boolean;
  local?: boolean;
  targetRoot?: string;
  agent?: string;
  all?: boolean;
  allDetected?: boolean;
  profile?: string;
  driver?: string;
  mode?: "pinned" | "tracking";
  select?: string[];
  skill?: string[];
  skills?: string[];
  override?: string[];
  overrides?: string[];
  noDeps?: boolean;
  deps?: boolean;
  onlySource?: boolean;
  frozenLock?: boolean;
  offline?: boolean;
  yes?: boolean;
  trust?: string[];
  scope?: string;
  keepFiles?: boolean;
  forceDrift?: boolean;
  forceConflict?: boolean;
  replaceConflict?: boolean;
  extraPackage?: WorkspacePackage;
  multiAdapterSource?: boolean;
}

interface PackageGraphGroup {
  target: RuntimeTarget;
  installationType: string;
  adapterOptions: {
    adapterConfig?: string;
    adapterModule?: string;
    allowAdapterCode?: boolean;
  };
  packages: WorkspacePackage[];
  extraRoots: GraphRootRequest[];
  extraPackages: WorkspacePackage[];
}

async function runConfiguredGraphPackages(
  target: RuntimeTarget,
  options: GraphCliOptions,
  behavior: { mode: "install" | "update" },
): Promise<void> {
  const results = await buildGraphPlansForTarget(target, undefined, options, behavior);
  for (const result of results) {
    console.log(`${behavior.mode === "update" ? "Update" : "Install"} ${result.plan.adapter} at ${result.plan.targetRoot}:`);
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
  behavior: { mode: "install" | "update" },
) {
  const targetOptions = optionsForResolvedTarget(options, target);
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  const groups = new Map<string, PackageGraphGroup>();
  const selectedArtifacts = selectedArtifactsFromOptions(targetOptions);
  const scopedPackage = targetOptions.scope ? findConfiguredPackage(config.packages, targetOptions.scope) : undefined;
  const scopedRootId = scopedPackage?.name ?? (source ? targetOptions.scope : undefined);
  if (targetOptions.scope && !scopedPackage && !source) throw new Error(`Configured package not found: ${targetOptions.scope}`);

  if (!source || !targetOptions.onlySource) {
    for (const pkg of config.packages) {
      const group = graphGroupForPackage(groups, target, pkg, targetOptions);
      group.packages.push(pkg);
    }
  }

  if (source) {
    let entry = targetOptions.extraPackage ?? await packageEntryFromSource(source, target.workspaceRoot, targetOptions);
    if (targetOptions.multiAdapterSource) {
      entry = packageEntryWithAdapterSuffix(entry);
    }
    const sourceTarget = target;
    const sourceInstallationType = targetOptions.installationType ?? entry.installationType ?? sourceTarget.installationType ?? "local";
    const sourceAdapterOptions = adapterOptionsForTarget(sourceTarget, targetOptions);
    const key = graphGroupKey(sourceTarget, {
      installationType: sourceInstallationType,
      ...sourceAdapterOptions,
    });
    const group = groups.get(key) ?? {
      target: sourceTarget,
      installationType: sourceInstallationType,
      adapterOptions: sourceAdapterOptions,
      packages: [],
      extraRoots: [],
      extraPackages: [],
    };
    group.extraPackages.push(entry);
    groups.set(key, group);
  }

  if (groups.size === 0) {
    console.log(`No packages configured at ${target.workspaceRoot}.`);
    return [];
  }

  const results = [];
  for (const group of groups.values()) {
    const adapter = await resolveAdapterForTarget(group.target, group.adapterOptions);
    const transport = transportForTarget(group.target);
    const allPackages = [...group.packages, ...group.extraPackages];
    const groupHasScope = !scopedRootId || allPackages.some((pkg) => pkg.name === scopedRootId || pkg.source === targetOptions.scope);
    if (behavior.mode === "install" && scopedRootId && !groupHasScope) continue;
    const updateScope = behavior.mode === "update" ? (scopedPackage ? new Set([scopedPackage.name]) : undefined) : undefined;
    const roots: GraphRootRequest[] = [
      ...allPackages.map((pkg) => {
        const updateThisPackage = behavior.mode === "update"
          && pkg.mode === "tracking"
          && (!updateScope || updateScope.has(pkg.name) || updateScope.has(pkg.source));
        const packageIsScoped = scopedRootId ? pkg.name === scopedRootId || pkg.source === targetOptions.scope : true;
        return {
          rootId: pkg.name,
          source: pkg.source,
          mode: pkg.mode,
          ref: pkg.requestedRef,
          select: selectedArtifacts && packageIsScoped ? selectedArtifacts : normalizeArtifactSelectors(pkg.select, pkg.skills),
          aliases: pkg.aliases,
          overrides: pkg.overrides,
          useLock: behavior.mode === "install" ? true : !updateThisPackage,
        };
      }),
      ...group.extraRoots,
    ];
    if (behavior.mode === "update") {
      const changed = roots.filter((root) => root.useLock === false);
      if (changed.length === 0) {
        const label = targetOptions.scope ? ` ${targetOptions.scope}` : "";
        console.log(`No tracking packages to update${label}.`);
        continue;
      }
    }
    if (roots.length === 0) continue;
    const result = await createGraphSourcePlan({
      roots,
      targetRoot: group.target.targetRoot,
      workspaceRoot: group.target.workspaceRoot,
      adapter,
      transport,
      targetKey: targetKeyForTarget(group.target, adapter.name),
      targetFingerprintParts: targetFingerprintParts(group.target, adapter, group.adapterOptions, group.installationType),
      installationType: group.installationType,
      noDeps: noDepsFromOptions(targetOptions),
      lockedResolution: behavior.mode === "install",
      frozenLock: targetOptions.frozenLock,
      offline: targetOptions.offline,
      yes: targetOptions.yes,
      trustPatterns: targetOptions.trust ?? [],
      readOnly: targetOptions.dryRun === true,
      isTTY: process.stdin.isTTY === true,
      forceDrift: targetOptions.forceDrift,
      forceConflict: targetOptions.forceConflict,
      replaceConflict: targetOptions.replaceConflict,
    });
    if (behavior.mode === "install" && scopedRootId) {
      const state = installStateForTarget(group.target, adapter, group.adapterOptions, group.installationType);
      const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
      results.push(scopeInstallPlanToRoot(result, scopedRootId, manifest));
    } else {
      results.push(result);
    }
  }
  return results;
}

function scopeInstallPlanToRoot(
  result: GraphSourcePlanResult,
  rootId: string,
  manifest: InstallManifest | undefined,
): GraphSourcePlanResult {
  const scopedOwners = scopedGraphOwnerKeys(result, rootId);
  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const preservedPaths = new Set<string>();
  const plannedPaths = new Set<string>();
  const operations: InstallOperation[] = [];

  for (const operation of result.plan.operations) {
    plannedPaths.add(operation.relativeDestPath);
    if (operationBelongsToScopedRoot(operation, scopedOwners)) {
      operations.push(operation);
      continue;
    }

    const entry = manifestByPath.get(operation.relativeDestPath);
    const transformed = transformOutOfScopeOperation(operation, entry, result.plan.targetRoot, rootId);
    for (const scopedOperation of transformed) {
      if (preservedPaths.has(scopedOperation.relativeDestPath)) continue;
      preservedPaths.add(scopedOperation.relativeDestPath);
      operations.push(scopedOperation);
    }
  }

  for (const entry of manifest?.entries ?? []) {
    if (plannedPaths.has(entry.path) || preservedPaths.has(entry.path) || entryBelongsToScopedRoot(entry, scopedOwners)) continue;
    preservedPaths.add(entry.path);
    operations.push(keepManifestEntryOperation(entry, result.plan.targetRoot, rootId));
  }

  return {
    ...result,
    plan: {
      ...result.plan,
      operations,
      hasBlockingChanges: operations.some((operation) => operation.action === "drift" || operation.action === "conflict"),
    },
  };
}

function transformOutOfScopeOperation(
  operation: InstallOperation,
  entry: NonNullable<InstallManifest>["entries"][number] | undefined,
  targetRoot: string,
  rootId: string,
): InstallOperation[] {
  if (operation.action === "skip") return [operation];
  if (operation.action === "update" || operation.action === "drift") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, rootId, operation, { freshMetadata: true })] : [];
  }
  if (operation.action === "remove") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, rootId)] : [];
  }
  if (operation.action === "plugin" || operation.action === "program") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, rootId)] : [];
  }
  // Out-of-scope create/conflict operations have no managed entry to preserve.
  return [];
}

function scopedGraphOwnerKeys(result: GraphSourcePlanResult, rootId: string): Set<string> {
  const root = result.graph.roots.find((candidate) => candidate.rootId === rootId);
  if (!root) throw new Error(`Resolved graph root not found for scoped install: ${rootId}`);
  const keys = new Set<string>([`workspace:${rootId}`]);
  const queue = [root.graphNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (keys.has(nodeId)) continue;
    keys.add(nodeId);
    for (const edge of result.graph.edges) {
      if (edge.from === nodeId) queue.push(edge.to);
    }
  }
  return keys;
}

function operationBelongsToScopedRoot(operation: InstallOperation, scopedOwners: Set<string>): boolean {
  if (operation.graphNodeId && scopedOwners.has(operation.graphNodeId)) return true;
  return operation.owners?.some((owner) => scopedOwners.has(owner)) === true;
}

function entryBelongsToScopedRoot(entry: NonNullable<InstallManifest>["entries"][number], scopedOwners: Set<string>): boolean {
  if ("graphNodeId" in entry && entry.graphNodeId && scopedOwners.has(entry.graphNodeId)) return true;
  const owners = "owners" in entry ? entry.owners : [entry.packageName ?? "legacy"];
  return owners.some((owner) => scopedOwners.has(owner));
}

function keepManifestEntryOperation(
  entry: NonNullable<InstallManifest>["entries"][number],
  targetRoot: string,
  rootId: string,
  operation?: InstallOperation,
  options: { freshMetadata?: boolean } = {},
): InstallOperation {
  const owners = "owners" in entry ? entry.owners : [entry.packageName ?? "legacy"];
  const fresh = options.freshMetadata ? operation : undefined;
  return {
    action: "keep",
    artifactType: entry.artifactType,
    artifactName: entry.artifactName,
    kind: entry.kind,
    destPath: operation?.destPath ?? join(targetRoot, entry.path),
    relativeDestPath: entry.path,
    desiredHash: entry.sourceHash,
    currentHash: operation?.currentHash ?? entry.hash,
    manifestHash: entry.hash,
    reason: `preserved outside scoped install ${rootId}`,
    channel: entry.channel,
    packageName: entry.packageName,
    semanticCommand: entry.semanticCommand,
    semanticPlugin: entry.semanticPlugin,
    execute: entry.executed,
    mergeStrategy: entry.mergeStrategy,
    composedFrom: entry.composedFrom,
    installName: fresh?.installName ?? ("installName" in entry ? entry.installName : entry.artifactName),
    logicalSelector: fresh?.logicalSelector ?? ("logicalSelector" in entry ? entry.logicalSelector : `${entry.artifactType}/${entry.artifactName}`),
    graphNodeId: fresh?.graphNodeId ?? ("graphNodeId" in entry ? entry.graphNodeId : undefined),
    dependencyRole: fresh?.dependencyRole ?? ("dependencyRole" in entry ? entry.dependencyRole : "root"),
    owners: fresh?.owners ?? owners,
    workspaceOwner: fresh?.workspaceOwner ?? ("workspaceOwner" in entry ? entry.workspaceOwner : "legacy:unowned"),
    graphLockDigest: fresh ? undefined : "graphLockDigest" in entry ? entry.graphLockDigest : undefined,
  };
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
      adapterConfig: options.adapterConfig ?? removedTarget.adapterConfig ?? pkg.adapterConfig,
      adapterModule: options.adapterModule ?? removedTarget.adapterModule ?? pkg.adapterModule,
      allowAdapterCode: options.allowAdapterCode,
    };
    const removedInstallationType = options.installationType ?? pkg.installationType ?? removedTarget.installationType ?? "local";
    const adapter = await resolveAdapterForTarget(removedTarget, removedAdapterOptions);
    const transport = transportForTarget(removedTarget);
    const removedState = installStateForTarget(removedTarget, adapter, removedAdapterOptions, removedInstallationType);
    const manifest = await readInstallManifest(removedState.installRoot, adapter.name, transport, removedState);
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
          overrides: pkg.overrides,
        })),
        targetRoot: remainingGroup.target.targetRoot,
        workspaceRoot: remainingGroup.target.workspaceRoot,
        adapter: remainingAdapter,
        transport,
        targetKey: targetKeyForTarget(remainingGroup.target, remainingAdapter.name),
        targetFingerprintParts: targetFingerprintParts(remainingGroup.target, remainingAdapter, remainingGroup.adapterOptions, remainingGroup.installationType),
        installationType: remainingGroup.installationType,
        lockedResolution: true,
        frozenLock: options.frozenLock,
        offline: options.offline,
        yes: options.yes,
        trustPatterns: options.trust ?? [],
        readOnly: options.dryRun === true,
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
            targetKeyForTarget(removedTarget, adapter.name),
            adapter.name,
            targetFingerprintParts(removedTarget, adapter, removedAdapterOptions, removedInstallationType),
          ),
        };
    const result = await uninstall(plan, {
      dryRun: options.dryRun,
      force: options.force,
      keepFiles: options.keepFiles,
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
  const installationType = options.installationType ?? pkg.installationType ?? packageTarget.installationType ?? "local";
  const adapterOptions = {
    adapterConfig: options.adapterConfig ?? packageTarget.adapterConfig ?? pkg.adapterConfig,
    adapterModule: options.adapterModule ?? packageTarget.adapterModule ?? pkg.adapterModule,
    allowAdapterCode: options.allowAdapterCode,
  };
  const key = graphGroupKey(packageTarget, { ...adapterOptions, installationType });
  const existing = groups.get(key);
  if (existing) return existing;
  const created = {
    target: packageTarget,
    installationType,
    adapterOptions,
    packages: [],
    extraRoots: [],
    extraPackages: [],
  };
  groups.set(key, created);
  return created;
}

function targetForPackage(target: RuntimeTarget, pkg: WorkspacePackage, options: GraphCliOptions): RuntimeTarget {
  const installationType = options.installationType ?? pkg.installationType ?? target.installationType;
  return options.adapter || target.source !== "cwd"
    ? { ...target, installationType }
    : { ...target, adapter: pkg.adapter, installationType };
}

function graphGroupKey(target: RuntimeTarget, options: { installationType?: string; adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean }): string {
  return JSON.stringify({
    adapter: target.adapter,
    installationType: options.installationType ?? target.installationType ?? "local",
    targetRoot: target.targetRoot,
    transport: target.transport,
    agentName: target.agentName,
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
  });
}

function targetFingerprintParts(target: RuntimeTarget, adapter: AdapterConfig, options: { adapterConfig?: string; adapterModule?: string }, installationType?: string): unknown {
  return {
    adapter: adapter.name,
    installationType: installationType ?? target.installationType ?? "local",
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
    adapterCodeHash: adapter.programmatic?.hash,
    agentName: target.agentName,
    targetRoot: target.targetRoot,
    transport: target.transport,
    ssh: target.ssh,
  };
}

function installStateForTarget(
  target: RuntimeTarget,
  adapter: AdapterConfig,
  options: { adapterConfig?: string; adapterModule?: string },
  installationType: string,
): { installationType: string; stateKey: string; installRoot: string } {
  const targetFingerprint = targetFingerprintDigest(target, adapter, options, installationType);
  return {
    installationType,
    stateKey: stateKeyFor(adapter.name, { installationType, targetFingerprint }),
    installRoot: installRootForAdapterInstallationType(adapter, target.targetRoot, installationType, target.transport === "ssh"),
  };
}

function targetFingerprintDigest(target: RuntimeTarget, adapter: AdapterConfig, options: { adapterConfig?: string; adapterModule?: string }, installationType: string): string {
  const fingerprintInput = targetFingerprintParts(target, adapter, options, installationType);
  return computeTargetFingerprint(fingerprintInput);
}

async function readTargetGraphLock(
  target: RuntimeTarget,
  options: { installationType?: string; adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean },
) {
  const adapterOptions = adapterOptionsForTarget(target, options);
  const adapter = await resolveAdapterForTarget(target, adapterOptions);
  const installationType = options.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter, undefined);
  const path = graphLockPathForTarget(
    target.workspaceRoot,
    targetKeyForTarget(target, adapter.name),
    adapter.name,
    targetFingerprintParts(target, adapter, adapterOptions, installationType),
  );
  if (!(await pathExists(path))) {
    throw new Error(`No graph lock for ${adapter.name} at ${target.targetRoot}: ${path}`);
  }
  return { adapter, path, lock: await readGraphLock(path) };
}

async function printStatus(
  target: RuntimeTarget,
  options: GraphCliOptions,
): Promise<void> {
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  const adapterOptions = adapterOptionsForTarget(target, options);
  const adapter = await resolveAdapterForTarget(target, adapterOptions);
  const transport = transportForTarget(target);
  const installationType = options.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
  const state = installStateForTarget(target, adapter, adapterOptions, installationType);
  console.log(`Status for ${adapter.name}/${installationType} at ${state.installRoot}`);
  if (config.packages.length === 0) {
    console.log(`Configured packages: none at ${target.workspaceRoot}`);
    return;
  }
  console.log("Configured packages:");
  for (const pkg of config.packages) {
    console.log(`- ${pkg.name} (${pkg.mode}) ${pkg.source}`);
  }
  const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
  console.log(manifest ? `Install manifest: ${manifest.entries.length} entries, revision ${manifest.revision}` : "Install manifest: missing");
  try {
    const { path, lock } = await readTargetGraphLock(target, adapterOptions);
    console.log(`Graph lock: ${path}`);
    console.log(`Locked graph: ${lock.canonical.roots.length} roots, ${lock.canonical.nodes.length} nodes, ${lock.canonical.artifacts.length} artifacts`);
  } catch {
    console.log("Graph lock: missing");
  }
  await printPendingInstallWork(target, options);
}

async function printPendingInstallWork(target: RuntimeTarget, options: GraphCliOptions): Promise<void> {
  let results: GraphSourcePlanResult[] = [];
  try {
    results = await buildGraphPlansForTarget(target, undefined, { ...options, dryRun: true }, { mode: "install" });
    const operations = results.flatMap((result) => result.plan.operations);
    const pending = operations.filter(isPendingInstallOperation);
    if (pending.length === 0) {
      console.log("Pending install work: none");
      return;
    }
    const counts = [...pending.reduce((map, operation) => {
      map.set(operation.action, (map.get(operation.action) ?? 0) + 1);
      return map;
    }, new Map<string, number>())].map(([action, count]) => `${action}=${count}`).join(", ");
    const blocking = pending.filter((operation) => operation.action === "conflict" || operation.action === "drift").length;
    console.log(`Pending install work: ${pending.length} operations (${counts}${blocking ? `; blocking=${blocking}` : ""})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Pending install work: unavailable (${message})`);
  } finally {
    await Promise.all(results.map((result) => rm(result.bundle.root, { recursive: true, force: true })));
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

function collectOverrideOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

interface RuntimeScopeOptions {
  installationType?: string;
  targetRoot?: string;
  user?: boolean;
  local?: boolean;
  agent?: string;
  all?: boolean;
  allDetected?: boolean;
  profile?: string;
}

function normalizeRuntimeScopeOptions<T extends RuntimeScopeOptions>(options: T, behavior: { defaultUser?: boolean } = {}): T {
  if (options.user && options.local) {
    throw new Error("Choose either --user or --local.");
  }

  const shortcutType = options.user ? "user" : options.local ? "local" : undefined;
  if (shortcutType && options.installationType && options.installationType !== shortcutType) {
    throw new Error(`--${shortcutType} conflicts with --installation-type ${options.installationType}.`);
  }

  let targetRoot = options.targetRoot ? normalizeCliPath(options.targetRoot) : undefined;
  let installationType = options.installationType ?? shortcutType;

  if (!installationType && targetRoot) {
    installationType = isHomePath(targetRoot) ? "user" : "local";
  }

  const canDefaultTargetRoot = !options.agent && !options.all && !options.allDetected && !options.profile;
  if (!targetRoot && canDefaultTargetRoot && (options.user || installationType === "user" || behavior.defaultUser)) {
    targetRoot = homedir();
  }

  if (!installationType && behavior.defaultUser) {
    installationType = "user";
  }

  return {
    ...options,
    installationType,
    targetRoot,
  };
}

function shouldDefaultUserInstall(nameOrSource: string | undefined, options: RuntimeScopeOptions & { adapter?: string }): boolean {
  return Boolean(
    nameOrSource
      && options.adapter
      && !options.installationType
      && !options.user
      && !options.local
      && !options.targetRoot
      && !options.agent
      && !options.all
      && !options.allDetected
      && !options.profile
      && looksLikeSourceSpecifier(nameOrSource),
  );
}

function looksLikeSourceSpecifier(value: string): boolean {
  return value.includes(":")
    || value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value === "~"
    || value.startsWith("~/");
}

function normalizeCliPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function isHomePath(path: string): boolean {
  return resolve(path) === resolve(homedir());
}

function adapterListFromOption(adapter?: string): string[] {
  if (!adapter) return [];
  const adapters = splitSelectorList(adapter);
  const unique = [...new Set(adapters)];
  if (unique.length !== adapters.length) {
    throw new Error(`Duplicate adapter in --adapter: ${adapter}`);
  }
  return unique;
}

function selectedArtifactsFromOptions(options: { select?: string[]; skill?: string[]; skills?: string[] }): string[] | undefined {
  return normalizeArtifactSelectors(options.select, options.skills ?? options.skill);
}

function overrideArtifactsFromOptions(options: { override?: string[]; overrides?: string[] }): string[] | undefined {
  const values = options.overrides ?? options.override;
  return values && values.length > 0 ? values : undefined;
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
    installationType: "local",
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
        root: "/workspace/agent-runtime",
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
    currentVersion: CLI_VERSION,
    argv: process.argv,
    env: process.env,
    isTTY: process.stderr.isTTY === true,
  });
  await program.parseAsync();
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
