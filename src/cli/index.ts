import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
  targetMappingForArtifact,
  type AdapterConfig,
} from "../model/adapter.js";
import { abortApplyJournal, applyCombinedInstallPlan, createOwnershipUninstallPlan, createUninstallPlan, normalizeTargetRoot, readApplyJournal, readInstallManifest, uninstall } from "../install/index.js";
import { stateKeyFor } from "../install/paths.js";
import { formatDependencyTree, formatDepsWhy, formatGraphPlan, formatLockDependencyTree, formatPlan, graphPlanReport, installPlanReportTarget, planReport, type PlanReport, type PlanReportTarget } from "./format.js";
import { renderReport, type ReportFormat } from "./render.js";
import { parseServeIntervalSeconds, parseServePort, servePlanDashboard } from "./serve.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource, stageSourceRaw } from "../staging/staging.js";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, isCompositeWorkspaceProfile, readMergedWorkspaceConfig, readWorkspaceConfig, upsertPackage, workspaceConfigPath, workspaceConfigSchema, writeWorkspaceConfig } from "../model/workspace.js";
import type { WorkspacePackage, WorkspaceProfile } from "../model/workspace.js";
import { ejectArtifact, remember } from "../lifecycle/customization.js";
import { syncProfile } from "../lifecycle/profile.js";
import { forgetTrustedSources } from "../lifecycle/trust.js";
import { createGraphSourcePlan, desiredArtifactsFromGraphBundle, graphLockPathForTarget, type GraphSourcePlanResult } from "../lifecycle/source-plan.js";
import { RegistryClient, resolvePackageSource, selectorsFromRegistryEntry } from "../registry/client.js";
import { createRegistryPublishDraft } from "../registry/publish.js";
import { formatReloadCommands, reloadRuntimeAfterPluginChanges } from "../runtime/reload.js";
import { resolveAllDetectedRuntimeTargets, resolveAllRuntimeTargets, resolveProfileRuntimeTargets, resolveRuntimeTarget, type RuntimeTarget } from "../runtime/target.js";
import { isPendingInstallOperation, type InstallOperation, type InstallPlan } from "../install/plan.js";
import type { InstallManifest } from "../model/manifest.js";
import { dependencyUpdateSelectorMatchesRoot, type GraphRootRequest } from "../resolve/graph.js";
import { filterArtifactsBySelection, normalizeArtifactSelectors, splitSelectorList } from "../model/selection.js";
import { maybeCheckForUpdate } from "./update-check.js";
import { pathExists } from "../utils/fs.js";
import { transportForTarget } from "../transport/index.js";
import { validatePackage } from "../model/package-validate.js";
import { migratePackageManifest } from "../model/package-migrate.js";
import { CURRENT_OPENPACK_SCHEMA_VERSION, findPackageManifestPath } from "../model/package.js";
import { canonicalGraphLockJson, canonicalizeGraphLock, computeTargetFingerprint, readGraphLock, type GraphLock } from "../model/graph-lock.js";
import { diffGraphLocks } from "../resolve/graph-diff.js";
import { resolveCliVersion } from "./version.js";
import { applyArtifactOwnershipHandoff, planArtifactOwnershipHandoff, workspaceOwnerForRoot } from "../lifecycle/ownership.js";
import { discoverPackageVersions, effectiveTrackingRef, type VersionAvailability } from "../version/policy.js";
import { compareSemverStrings, satisfiesVersionRange } from "../resolve/semver.js";
import { assertNoCompositeCycle, collectCompositeMembers, compositeKey, parseCompositeChain, runMemberAgentwheel } from "../profile/members.js";
import { blocksCompositeApply, worstStatusHealth, type StatusHealth, type StatusPackage, type StatusReport, type StatusTarget } from "../status/report.js";
import { collectRepositoryStatus } from "../status/repository.js";
import { CatalogueClient } from "../catalogue/client.js";
import { buildSearchEntries, searchEntries } from "../search/index.js";
import { SemanticSearchClient } from "../semantic/index.js";
import { createSkillTrial } from "../trial/skill.js";
import {
  searchEcosystemSchema,
  searchScopeSchema,
  searchTypeSchema,
  type SearchEcosystem,
  type SearchResponse,
  type SearchResult,
  type SearchScope,
  type SearchType,
} from "../model/catalogue.js";
import { pruneGitCache, releaseGitSnapshotLease } from "../source/cache.js";
import { listRegisteredFleets, registerFleet, resolveWorkspaceScope, showRegisteredFleet } from "../model/fleet.js";
import { applyFleetNormalization, planFleetNormalization, recoverFleetNormalization, type FleetNormalizationSource } from "../lifecycle/fleet-normalize.js";

const CLI_VERSION = resolveCliVersion();
const COMPANION_SKILL_SOURCE = "github:NestDevLab/agentwheel";
const COMPANION_SKILL_NAME = "agentwheel";
const planOutputFormats = ["human", "json", "mermaid", "html"] as const;
type PlanOutputFormat = "human" | ReportFormat;

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
    const config = await pathExists(workspaceConfigPath(root))
      ? await readWorkspaceConfig(root)
      : workspaceConfigSchema.parse({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION });
    const bootstrapPackage = config.bootstrapSkills === false ? undefined : await defaultBootstrapPackage(root);
    const withBootstrap = bootstrapPackage ? upsertPackage(config, bootstrapPackage) : config;
    await writeWorkspaceConfig(root, options.fleetExample ? withFleetExample(withBootstrap) : withBootstrap);
    console.log(`Initialized ${workspaceConfigPath(root)}.`);
    if (bootstrapPackage) console.log("Auto-added the agentwheel bootstrap skill for openclaw.");
    console.log(nextInstallNudge());
  });

const cacheCommand = program
  .command("cache")
  .description("inspect and maintain local source caches");

const fleetCommand = program
  .command("fleet")
  .description("register, inspect, and normalize isolated named fleets");

fleetCommand
  .command("register")
  .description("register an existing schema-v3 fleet in the user config")
  .argument("<id>", "fleet id")
  .requiredOption("--root <path>", "absolute canonical fleet root")
  .requiredOption("--required-package <name>", "required package (repeatable)", collectValueOption, [] as string[])
  .action(async (id, options) => {
    const registered = await registerFleet({ id, root: options.root, requiredPackages: options.requiredPackage });
    console.log(`Registered fleet '${registered.id}' at ${registered.root}.`);
  });

fleetCommand
  .command("list")
  .description("list registered fleets")
  .option("--json", "print registrations as JSON", false)
  .action(async (options) => {
    const fleets = await listRegisteredFleets();
    if (options.json) return console.log(JSON.stringify(fleets, null, 2));
    if (fleets.length === 0) return console.log("No named fleets registered.");
    for (const fleet of fleets) console.log(`${fleet.id}\t${fleet.root}\t${fleet.requiredPackages.join(",")}`);
  });

fleetCommand
  .command("show")
  .description("show one registered fleet")
  .argument("<id>", "fleet id")
  .option("--json", "print registration as JSON", false)
  .action(async (id, options) => {
    const fleet = await showRegisteredFleet(id);
    console.log(options.json ? JSON.stringify(fleet, null, 2) : `${fleet.id}\nRoot: ${fleet.root}\nRequired packages: ${fleet.requiredPackages.join(", ")}`);
  });

fleetCommand
  .command("normalize")
  .description("plan or apply duplicate desired-state ownership normalization")
  .argument("<destinationFleet>", "destination fleet id")
  .requiredOption("--from <scope>", "user or fleet:<sourceFleet>")
  .option("--package <name>", "limit to one duplicate package (repeatable)", collectValueOption, [] as string[])
  .option("--apply", "apply a reviewed plan", false)
  .option("--recover", "restore source state from a pending normalization journal", false)
  .option("--plan-digest <sha256>", "exact digest from the reviewed dry-run")
  .option("--json", "print the plan or result as JSON", false)
  .action(async (destinationFleet, options) => {
    const request = {
      destinationFleet,
      from: options.from as FleetNormalizationSource,
      ...(options.package.length > 0 ? { packages: options.package } : {}),
    };
    if (options.recover && (options.apply || options.planDigest || options.package.length > 0)) {
      throw new Error("--recover cannot be combined with --apply, --plan-digest, or --package.");
    }
    const result = options.recover
      ? await recoverFleetNormalization(request)
      : options.apply
        ? await applyFleetNormalization({ ...request, apply: true, planDigest: options.planDigest })
        : await planFleetNormalization(request);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatFleetNormalization(result));
  });

cacheCommand
  .command("prune")
  .description("remove old Git source snapshots while preserving locked commits")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .option("--keep <count>", "newest snapshots to retain per source", parsePositiveInteger, 3)
  .option("--apply", "delete the selected snapshots; without this flag only preview", false)
  .action(async (options) => {
    const targetRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
    const cacheRoot = join(targetRoot, ".agentwheel", "cache");
    const result = await pruneGitCache(cacheRoot, { keepSnapshots: options.keep, dryRun: !options.apply });
    const verb = options.apply ? "Removed" : "Would remove";
    for (const path of result.removedPaths) console.log(`${verb} ${path}`);
    console.log(`${options.apply ? "Pruned" : "Preview"}: ${result.removedPaths.length} snapshots; retained ${result.retainedPaths.length}.`);
  });

program
  .command("add")
  .description("add a package to .agentwheel/config.json without touching runtimes")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver (local, git, skillkit, vercel-skills, mcp-registry, or clawhub)")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "workspace root")
  .option("--mode <mode>", "pinned or tracking", "pinned")
  .option("--version <range>", "root package version policy (exact, ~, ^, or *)")
  .option("--name <name>", "package alias")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--with-suggestions", "include suggested companion artifacts for selected roots on future installs", false)
  .option("--suggestion <alias>", "include one suggested companion alias on future installs (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--override <source-or-package::type/name>", "allow this package to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .action(async (source, options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targetRoot = await workspaceRootFromOptions(normalizedOptions);
    const entry = await packageEntryFromSource(source, targetRoot, normalizedOptions);
    await writeWorkspaceConfig(targetRoot, upsertPackage(await readWorkspaceConfig(targetRoot), entry));
    console.log(`Added ${entry.name}. Preview: agentwheel plan - Apply: agentwheel install`);
  });

program
  .command("list")
  .description("list artifacts exposed by a package source")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .action(async (source, options) => {
    const targetRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const selectedArtifacts = selectedArtifactsFromOptionsOrRegistry(options, resolvedInput.registryEntry);
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedInput.source));
    const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(resolvedInput.source, { cacheRoot: join(targetRoot, ".agentwheel", "cache") }))));
    try {
      const artifacts = filterArtifactsBySelection(await driver.list(resolved), selectedArtifacts);
      for (const artifact of artifacts) {
        console.log(`${artifact.type}\t${artifact.name}\t${artifact.relativePath}`);
      }
    } finally {
      await releaseGitSnapshotLease(resolved.cacheLeasePath);
    }
  });

program
  .command("search")
  .description("search registry and public catalogue artifacts")
  .argument("<query>", "search query")
  .option("--json", "print the versioned search response as JSON", false)
  .option("--scope <scope>", "search scope: all, registry, enriched, or vercel", "all")
  .option("--type <type>", "artifact type: package, skill, plugin, mcp, or adapter")
  .option("--ecosystem <ecosystem>", "ecosystem: official, openpack, mcp-registry, clawhub, skillkit, or vercel")
  .option("--limit <n>", "maximum number of results (1-100)", "20")
  .option("--include-archived", "include archived catalogue entries", false)
  .option("--refresh", "refresh registry and catalogue caches", false)
  .option("--offline", "use compatible local caches without network access", false)
  .option("--semantic", "rank published catalogue entries with the verified semantic index", false)
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .action(async (query: string, options: SearchCliOptions) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error("Search query must not be empty.");
    }
    const scope = parseSearchScope(options.scope);
    const type = options.type === undefined ? undefined : parseSearchType(options.type);
    const ecosystem = options.ecosystem === undefined ? undefined : parseSearchEcosystem(options.ecosystem);
    const limit = parseSearchLimit(options.limit);
    if (options.refresh && options.offline) {
      throw new Error("--refresh cannot be used with --offline.");
    }
    if (options.semantic && scope === "registry") {
      throw new Error("--semantic requires a catalogue scope: all, enriched, or vercel.");
    }

    const warning = (message: string) => console.error(message);
    const targetRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
    const registryRequest = scope === "all" || scope === "registry"
      ? new RegistryClient({ workspaceRoot: targetRoot, offline: options.offline, warn: warning }).getIndex({ refresh: options.refresh })
      : undefined;
    const catalogueRequest = scope === "all" || scope === "enriched" || scope === "vercel"
      ? new CatalogueClient({ offline: options.offline, warn: warning }).getIndex({ refresh: options.refresh || (options.semantic && !options.offline) })
      : undefined;
    const [registryIndex, catalogueIndex] = await Promise.all([registryRequest, catalogueRequest]);

    const entries = buildSearchEntries({
      registry: registryIndex?.entries,
      enriched: scope === "all" || scope === "enriched" ? catalogueIndex?.enriched : undefined,
      vercel: scope === "all" || scope === "vercel" ? catalogueIndex?.vercel : undefined,
    });
    const results = options.semantic
      ? await new SemanticSearchClient({ warn: warning }).search({
        query: trimmedQuery,
        entries,
        catalogueDigests: catalogueIndex?.sourceDigests,
        type,
        ecosystem,
        limit,
        includeArchived: options.includeArchived,
      })
      : searchEntries(entries, trimmedQuery, {
        type,
        ecosystem,
        limit,
        includeArchived: options.includeArchived,
      });
    const loadedIndexes = [registryIndex, catalogueIndex].filter((index) => index !== undefined);
    const response = {
      schemaVersion: 1,
      query: trimmedQuery,
      scope,
      fromCache: loadedIndexes.every((index) => index.fromCache),
      results,
      ...(options.semantic ? { searchMode: "semantic" as const } : {}),
    } satisfies SearchResponse;

    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }
    printSearchResults(trimmedQuery, results);
  });

program
  .command("try")
  .description("read and validate one skill for the current task without installing it")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("--json", "print the read-only skill trial as JSON", false)
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .option("--select <type/name>", "select exactly one skill artifact", collectSelectOption, [] as string[])
  .option("--skill <name>", "select exactly one skill by name", collectSkillOption, [] as string[])
  .action(async (source: string, options: SkillTrialCliOptions) => {
    const targetRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedInput.source));
    const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(resolvedInput.source, {
      cacheRoot: join(targetRoot, ".agentwheel", "cache"),
    }))));
    try {
      const trial = await createSkillTrial(driver, resolved, selectedArtifactsFromOptionsOrRegistry(options, resolvedInput.registryEntry));
      if (options.json) {
        console.log(JSON.stringify(trial, null, 2));
        return;
      }
      console.log(`Read-only skill trial: ${trial.skill.name}`);
      console.log(`Source: ${trial.source}`);
      console.log(`Description: ${trial.skill.frontmatter.description}`);
      console.log("No configuration or runtime files were changed.");
      console.log("\n--- SKILL.md ---\n");
      console.log(trial.skill.content);
    } finally {
      await releaseGitSnapshotLease(resolved.cacheLeasePath);
    }
  });

program
  .command("scan")
  .description("scan a package source for validation findings")
  .argument("<source>", "package source")
  .option("--driver <driver>", "source driver")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .action(async (source, options) => {
    const targetRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(resolvedInput.source));
    const resolved = await driver.export(await driver.translate(await driver.fetch(await driver.resolve(resolvedInput.source, { cacheRoot: join(targetRoot, ".agentwheel", "cache") }))));
    try {
      const result = await driver.scan(resolved);
      if (result.findings.length === 0) {
        console.log("Scan ok: no findings");
      } else {
        for (const finding of result.findings) {
          console.log(`${finding.level.toUpperCase()}: ${finding.message}${finding.path ? ` (${finding.path})` : ""}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    } finally {
      await releaseGitSnapshotLease(resolved.cacheLeasePath);
    }
  });

program
  .command("plan")
  .description("preview what install would reconcile without writing")
  .argument("[name-or-source]", "configured package name/source or package source to preview")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--all-detected", "run for every runtime directory detected in the target root", false)
  .option("--profile <name>", "workspace runtime profile")
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
  .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--override <source-or-package::type/name>", "for source previews, allow the source to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--dry-run", "accepted for symmetry; plan never writes", false)
  .option("--format <fmt>", "output format: human|json|mermaid|html", "human")
  .option("--json", "print the resolved plan as JSON", false)
  .option("--force-drift", "replace drifted managed artifacts during install planning", false)
  .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "exclude unrelated configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
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
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
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
  .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
  .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--override <source-or-package::type/name>", "when adding a source, allow it to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plan without writing", false)
  .option("--format <fmt>", "output format: human|json|mermaid|html", "human")
  .option("--json", "print the resolved plan as JSON", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--reload-runtimes", "run configured runtime reload commands after executed semantic plugin changes", false)
  .option("--restart-runtimes", "alias for --reload-runtimes", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "exclude unrelated configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .addHelpText("after", "\nScoped install never removes files owned only by other configured packages; run a full install to reconcile those removals.\n")
  .action(async (source, options) => {
    await runInstallCommand(source, options, { apply: !options.dryRun });
  });

program
  .command("serve")
  .description("serve a read-only live dashboard for the resolved install plan")
  .argument("[name-or-source]", "configured package name/source or package source to preview")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--all-detected", "run for every runtime directory detected in the target root", false)
  .option("--profile <name>", "workspace runtime profile")
  .option("--mode <mode>", "pinned or tracking")
  .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
  .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--override <source-or-package::type/name>", "for source previews, allow the source to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--force-drift", "replace drifted managed artifacts during install planning", false)
  .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "exclude unrelated configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .option("--bind <addr>", "interface to bind", "127.0.0.1")
  .option("--port <n>", "TCP port (0 selects an ephemeral port)", "8765")
  .option("--interval <seconds>", "background re-render cadence in seconds", "60")
  .option("--once", "render once and skip the background re-render loop", false)
  .action(async (source, options) => {
    await servePlanDashboard({
      bind: options.bind,
      port: parseServePort(options.port),
      intervalSeconds: parseServeIntervalSeconds(options.interval),
      once: options.once === true,
      buildReport: () => buildPlanReport(source, options),
    });
  });

program
  .command("sync", { hidden: true })
  .argument("[name-or-source]", "configured package name/source or package source")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
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
  .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
  .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--override <source-or-package::type/name>", "when adding a source, allow it to replace a colliding artifact (repeatable)", collectOverrideOption, [] as string[])
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plan without writing", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--reload-runtimes", "run configured runtime reload commands after executed semantic plugin changes", false)
  .option("--restart-runtimes", "alias for --reload-runtimes", false)
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "exclude unrelated configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
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
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "workspace root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--profile <name>", "workspace runtime profile")
  .option("--dry-run", "show plans without writing", false)
  .option("--force-drift", "replace drifted managed artifacts", false)
  .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
  .option("--force-conflict", "adopt unmanaged destinations when their content already matches the desired artifact", false)
  .option("--replace-conflict", "replace unmanaged destinations even when their content differs", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .option("--reload-runtimes", "run configured runtime reload commands after executed semantic plugin changes", false)
  .option("--restart-runtimes", "alias for --reload-runtimes", false)
  .option("--allow-adapter-code", "allow loading local adapter code from configured packages", false)
  .option("--select <type/name>", "temporarily select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
  .option("--skill <name>", "temporarily select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--dependency <name-or-source>", "update one tracking dependency while keeping unrelated graph nodes locked (repeatable)", collectDependencyOption, [] as string[])
  .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
  .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
  .option("--no-deps", "resolve only root sources and ignore requires with a warning")
  .option("--only-source", "exclude unrelated configured workspace packages", false)
  .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
  .option("--offline", "resolve strictly from graph locks and local caches", false)
  .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
  .option("--yes", "trust all new transitive sources", false)
  .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
  .action(async (name, options) => {
    if (options.onlySource && options.dependency.length > 0) throw new Error("--only-source cannot be combined with --dependency.");
    if (options.onlySource && !name) throw new Error("--only-source requires a configured package argument.");
    if (name && options.dependency.length > 0) throw new Error("A package argument cannot be combined with --dependency.");
    if (options.dependency.length > 0 && (options.select.length > 0 || options.skill.length > 0)) {
      throw new Error("--dependency cannot be combined with --select or --skill; package selections remain unchanged.");
    }
    if (options.dependency.length > 0 && (options.frozenLock || options.offline)) {
      throw new Error("--dependency cannot be combined with --frozen-lock or --offline.");
    }
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const composite = await resolveSelectedCompositeProfile(normalizedOptions);
    if (composite) {
      await runCompositeUpdate(composite.workspaceRoot, composite.name, composite.profile, name, normalizedOptions);
      return;
    }
    const targets = await resolveCliTargets(normalizedOptions, { preferAllProfile: true });
    for (const target of targets) {
      await runConfiguredGraphPackages(target, { ...normalizedOptions, scope: name }, { mode: "update" });
    }
  });

program
  .command("skill")
  .description("operate on configured skills")
  .addCommand(
    new Command("update")
      .description("reconcile one skill through its configured owning package")
      .argument("<name>", "configured skill name")
      .option("--package <name>", "owning configured package when automatic ownership is ambiguous")
      .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
      .option("-i, --installation-type <type>", "installation type (for example local or user)")
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
      .option("-t, --target-root <path>", "workspace root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .option("--profile <name>", "workspace runtime profile")
      .option("--dry-run", "show plans without writing", false)
      .option("--adopt", "replace unmanaged destinations in the owning package closure", false)
      .option("--force-drift", "replace drifted managed artifacts", false)
      .option("--force-foreign-state", "plan even when another workspace owns install state at the same paths", false)
      .option("--allow-adapter-code", "allow loading local adapter code from the owning package", false)
      .option("--no-deps", "resolve only the owning package and ignore its requires with a warning")
      .option("--frozen-lock", "resolve strictly from the existing graph lock and cached sources", false)
      .option("--offline", "resolve strictly from graph locks and local caches", false)
      .option("--refresh", "refresh available package versions even when the version-index TTL is fresh", false)
      .option("--yes", "trust all new transitive sources", false)
      .option("--trust <pattern>", "pre-approve a transitive source glob (repeatable)", collectTrustOption, [] as string[])
      .action(async (name, options) => {
        await runSkillUpdateCommand(name, options);
      }),
  );

program
  .command("deps")
  .description("inspect the OpenPack dependency graph")
  .addCommand(
    new Command("tree")
      .description("print the OpenPack dependency graph")
      .argument("[source]", "optional package source to resolve")
      .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
      .option("-i, --installation-type <type>", "installation type (for example local or user)")
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
      .option("--adapter-config <path>", "adapter JSON/JSONC file")
      .option("--adapter-module <path>", "local programmatic adapter module")
      .option("--allow-adapter-code", "allow loading local adapter code", false)
      .option("-t, --target-root <path>", "runtime/project root")
      .option("--agent <name>", "named agent from merged config")
      .option("--all", "run for every configured agent", false)
      .option("--mode <mode>", "pinned or tracking")
      .option("--select <type/name>", "select an artifact by type/name (repeatable or comma-separated)", collectSelectOption, [] as string[])
      .option("--skill <name>", "select a skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
      .option("--with-suggestions", "include suggested companion artifacts for selected roots", false)
      .option("--suggestion <alias>", "include one suggested companion alias (repeatable or comma-separated)", collectSuggestionOption, [] as string[])
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
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
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
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
      .option("-t, --target-root <path>", "explicit workspace root")
      .action(async (options) => {
        const workspaceRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
        const client = new RegistryClient({ workspaceRoot, warn: (message) => console.warn(message) });
        const index = await client.getIndex({ refresh: true });
        console.log(`Registry refreshed: ${index.entries.length} entries from ${index.sources.join(", ")}`);
      }),
  )
  .addCommand(
    new Command("list")
      .description("list available registry entries")
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
      .option("-t, --target-root <path>", "explicit workspace root")
      .action(async (options) => {
        const workspaceRoot = await workspaceContextRootFromOptions(normalizeRuntimeScopeOptions(options));
        const client = new RegistryClient({ workspaceRoot, warn: (message) => console.warn(message) });
        printRegistryEntries((await client.getIndex()).entries);
      }),
  )
  .addCommand(
    new Command("publish")
      .description("draft a catalogue submission for a public source")
      .argument("<source>", "public resource source or GitHub URL")
      .option("--name <name>", "registry short name")
      .option("--type <type>", "entry type (package, skill, plugin, mcp, or adapter)")
      .option("--description <text>", "short catalogue description")
      .option("--tag <tag>", "search tag (repeatable or comma-separated)", collectTagOption, [] as string[])
      .option("--select <type/name>", "selected artifact inside a larger package (repeatable or comma-separated)", collectSelectOption, [] as string[])
      .option("--skill <name>", "selected skill inside a larger package (repeatable or comma-separated)", collectSkillOption, [] as string[])
      .option("--json", "print only the registry entry JSON", false)
      .action(async (source, options) => {
        const draft = createRegistryPublishDraft(source, {
          name: options.name,
          type: options.type,
          description: options.description,
          tags: options.tag,
          select: options.select,
          skills: options.skill,
        });
        if (options.json) {
          console.log(JSON.stringify(draft.entry, null, 2));
          return;
        }
        console.log("Draft registry entry:");
        console.log(JSON.stringify(draft.entry, null, 2));
        console.log("");
        console.log(`Verify: ${draft.installCommand}`);
        if (!draft.entry.description) console.log("Tip: add --description \"...\" or fill the description before submitting.");
        console.log("");
        console.log("Submit:");
        console.log(draft.issueUrl);
      }),
  );

program
  .command("trust")
  .description("manage persisted source trust decisions")
  .addCommand(
    new Command("forget")
      .description("forget a persisted trusted source pattern")
      .argument("<pattern>", "trusted source glob to revoke")
      .option("--user", "use the user workspace", false)
      .option("--local", "use the nearest local workspace", false)
      .option("--fleet <id>", "use one registered named fleet")
      .option("-t, --target-root <path>", "explicit workspace root")
      .action(async (pattern, options) => {
        const normalized = normalizeRuntimeScopeOptions(options);
        const removed = await forgetTrustedSources(await workspaceRootFromOptions(normalized), pattern);
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
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .argument("<text>", "text to append to the local instructions overlay")
  .action(async (text, options) => {
    const targetRoot = await workspaceRootFromOptions(normalizeRuntimeScopeOptions(options));
    const result = await remember(targetRoot, options.runtime, text);
    console.log(`Remembered in ${result.overlayPath}.`);
    console.log(nextInstallNudge());
  });

const ownershipCommand = program
  .command("ownership")
  .description("inspect and transfer manifest ownership without rewriting runtime artifacts");

ownershipCommand
  .command("handoff")
  .description("transfer one managed artifact between Agentwheel workspace roots")
  .argument("<selector>", "exact artifact selector in type/name form")
  .requiredOption("--from-workspace-root <path>", "current owning workspace root")
  .requiredOption("--to-workspace-root <path>", "new owning workspace root")
  .option("--expected-hash <sha256>", "expected current artifact hash; required when applying")
  .option("--expected-revision <sha256>", "expected install manifest revision; required when applying")
  .option("--adapter <adapter>", "built-in adapter")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--profile <name>", "workspace runtime profile (must resolve to one target)")
  .option("--dry-run", "validate all preconditions without writing the manifest", false)
  .action(async (selector, options) => {
    if (!options.dryRun && (!options.expectedHash || !options.expectedRevision)) {
      throw new Error("Applying an ownership handoff requires --expected-hash and --expected-revision from a reviewed --dry-run.");
    }
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targets = await resolveCliTargets(normalizedOptions);
    if (targets.length !== 1) {
      throw new Error(`Ownership handoff requires exactly one runtime target, found ${targets.length}. Select one --agent or adapter target.`);
    }
    const [artifactType, artifactName, ...extra] = selector.split("/");
    if (!artifactType || !artifactName || extra.length > 0) {
      throw new Error(`Ownership handoff selector must be exactly type/name: ${selector}`);
    }
    const target = targets[0];
    const adapterOptions = adapterOptionsForTarget(target, normalizedOptions);
    const adapter = await resolveAdapterForTarget(target, adapterOptions);
    const installationType = normalizedOptions.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
    const state = installStateForTarget(target, adapter, adapterOptions, installationType);
    const request = {
      ...state,
      targetRoot: state.installRoot,
      adapter: adapter.name,
      artifactType,
      artifactName,
      fromWorkspaceRoot: normalizeCliPath(options.fromWorkspaceRoot),
      toWorkspaceRoot: normalizeCliPath(options.toWorkspaceRoot),
      expectedHash: options.expectedHash,
      expectedRevision: options.expectedRevision,
      transport: transportForTarget(target),
    };
    const result = options.dryRun
      ? await planArtifactOwnershipHandoff(request)
      : await applyArtifactOwnershipHandoff(request);
    console.log(`${options.dryRun ? "Ownership handoff plan" : "Ownership handed off"}: ${result.selector}`);
    console.log(`Target: ${result.adapter}/${result.installationType ?? "default"} at ${result.targetRoot}`);
    console.log(`Path: ${result.path}`);
    console.log(`Hash: ${result.artifactHash}`);
    console.log(`Manifest revision: ${result.manifestRevision}`);
    console.log(`Owner: ${result.fromOwner} -> ${result.toOwner}`);
  });

const mcpCommand = program
  .command("mcp")
  .description("operate on MCP runtime configuration");

mcpCommand
  .command("retire")
  .description("remove one exact legacy MCP contribution with explicit state ownership")
  .argument("<package>", "configured package containing exactly one legacy MCP artifact")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit runtime/project root")
  .option("--agent <name>", "one named agent from merged config")
  .option("--profile <name>", "workspace runtime profile resolving to one target")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--from-workspace-root <path>", "required previous owner when managed legacy state exists")
  .option("--dry-run", "show the retirement plan without writing (default)", false)
  .option("--apply", "apply the exact reviewed retirement plan", false)
  .option("--json", "print the install plan as JSON", false)
  .action(async (packageName, options) => {
    if (options.apply && options.dryRun) throw new Error("--apply cannot be combined with --dry-run.");
    await runExactMcpRetirement(packageName, { ...options, dryRun: !options.apply });
  });

program
  .command("eject")
  .description("copy a managed artifact into local ownership")
  .argument("<item>", "package/type/name")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "explicit workspace root")
  .action(async (item, options) => {
    const targetRoot = await workspaceRootFromOptions(normalizeRuntimeScopeOptions(options));
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
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
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
      const adapterOptions = adapterOptionsForTarget(target, normalizedOptions);
      const adapter = await resolveAdapterForTarget(target, adapterOptions);
      const transport = transportForTarget(target);
      const installationType = normalizedOptions.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
      const state = installStateForTarget(target, adapter, adapterOptions, installationType);
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
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--all", "run for every configured agent", false)
  .option("--profile <name>", "workspace runtime profile")
  .option("--json", "print the versioned status protocol as JSON", false)
  .option("--offline", "use cached version and member status even when stale", false)
  .option("--refresh", "refresh package and member status regardless of TTL", false)
  .action(async (options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const composite = await resolveSelectedCompositeProfile(normalizedOptions);
    if (composite) {
      const report = await collectCompositeStatus(composite.workspaceRoot, composite.name, composite.profile, normalizedOptions);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printStatusReport(report);
      if (!["PASS", "WARN"].includes(report.health)) process.exitCode = 1;
      return;
    }
    const targets = await resolveCliTargets(normalizedOptions, { preferAllProfile: true });
    if (options.json) {
      const targetReports = [];
      for (const target of targets) targetReports.push(await collectTargetStatus(target, normalizedOptions));
      const report = await statusReport(targets[0]?.workspaceRoot ?? process.cwd(), options.profile ?? null, targetReports);
      console.log(JSON.stringify(report, null, 2));
      if (!["PASS", "WARN"].includes(report.health)) process.exitCode = 1;
      return;
    }
    for (const target of targets) {
      await printStatus(target, normalizedOptions);
    }
  });

const journalCommand = program
  .command("journal")
  .description("inspect or abort pending apply journals");

journalCommand
  .command("list")
  .description("show pending apply journals for resolved runtime targets")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
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
    let pending = 0;
    for (const target of targets) {
      const state = await journalStateForTarget(target, normalizedOptions);
      const journal = await readApplyJournal(state.installRoot, state.adapter.name, state.transport, state.state);
      if (!journal) continue;
      pending += 1;
      console.log(`PENDING ${state.adapter.name}/${state.installationType} at ${state.installRoot}`);
      console.log(`  journal: ${join(state.installRoot, ".agentwheel", `${state.state.stateKey}.apply-journal.json`)}`);
      console.log(`  stateKey: ${state.state.stateKey}`);
      console.log(`  createdAt: ${journal.createdAt}`);
      console.log(`  updatedAt: ${journal.updatedAt}`);
      console.log(`  operations: ${journal.operations.length}, completed: ${journal.completed.length}`);
    }
    if (pending === 0) console.log("No pending apply journals.");
  });

journalCommand
  .command("abort")
  .description("archive pending apply journals without touching runtime files")
  .option("--adapter <adapter>", "built-in adapter or comma-separated adapters")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
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
    let aborted = 0;
    for (const target of targets) {
      const state = await journalStateForTarget(target, normalizedOptions);
      const result = await abortApplyJournal(state.installRoot, state.adapter.name, state.transport, state.state);
      if (!result) continue;
      aborted += 1;
      console.log(`Archived ${state.adapter.name}/${state.installationType} pending journal: ${result.archivePath}`);
    }
    if (aborted === 0) console.log("No pending apply journals.");
  });

program
  .command("doctor")
  .description("check agentwheel runtime setup and companion skill guidance")
  .option("--adapter <adapter>", "built-in adapter")
  .option("-i, --installation-type <type>", "installation type (for example local or user)")
  .option("--user", "use the user workspace", false)
  .option("--local", "use the nearest local workspace", false)
  .option("--fleet <id>", "use one registered named fleet")
  .option("-t, --target-root <path>", "runtime/project root")
  .option("--agent <name>", "named agent from merged config")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--adapter-module <path>", "local programmatic adapter module")
  .option("--allow-adapter-code", "allow loading local adapter code", false)
  .option("--skill <name>", "check a specific skill by name (repeatable or comma-separated)", collectSkillOption, [] as string[])
  .option("--source <source>", "source to use in suggested install commands")
  .option("--json", "print machine-readable doctor report", false)
  .action(async (options) => {
    const normalizedOptions = normalizeRuntimeScopeOptions(options);
    const targets = await resolveCliTargets(normalizedOptions);
    if (targets.length !== 1) throw new Error(`Doctor requires exactly one runtime target, found ${targets.length}.`);
    await printDoctor(targets[0]!, normalizedOptions);
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
  behavior: { apply: boolean; quiet?: boolean },
): Promise<void> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options, { defaultUser: shouldDefaultUserInstall(nameOrSource, options) });
  const outputFormat = effectivePlanOutputFormat(normalizedOptions);
  const composite = await resolveSelectedCompositeProfile(normalizedOptions);
  if (composite) {
    if (outputFormat !== "human") {
      throw new Error("Composite profile plan/install currently requires human output; use status --json for the versioned member protocol.");
    }
    await runCompositeInstall(
      composite.workspaceRoot,
      composite.name,
      composite.profile,
      nameOrSource,
      normalizedOptions,
      behavior,
    );
    return;
  }
  if (outputFormat !== "human") {
    const report = await buildPlanReport(nameOrSource, normalizedOptions);
    if (report.targets.some((target) => target.hasBlockingChanges)) process.exitCode = 1;
    if (behavior.apply) {
      await runInstallCommand(
        nameOrSource,
        { ...normalizedOptions, format: "human", json: false },
        { apply: true, quiet: true },
      );
      report.applied = true;
    }
    process.stdout.write(`${renderReport(report, outputFormat)}\n`);
    return;
  }

  if (normalizedOptions.profile) {
    const profileScope = await resolveCliWorkspaceScope(normalizedOptions);
    const workspaceRoot = profileScope.root;
    const results = await syncProfile({
      workspaceRoot,
      fleetId: profileScope?.fleetId,
      profile: normalizedOptions.profile,
      source: nameOrSource,
      driver: normalizedOptions.driver,
      mode: normalizedOptions.mode,
      select: selectedArtifactsFromOptions(normalizedOptions),
      installationType: normalizedOptions.installationType,
      dryRun: !behavior.apply,
      executePlugins: normalizedOptions.executePlugins,
      reloadRuntimes: shouldReloadRuntimes(normalizedOptions),
      allowAdapterCode: normalizedOptions.allowAdapterCode,
      forceDrift: normalizedOptions.forceDrift,
      forceConflict: normalizedOptions.forceConflict,
      forceForeignState: normalizedOptions.forceForeignState,
      replaceConflict: normalizedOptions.replaceConflict,
      noDeps: noDepsFromOptions(normalizedOptions),
      includeSuggestions: normalizedOptions.withSuggestions,
      suggestionAliases: suggestionAliasesFromOptions(normalizedOptions),
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
      if (!behavior.quiet) {
        console.log(`Profile ${normalizedOptions.profile} / ${result.runtime} / ${result.packageName} at ${result.targetRoot} (${result.transport}):`);
        console.log(formatPlan(result.plan));
        if (result.reloaded) console.log(`Reloaded runtime via ${result.reloadCommandSummary}.`);
      }
      if (result.plan.hasBlockingChanges) process.exitCode = 1;
    }
    if (behavior.apply && !behavior.quiet) {
      console.log("Applied.");
    }
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
        let entry = await packageEntryFromSource(nameOrSource, target.workspaceRoot, {
          ...targetOptions,
          adapter: targetOptions.adapter ?? target.adapter,
          deferGraphRendering: true,
        });
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

    for (const result of await buildGraphPlansForTarget(target, source, { ...targetOptions, scope, extraPackage, reportFormat: outputFormat }, { mode: "install" })) {
      if (!behavior.quiet) console.log(formatGraphPlan(result));
      if (behavior.apply) {
        const transport = transportForTarget(target);
        const executePlugins = target.executePlugins ?? targetOptions.executePlugins;
        await applyCombinedInstallPlan(result.plan, {
          executePlugins,
          transport,
          graphLockDigest: result.graphLockDigest,
          graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
        });
        const reloaded = await reloadRuntimeAfterPluginChanges(result.plan, target, transport, {
          enabled: target.reloadRuntimes ?? shouldReloadRuntimes(targetOptions),
          executePlugins,
        });
        if (!behavior.quiet) {
          console.log(`Applied ${result.plan.adapter} at ${result.plan.targetRoot}.`);
          if (reloaded) console.log(`Reloaded runtime via ${formatReloadCommands(target.reloadCommands)}.`);
        }
      }
      await rm(result.bundle.root, { recursive: true, force: true });
      if (result.plan.hasBlockingChanges) process.exitCode = 1;
    }

    if (behavior.apply && extraPackage && !targetOptions.onlySource) {
      await writeWorkspaceConfig(target.workspaceRoot, upsertPackage(await readWorkspaceConfig(target.workspaceRoot), extraPackage));
    }
  }
}

async function buildPlanReport(
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
): Promise<PlanReport> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options, { defaultUser: shouldDefaultUserInstall(nameOrSource, options) });
  const reportTargets: PlanReportTarget[] = [];
  const reportWarnings: string[] = [];
  const collectWarning = (message: string) => {
    reportWarnings.push(message);
  };

  if (normalizedOptions.profile) {
    const profileScope = await resolveCliWorkspaceScope(normalizedOptions);
    const workspaceRoot = profileScope.root;
    const results = await syncProfile({
      workspaceRoot,
      fleetId: profileScope?.fleetId,
      profile: normalizedOptions.profile,
      source: nameOrSource,
      driver: normalizedOptions.driver,
      mode: normalizedOptions.mode,
      select: selectedArtifactsFromOptions(normalizedOptions),
      installationType: normalizedOptions.installationType,
      dryRun: true,
      executePlugins: normalizedOptions.executePlugins,
      allowAdapterCode: normalizedOptions.allowAdapterCode,
      forceDrift: normalizedOptions.forceDrift,
      forceConflict: normalizedOptions.forceConflict,
      forceForeignState: normalizedOptions.forceForeignState,
      replaceConflict: normalizedOptions.replaceConflict,
      noDeps: noDepsFromOptions(normalizedOptions),
      includeSuggestions: normalizedOptions.withSuggestions,
      suggestionAliases: suggestionAliasesFromOptions(normalizedOptions),
      lockedResolution: true,
      frozenLock: normalizedOptions.frozenLock,
      offline: normalizedOptions.offline,
      yes: normalizedOptions.yes,
      trustPatterns: normalizedOptions.trust ?? [],
      readOnly: true,
      isTTY: false,
    });
    for (const result of results) {
      reportTargets.push(installPlanReportTarget(result.plan, result.graphLockDigest));
      reportWarnings.push(...result.warnings);
    }
    return planReport(reportTargets, reportWarnings);
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
        let entry = await packageEntryFromSource(nameOrSource, target.workspaceRoot, {
          ...targetOptions,
          adapter: targetOptions.adapter ?? target.adapter,
          deferGraphRendering: true,
          warn: collectWarning,
        });
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

    const results = await buildGraphPlansForTarget(
      target,
      source,
      {
        ...targetOptions,
        scope,
        extraPackage,
        dryRun: true,
        reportFormat: "json",
        suppressEmptyMessage: true,
        warn: collectWarning,
      },
      { mode: "install" },
    );
    for (const result of results) {
      reportTargets.push(installPlanReportTarget(result.plan, result.graphLockDigest));
      reportWarnings.push(...result.warnings);
      await rm(result.bundle.root, { recursive: true, force: true });
    }
  }
  return planReport(reportTargets, reportWarnings);
}

function effectivePlanOutputFormat(options: { json?: boolean; format?: string }): PlanOutputFormat {
  const format = options.format ?? "human";
  if (!isPlanOutputFormat(format)) {
    throw new Error(`Unknown --format value: ${format}. Valid formats: ${planOutputFormats.join(", ")}.`);
  }
  if (options.json && format !== "human" && format !== "json") {
    throw new Error(`--json conflicts with --format ${format}. Use --format json instead.`);
  }
  return format !== "human" ? format : options.json ? "json" : "human";
}

function isPlanOutputFormat(value: string): value is PlanOutputFormat {
  return (planOutputFormats as readonly string[]).includes(value);
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
    version?: string;
    name?: string;
    select?: string[];
    skill?: string[];
    skills?: string[];
    withSuggestions?: boolean;
    suggestion?: string[];
    suggestions?: string[];
    override?: string[];
    overrides?: string[];
    frozenLock?: boolean;
    offline?: boolean;
    installationType?: string;
    warn?: (message: string) => void;
    deferGraphRendering?: boolean;
  },
): Promise<WorkspacePackage> {
  const lockMode = options.frozenLock === true || options.offline === true;
  const resolvedInput = await resolvePackageSource(source, targetRoot, { offline: lockMode });
  const resolvedSource = resolvedInput.source;
  const selectedArtifacts = selectedArtifactsFromOptionsOrRegistry(options, resolvedInput.registryEntry);
  const driverName = (options.driver ?? inferSourceDriverName(resolvedSource)) as WorkspacePackage["driver"];
  const driver = getSourceDriver(driverName);
  const adapter = await resolveAdapter({
    adapter: options.adapter ?? "openclaw",
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
    allowAdapterCode: options.allowAdapterCode,
    baseDir: targetRoot,
    warn: options.warn ?? ((message) => console.warn(message)),
  });
  const provisionalName = options.name ?? resolvedInput.registryEntry?.name ?? source;
  const initialVersion = options.mode === "tracking" && options.version
    ? await effectiveTrackingRef({
      name: provisionalName,
      source: resolvedSource,
      driver: driverName,
      adapter: adapter.name,
      installationType: options.installationType,
      mode: "tracking",
      version: options.version,
    }, targetRoot, { offline: options.offline })
    : undefined;
  if (initialVersion?.availability?.error || initialVersion?.availability?.stale) {
    throw new Error(
      `Cannot select an initial version for ${provisionalName}: `
      + `${initialVersion.availability?.error ?? "version metadata is stale"}`,
    );
  }
  if (initialVersion?.availability && !initialVersion.availability.latestAllowedRef) {
    throw new Error(
      `No available version of ${provisionalName} satisfies ${options.version}; `
      + `latest overall is ${initialVersion.availability.latestOverall ?? "unknown"}.`,
    );
  }
  const bundle = options.deferGraphRendering
    ? await stageSourceRaw(driver, resolvedSource, {
      cacheRoot: join(targetRoot, ".agentwheel", "cache"),
      mode: options.mode,
      ref: initialVersion?.ref,
      frozenLock: lockMode,
    })
    : await stageSource(driver, resolvedSource, {
      workspaceRoot: targetRoot,
      adapter,
      cacheRoot: join(targetRoot, ".agentwheel", "cache"),
      mode: options.mode,
      ref: initialVersion?.ref,
      frozenLock: lockMode,
      select: selectedArtifacts,
    });
  const installationArtifacts = options.deferGraphRendering
    ? filterArtifactsBySelection(bundle.artifacts, selectedArtifacts)
      .filter((artifact) => !artifact.runtimes?.length || artifact.runtimes.includes(adapter.name))
    : bundle.artifacts;
  const installationType = resolveInstallationTypeForArtifacts(
    adapter,
    installationArtifacts.map((artifact) => artifact.type),
    options.installationType,
  );
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
      version: options.version,
      requestedRef: bundle.source.requestedRef,
      select: selectedArtifacts,
      withSuggestions: options.withSuggestions === true ? true : undefined,
      suggestions: suggestionAliasesFromOptions(options),
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

async function configuredPackageForSkill(
  target: RuntimeTarget,
  packages: WorkspacePackage[],
  skillName: string,
  options: GraphCliOptions,
  explicitPackageName?: string,
): Promise<WorkspacePackage> {
  const selector = `skills/${skillName}`;
  if (explicitPackageName) {
    const pkg = findConfiguredPackage(packages, explicitPackageName);
    if (!pkg) throw new Error(`Configured package not found: ${explicitPackageName}`);
    if (!(await packageSelectsSkillForTarget(target, pkg, selector, options))) {
      throw new Error(`Configured package '${pkg.name}' does not select ${selector}.`);
    }
    return pkg;
  }

  const adapterPackages = packages.filter((pkg) => pkg.adapter === target.adapter);
  const candidates = adapterPackages.length > 0 ? adapterPackages : packages;
  const matches: WorkspacePackage[] = [];
  for (const pkg of candidates) {
    if (await packageSelectsSkillForTarget(target, pkg, selector, options)) matches.push(pkg);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Skill '${skillName}' has multiple configured owners: ${matches.map((pkg) => pkg.name).sort().join(", ")}. `
      + "Pass --package <name>.",
    );
  }
  throw new Error(
    `No configured owner found for skill '${skillName}'. `
    + `Add ${selector} to one package selection or pass --package <name>.`,
  );
}

async function packageSelectsSkillForTarget(
  target: RuntimeTarget,
  pkg: WorkspacePackage,
  selector: string,
  options: GraphCliOptions,
): Promise<boolean> {
  const explicitSelection = normalizeArtifactSelectors(pkg.select, pkg.skills);
  if (explicitSelection && !explicitSelection.some((candidate) => candidate === selector)) return false;

  const groups = new Map<string, PackageGraphGroup>();
  const group = graphGroupForPackage(groups, target, pkg, options);
  const adapter = await resolveAdapterForTarget(group.target, group.adapterOptions);
  const graphLockPath = graphLockPathForTarget(
    group.target.workspaceRoot,
    targetKeyForTarget(group.target, adapter.name),
    adapter.name,
    targetFingerprintParts(group.target, adapter, group.adapterOptions, group.installationType),
  );
  if (await pathExists(graphLockPath)) {
    const lock = await readGraphLock(graphLockPath);
    const root = lock.canonical.roots.find((candidate) => candidate.rootId === pkg.name);
    if (root?.selected.includes(selector)) return true;
  }

  const results = await buildGraphPlansForTarget(target, undefined, {
    ...options,
    scope: pkg.name,
    onlySource: true,
    dryRun: true,
    suppressEmptyMessage: true,
  }, { mode: "install" });
  try {
    return results.some((result) => result.bundle.graphLock.canonical.roots.some(
      (root) => root.rootId === pkg.name && root.selected.includes(selector),
    ));
  } finally {
    await Promise.all(results.map((result) => rm(result.bundle.root, { recursive: true, force: true })));
  }
}

function noDepsFromOptions(options: { noDeps?: boolean; deps?: boolean }): boolean {
  return options.noDeps === true || options.deps === false;
}

function shouldReloadRuntimes(options: { reloadRuntimes?: boolean; restartRuntimes?: boolean }): boolean {
  return options.reloadRuntimes === true || options.restartRuntimes === true;
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
  options: { targetRoot?: string; adapter?: string; installationType?: string; user?: boolean; local?: boolean; fleet?: string; agent?: string; profile?: string; all?: boolean; allDetected?: boolean },
  behavior: { preferAllProfile?: boolean } = {},
): Promise<RuntimeTarget[]> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options);
  const scope = await resolveCliWorkspaceScope(normalizedOptions);
  const scopeRoot = scope.root;
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
        cwd: scopeRoot,
        targetRoot: normalizedOptions.targetRoot,
        adapter,
        installationType: normalizedOptions.installationType,
        fleetId: scope?.fleetId,
      }));
    }
    return targets;
  }
  if (normalizedOptions.profile) {
    return resolveProfileRuntimeTargets({
      cwd: scopeRoot ?? process.cwd(),
      targetRoot: normalizedOptions.targetRoot,
      installationType: normalizedOptions.installationType,
      fleetId: scope?.fleetId,
      profile: normalizedOptions.profile,
    });
  }
  if (normalizedOptions.all) {
    if (behavior.preferAllProfile && !normalizedOptions.agent) {
      const profileTargets = await tryResolveProfileAllRuntimeTargets(normalizedOptions, scopeRoot, scope?.fleetId);
      if (profileTargets) return profileTargets;
    }
    return resolveAllRuntimeTargets({
      cwd: scopeRoot,
      targetRoot: normalizedOptions.targetRoot,
      adapter: normalizedOptions.adapter,
      installationType: normalizedOptions.installationType,
      agent: normalizedOptions.agent,
      all: normalizedOptions.all,
      fleetId: scope?.fleetId,
    });
  }
  if (normalizedOptions.allDetected) {
    return resolveAllDetectedRuntimeTargets({
      cwd: scopeRoot,
      targetRoot: normalizedOptions.targetRoot,
      adapter: normalizedOptions.adapter,
      installationType: normalizedOptions.installationType,
      agent: normalizedOptions.agent,
      allDetected: normalizedOptions.allDetected,
      fleetId: scope?.fleetId,
    });
  }
  return [await resolveRuntimeTarget({
    cwd: scopeRoot,
    targetRoot: normalizedOptions.targetRoot,
    adapter: normalizedOptions.adapter,
    installationType: normalizedOptions.installationType,
    agent: normalizedOptions.agent,
    fleetId: scope?.fleetId,
  })];
}

async function tryResolveProfileAllRuntimeTargets(options: { targetRoot?: string; installationType?: string }, scopeRoot?: string, fleetId?: string): Promise<RuntimeTarget[] | undefined> {
  try {
    return await resolveProfileRuntimeTargets({
      cwd: scopeRoot ?? process.cwd(),
      targetRoot: options.targetRoot,
      installationType: options.installationType,
      fleetId,
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

async function resolveAdapterForTarget(target: RuntimeTarget, options: { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean; warn?: (message: string) => void }) {
  const adapterOptions = adapterOptionsForTarget(target, options);
  return resolveAdapter({
    adapter: target.adapter,
    adapterConfig: adapterOptions.adapterConfig,
    adapterModule: adapterOptions.adapterModule,
    allowAdapterCode: adapterOptions.allowAdapterCode,
    baseDir: target.workspaceRoot,
    warn: options.warn ?? ((message) => console.warn(message)),
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
  json?: boolean;
  executePlugins?: boolean;
  reloadRuntimes?: boolean;
  restartRuntimes?: boolean;
  allowAdapterCode?: boolean;
  adapterConfig?: string;
  adapterModule?: string;
  adapter?: string;
  installationType?: string;
  user?: boolean;
  local?: boolean;
  fleet?: string;
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
  withSuggestions?: boolean;
  suggestion?: string[];
  suggestions?: string[];
  dependency?: string[];
  onlySource?: boolean;
  frozenLock?: boolean;
  offline?: boolean;
  refresh?: boolean;
  yes?: boolean;
  trust?: string[];
  scope?: string;
  keepFiles?: boolean;
  forceDrift?: boolean;
  forceConflict?: boolean;
  forceForeignState?: boolean;
  replaceConflict?: boolean;
  format?: string;
  reportFormat?: PlanOutputFormat;
  suppressEmptyMessage?: boolean;
  warn?: (message: string) => void;
  extraPackage?: WorkspacePackage;
  multiAdapterSource?: boolean;
  adopt?: boolean;
  retireExactMcp?: boolean;
  expectedFromWorkspaceOwner?: string;
  focusedArtifact?: { type: "skills"; name: string };
}

async function runExactMcpRetirement(packageName: string, options: GraphCliOptions & { fromWorkspaceRoot?: string }): Promise<void> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options);
  const targets = await resolveCliTargets(normalizedOptions);
  if (targets.length !== 1) {
    throw new Error(`Exact MCP retirement requires exactly one runtime target, found ${targets.length}.`);
  }
  const target = targets[0]!;
  const expectedFromWorkspaceOwner = options.fromWorkspaceRoot
    ? workspaceOwnerForRoot(normalizeCliPath(options.fromWorkspaceRoot))
    : undefined;
  const results = await buildGraphPlansForTarget(target, undefined, {
    ...normalizedOptions,
    scope: packageName,
    onlySource: true,
    retireExactMcp: true,
    expectedFromWorkspaceOwner,
    dryRun: true,
  }, { mode: "install" });
  if (results.length !== 1) {
    await Promise.all(results.map((result) => rm(result.bundle.root, { recursive: true, force: true })));
    throw new Error(`Exact MCP retirement requires one package plan, found ${results.length}.`);
  }
  const result = results[0]!;
  try {
    console.log(options.json ? JSON.stringify(result.plan, null, 2) : formatGraphPlan(result));
    if (result.plan.hasBlockingChanges) {
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun) {
      await uninstall(result.plan, { transport: transportForTarget(target) });
      console.log(`Retired exact MCP contribution for ${result.plan.adapter} at ${result.plan.targetRoot}.`);
    }
  } finally {
    await rm(result.bundle.root, { recursive: true, force: true });
  }
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

async function runSkillUpdateCommand(
  skillName: string,
  options: GraphCliOptions & { package?: string; adopt?: boolean },
): Promise<void> {
  const normalizedOptions = normalizeRuntimeScopeOptions(options);
  const composite = await resolveSelectedCompositeProfile(normalizedOptions);
  if (composite) {
    await runCompositeSkillUpdate(
      composite.workspaceRoot,
      composite.name,
      composite.profile,
      skillName,
      options.package,
      normalizedOptions,
    );
    return;
  }
  const targets = await resolveCliTargets(normalizedOptions, { preferAllProfile: true });
  for (const target of targets) {
    const config = await readMergedWorkspaceConfig(target.workspaceRoot);
    const owner = await configuredPackageForSkill(target, config.packages, skillName, normalizedOptions, options.package);
    const mode = owner.mode === "tracking" ? "update" : "install";
    console.log(`Skill ${skillName}: ${owner.name} (${mode}).`);
    await runConfiguredGraphPackages(target, {
      ...normalizedOptions,
      scope: owner.name,
      onlySource: true,
      focusedArtifact: { type: "skills", name: skillName },
      replaceConflict: options.adopt === true,
    }, { mode });
  }
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
      const transport = transportForTarget(target);
      const executePlugins = target.executePlugins ?? options.executePlugins;
      await applyCombinedInstallPlan(result.plan, {
        executePlugins,
        transport,
        graphLockDigest: result.graphLockDigest,
        graphLock: { path: result.graphLockPath, lock: result.bundle.graphLock },
      });
      const reloaded = await reloadRuntimeAfterPluginChanges(result.plan, target, transport, {
        enabled: target.reloadRuntimes ?? shouldReloadRuntimes(options),
        executePlugins,
      });
      console.log(`Applied ${result.plan.adapter} at ${result.plan.targetRoot}.`);
      if (reloaded) console.log(`Reloaded runtime via ${formatReloadCommands(target.reloadCommands)}.`);
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
  const dependencyUpdateSelectors = sortedUniqueValues(targetOptions.dependency ?? []);
  const scopedDependencyUpdate = behavior.mode === "update" && dependencyUpdateSelectors.length > 0;
  const scopedPackage = targetOptions.scope ? findConfiguredPackage(config.packages, targetOptions.scope) : undefined;
  const scopedRootId = scopedPackage?.name ?? (source ? targetOptions.scope : undefined);
  if (targetOptions.scope && !scopedPackage && !source) throw new Error(`Configured package not found: ${targetOptions.scope}`);

  if (scopedPackage && targetOptions.onlySource) {
    const group = graphGroupForPackage(groups, target, scopedPackage, targetOptions);
    group.packages.push(scopedPackage);
  } else if (!source || !targetOptions.onlySource) {
    for (const pkg of config.packages) {
      const group = graphGroupForPackage(groups, target, pkg, targetOptions);
      group.packages.push(pkg);
    }
  }

  if (source) {
    let entry = targetOptions.extraPackage ?? await packageEntryFromSource(source, target.workspaceRoot, {
      ...targetOptions,
      deferGraphRendering: true,
    });
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
    const message = `No packages configured at ${target.workspaceRoot}.`;
    if (!targetOptions.suppressEmptyMessage) {
      if (targetOptions.reportFormat && targetOptions.reportFormat !== "human") console.warn(message);
      else console.log(message);
    }
    return [];
  }

  const results = [];
  for (const group of groups.values()) {
    const adapter = await resolveAdapterForTarget(group.target, { ...group.adapterOptions, warn: targetOptions.warn });
    const transport = transportForTarget(group.target);
    const allPackages = [...group.packages, ...group.extraPackages];
    const groupHasScope = !scopedRootId || allPackages.some((pkg) => pkg.name === scopedRootId || pkg.source === targetOptions.scope);
    if (behavior.mode === "install" && scopedRootId && !groupHasScope) continue;
    const groupGraphLockPath = graphLockPathForTarget(
      group.target.workspaceRoot,
      targetKeyForTarget(group.target, adapter.name),
      adapter.name,
      targetFingerprintParts(group.target, adapter, group.adapterOptions, group.installationType),
    );
    const previousGroupLock = await (await pathExists(groupGraphLockPath)
      ? readGraphLock(groupGraphLockPath)
      : undefined);
    const dependencyUpdateRootNames = new Set<string>();
    if (scopedDependencyUpdate) {
      for (const pkg of group.packages) {
        const root = previousGroupLock?.canonical.roots.find((candidate) => candidate.rootId === pkg.name);
        if (root?.mode !== "tracking") continue;
        const node = previousGroupLock?.canonical.nodes.find((candidate) => candidate.id === root.graphNodeId);
        if (node && dependencyUpdateSelectors.some((selector) => dependencyUpdateSelectorMatchesRoot(root, node, selector))) {
          dependencyUpdateRootNames.add(pkg.name);
        }
      }
    }
    const updateScope = behavior.mode === "update" ? (scopedPackage ? new Set([scopedPackage.name]) : undefined) : undefined;
    const versionSelections = new Map<string, { ref?: string; availability?: VersionAvailability }>();
    const lockedVersionRefs = new Map<string, string>();
    const versionPolicyUpdateNames = new Set<string>();
    for (const pkg of allPackages) {
      if (pkg.mode !== "tracking" || !pkg.version) continue;
      const previousRoot = previousGroupLock?.canonical.roots.find((candidate) => candidate.rootId === pkg.name);
      const previousNode = previousRoot
        ? previousGroupLock?.canonical.nodes.find((candidate) => candidate.id === previousRoot.graphNodeId)
        : undefined;
      const policyRequiresResolution = !previousNode || !satisfiesVersionRange(previousNode.version, pkg.version);
      if (!policyRequiresResolution && previousNode?.requestedRef) {
        lockedVersionRefs.set(pkg.name, previousNode.requestedRef);
      }
      const packageUpdateSelected = !updateScope || updateScope.has(pkg.name);
      if ((behavior.mode === "update" && packageUpdateSelected)
        || (behavior.mode === "install" && policyRequiresResolution)) {
        const selection = await effectiveTrackingRef(pkg, group.target.workspaceRoot, {
          offline: targetOptions.offline,
          forceRefresh: targetOptions.refresh,
        });
        if (selection.availability?.error || selection.availability?.stale) {
          throw new Error(
            `Cannot resolve ${pkg.name} with stale version metadata: `
            + `${selection.availability?.error ?? "version index TTL expired"}`,
          );
        }
        versionSelections.set(pkg.name, selection);
        if (policyRequiresResolution) versionPolicyUpdateNames.add(pkg.name);
        if (!selection.availability?.latestAllowed) {
          targetOptions.warn?.(
            `No available version of ${pkg.name} satisfies ${pkg.version}; `
            + `latest overall is ${selection.availability?.latestOverall ?? "unknown"}.`,
          );
        }
      }
    }
    const roots: GraphRootRequest[] = [
      ...allPackages.map((pkg) => {
        const versionSelection = versionSelections.get(pkg.name);
        const versionAllowsUpdate = !pkg.version || Boolean(versionSelection?.availability?.latestAllowed);
        const updateThisPackage = behavior.mode === "update" && !scopedDependencyUpdate
          && pkg.mode === "tracking"
          && versionAllowsUpdate
          && (!updateScope || updateScope.has(pkg.name) || updateScope.has(pkg.source));
        const packageIsScoped = scopedRootId ? pkg.name === scopedRootId || pkg.source === targetOptions.scope : true;
        if (pkg.selection && selectedArtifacts && packageIsScoped) {
          throw new Error(`--select/--skill cannot override imported selection for configured package '${pkg.name}'.`);
        }
        return {
          rootId: pkg.name,
          source: pkg.source,
          mode: pkg.mode,
          version: pkg.version,
          ref: versionSelection?.ref ?? lockedVersionRefs.get(pkg.name) ?? pkg.requestedRef,
          select: pkg.selection ? undefined : selectedArtifacts && packageIsScoped ? selectedArtifacts : normalizeArtifactSelectors(pkg.select, pkg.skills),
          selection: pkg.selection,
          aliases: pkg.aliases,
          overrides: pkg.overrides,
          includeSuggestions: targetOptions.withSuggestions === true || pkg.withSuggestions === true,
          suggestionAliases: packageSuggestionAliases(pkg, targetOptions),
          useLock: behavior.mode === "install"
            ? !versionPolicyUpdateNames.has(pkg.name)
            : scopedDependencyUpdate
              ? !dependencyUpdateRootNames.has(pkg.name)
              : !updateThisPackage,
        };
      }),
      ...group.extraRoots,
    ];
    if (behavior.mode === "update") {
      const changed = roots.filter((root) => root.useLock === false);
      if (changed.length === 0 && !scopedDependencyUpdate) {
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
      fleetId: group.target.fleetId,
      adapter,
      transport,
      targetKey: targetKeyForTarget(group.target, adapter.name),
      targetFingerprintParts: targetFingerprintParts(group.target, adapter, group.adapterOptions, group.installationType),
      installationType: group.installationType,
      stateKey: group.target.stateKey,
      noDeps: noDepsFromOptions(targetOptions),
      includeSuggestions: targetOptions.withSuggestions,
      suggestionAliases: suggestionAliasesFromOptions(targetOptions),
      lockedResolution: behavior.mode === "install" || scopedDependencyUpdate,
      dependencyUpdateSelectors,
      frozenLock: targetOptions.frozenLock,
      offline: targetOptions.offline,
      yes: targetOptions.yes,
      trustPatterns: targetOptions.trust ?? [],
      readOnly: targetOptions.dryRun === true,
      isTTY: process.stdin.isTTY === true,
      forceDrift: targetOptions.forceDrift,
      forceConflict: targetOptions.forceConflict,
      forceForeignState: targetOptions.forceForeignState,
      replaceConflict: targetOptions.replaceConflict,
      retireExactMcp: targetOptions.retireExactMcp,
      expectedFromWorkspaceOwner: targetOptions.expectedFromWorkspaceOwner,
    });
    if ((behavior.mode === "install" || behavior.mode === "update") && scopedRootId) {
      const state = installStateForTarget(group.target, adapter, group.adapterOptions, group.installationType);
      const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
      results.push(targetOptions.focusedArtifact
        ? previousGroupLock
          ? scopeUpdatePlanToArtifact(result, scopedRootId, targetOptions.focusedArtifact, previousGroupLock, manifest)
          : scopeInstallPlanToArtifact(result, scopedRootId, targetOptions.focusedArtifact, manifest)
        : previousGroupLock
          ? scopeUpdatePlanToRoot(result, scopedRootId, previousGroupLock, manifest)
          : scopeInstallPlanToRoot(result, scopedRootId, manifest));
    } else if (scopedDependencyUpdate) {
      const state = installStateForTarget(group.target, adapter, group.adapterOptions, group.installationType);
      const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
      const previousLock = await readGraphLock(result.graphLockPath);
      results.push(scopeUpdatePlanToDependencies(result, dependencyUpdateSelectors, previousLock, manifest));
    } else {
      results.push(result);
    }
  }
  return results;
}

function scopeUpdatePlanToDependencies(
  result: GraphSourcePlanResult,
  selectors: string[],
  previousLock: Awaited<ReturnType<typeof readGraphLock>>,
  manifest: InstallManifest | undefined,
): GraphSourcePlanResult {
  const selectedNames = dependencyUpdatePackageNames(previousLock, selectors);
  const allowedNodeIds = new Set(result.graph.nodes
    .filter((node) => selectedNames.has(node.name))
    .map((node) => node.id));
  const queue = [...allowedNodeIds];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const edge of result.graph.edges) {
      if (edge.from !== parentId || allowedNodeIds.has(edge.to)) continue;
      allowedNodeIds.add(edge.to);
      queue.push(edge.to);
    }
  }
  const selectedPreviousNodeIds = dependencyUpdateNodeIds(previousLock, selectors);
  const allowedNames = new Set(result.graph.nodes
    .filter((node) => allowedNodeIds.has(node.id))
    .map((node) => node.name));
  for (const name of selectedNames) allowedNames.add(name);

  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const operations = result.plan.operations.flatMap((operation) => {
    if (operation.action === "skip" || operation.action === "keep" || operationBelongsToDependencyUpdate(operation, allowedNodeIds, allowedNames)) {
      return [operation];
    }
    return transformOutOfScopeOperation(
      operation,
      manifestByPath.get(operation.relativeDestPath),
      result.plan.targetRoot,
      `scoped dependency update ${selectors.join(", ")}`,
    );
  });
  const selectedRootIds = dependencyUpdateRootIds(previousLock, selectors);
  const graphLock = preserveUnrelatedGraphPackages(
    result.bundle.graphLock,
    previousLock,
    allowedNodeIds,
    selectedPreviousNodeIds,
    selectedRootIds,
  );
  const graphLockDigest = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
  return {
    ...result,
    bundle: { ...result.bundle, graphLock },
    graphLockDigest,
    graphDiff: diffGraphLocks(previousLock, graphLock),
    plan: {
      ...result.plan,
      operations,
      graphLockDigest,
      hasBlockingChanges: operations.some((operation) => operation.action === "drift" || operation.action === "conflict"),
    },
  };
}

function preserveUnrelatedGraphPackages(
  current: GraphLock,
  previous: GraphLock,
  selectedCurrentNodeIds: Set<string>,
  selectedPreviousNodeIds: Set<string>,
  selectedRootIds: Set<string>,
): GraphLock {
  const selectedCurrentRoots = current.canonical.roots.filter((root) => selectedRootIds.has(root.rootId));
  const currentRootsById = new Map(selectedCurrentRoots.map((root) => [root.rootId, root]));
  const roots = previous.canonical.roots.map((root) => currentRootsById.get(root.rootId) ?? root);
  for (const root of selectedCurrentRoots) {
    if (!previous.canonical.roots.some((candidate) => candidate.rootId === root.rootId)) roots.push(root);
  }
  const currentNodes = current.canonical.nodes.filter((node) => selectedCurrentNodeIds.has(node.id));
  const previousNodes = previous.canonical.nodes.filter((node) => !selectedPreviousNodeIds.has(node.id));
  const selectedCurrentArtifacts = current.canonical.artifacts.filter((artifact) => selectedCurrentNodeIds.has(artifact.graphNodeId));
  const previousArtifacts = previous.canonical.artifacts.filter((artifact) => !selectedPreviousNodeIds.has(artifact.graphNodeId));
  const edgeTouchesSelected = (from: string, to: string) => selectedCurrentNodeIds.has(from)
    || selectedCurrentNodeIds.has(to);
  const previousEdge = (edge: { from: string; to: string }) => !selectedPreviousNodeIds.has(edge.from)
    && !selectedPreviousNodeIds.has(edge.to);
  const previousIncludeEdge = (edge: { fromNodeId: string; toNodeId: string }) => !selectedPreviousNodeIds.has(edge.fromNodeId)
    && !selectedPreviousNodeIds.has(edge.toNodeId);
  const selectedCurrentRootIds = new Set(selectedCurrentRoots.map((root) => root.graphNodeId));
  const currentRootOrNode = (id: string) => selectedCurrentNodeIds.has(id) || selectedCurrentRootIds.has(id);
  const previousRootOrNode = (id: string) => selectedPreviousNodeIds.has(id)
    || previous.canonical.roots.some((root) => selectedRootIds.has(root.rootId) && root.graphNodeId === id);

  return canonicalizeGraphLock({
    ...current,
    canonical: {
      ...current.canonical,
      roots,
      nodes: [...currentNodes, ...previousNodes],
      edges: [
        ...current.canonical.edges.filter((edge) => edgeTouchesSelected(edge.from, edge.to)),
        ...previous.canonical.edges.filter(previousEdge),
      ],
      includeEdges: [
        ...current.canonical.includeEdges.filter((edge) => edgeTouchesSelected(edge.fromNodeId, edge.toNodeId)),
        ...previous.canonical.includeEdges.filter(previousIncludeEdge),
      ],
      artifacts: [...selectedCurrentArtifacts, ...previousArtifacts],
      namespacing: [
        ...current.canonical.namespacing.filter((entry) => currentRootOrNode(entry.graphNodeId)),
        ...previous.canonical.namespacing.filter((entry) => !previousRootOrNode(entry.graphNodeId)),
      ],
      overrides: [
        ...current.canonical.overrides.filter((entry) => currentRootOrNode(entry.graphNodeId) || currentRootOrNode(entry.overriddenGraphNodeId)),
        ...previous.canonical.overrides.filter((entry) => !previousRootOrNode(entry.graphNodeId) && !previousRootOrNode(entry.overriddenGraphNodeId)),
      ],
      plainNameIncumbents: [
        ...current.canonical.plainNameIncumbents.filter((entry) => currentRootOrNode(entry.graphNodeId)),
        ...previous.canonical.plainNameIncumbents.filter((entry) => !previousRootOrNode(entry.graphNodeId)),
      ],
    },
  });
}

function dependencyUpdateRootIds(lock: Awaited<ReturnType<typeof readGraphLock>>, selectors: string[]): Set<string> {
  const nodes = new Map(lock.canonical.nodes.map((node) => [node.id, node]));
  return new Set(lock.canonical.roots
    .filter((root) => {
      const node = nodes.get(root.graphNodeId);
      return root.mode === "tracking" && node
        && selectors.some((selector) => dependencyUpdateSelectorMatchesRoot(root, node, selector));
    })
    .map((root) => root.rootId));
}

function dependencyUpdateNodeIds(lock: Awaited<ReturnType<typeof readGraphLock>>, selectors: string[]): Set<string> {
  const nodes = new Map(lock.canonical.nodes.map((node) => [node.id, node]));
  const selected = new Set<string>();
  for (const root of lock.canonical.roots) {
    const node = nodes.get(root.graphNodeId);
    if (root.mode === "tracking" && node && selectors.some((selector) => dependencyUpdateSelectorMatchesRoot(root, node, selector))) {
      selected.add(root.graphNodeId);
    }
  }
  for (const selector of selectors) {
    for (const edge of lock.canonical.edges) {
      const node = nodes.get(edge.to);
      if (!node || node.mode !== "tracking") continue;
      if (selector === edge.alias || selector === edge.source || selector === edge.normalizedSource
        || selector === node.id || selector === node.name || selector === node.source || selector === node.normalizedSource) {
        selected.add(edge.to);
      }
    }
  }
  const queue = [...selected];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const edge of lock.canonical.edges) {
      if (edge.from !== parentId || selected.has(edge.to)) continue;
      selected.add(edge.to);
      queue.push(edge.to);
    }
  }
  return selected;
}

function dependencyUpdatePackageNames(lock: Awaited<ReturnType<typeof readGraphLock>>, selectors: string[]): Set<string> {
  const nodes = new Map(lock.canonical.nodes.map((node) => [node.id, node]));
  const names = new Set<string>();
  for (const selector of selectors) {
    for (const root of lock.canonical.roots) {
      const node = nodes.get(root.graphNodeId);
      if (root.mode !== "tracking" || !node) continue;
      if (dependencyUpdateSelectorMatchesRoot(root, node, selector)) {
        names.add(node.name);
      }
    }
    for (const edge of lock.canonical.edges) {
      const node = nodes.get(edge.to);
      if (!node || node.mode !== "tracking") continue;
      if (selector === edge.alias || selector === edge.source || selector === edge.normalizedSource
        || selector === node.id || selector === node.name || selector === node.source || selector === node.normalizedSource) {
        names.add(node.name);
      }
    }
  }
  return names;
}

function operationBelongsToDependencyUpdate(
  operation: InstallOperation,
  allowedNodeIds: Set<string>,
  allowedNames: Set<string>,
): boolean {
  if (operation.graphNodeId && allowedNodeIds.has(operation.graphNodeId)) return true;
  if (operation.owners?.some((owner) => allowedNodeIds.has(owner))) return true;
  return operation.composedFrom?.some((entry) =>
    [...allowedNames].some((name) => entry.selector.startsWith(`${name}@`) || entry.selector.startsWith(`${name}:`))) === true;
}

type FocusedArtifact = NonNullable<GraphCliOptions["focusedArtifact"]>;

function scopeInstallPlanToArtifact(
  result: GraphSourcePlanResult,
  rootId: string,
  focused: FocusedArtifact,
  manifest: InstallManifest | undefined,
): GraphSourcePlanResult {
  const scoped = scopePlanOperationsToArtifact(result, rootId, focused, manifest);
  const graphLock = focusedGraphLockForInstall(scoped.bundle.graphLock, rootId, focused);
  const graphLockDigest = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
  return {
    ...scoped,
    bundle: { ...scoped.bundle, graphLock },
    graphLockDigest,
    plan: { ...scoped.plan, graphLockDigest },
  };
}

function scopeUpdatePlanToArtifact(
  result: GraphSourcePlanResult,
  rootId: string,
  focused: FocusedArtifact,
  previousLock: GraphLock,
  manifest: InstallManifest | undefined,
): GraphSourcePlanResult {
  const scoped = scopePlanOperationsToArtifact(result, rootId, focused, manifest, previousLock);
  const graphLock = mergeFocusedArtifactGraphLock(scoped.bundle.graphLock, previousLock, rootId, focused);
  const graphLockDigest = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
  return {
    ...scoped,
    bundle: { ...scoped.bundle, graphLock },
    graphLockDigest,
    graphDiff: diffGraphLocks(previousLock, graphLock),
    plan: { ...scoped.plan, graphLockDigest },
  };
}

function scopePlanOperationsToArtifact(
  result: GraphSourcePlanResult,
  rootId: string,
  focused: FocusedArtifact,
  manifest: InstallManifest | undefined,
  previousLock?: GraphLock,
): GraphSourcePlanResult {
  const currentArtifacts = focusedArtifactsForRoot(result.bundle.graphLock, rootId, focused);
  const previousArtifacts = previousLock ? focusedArtifactsForRoot(previousLock, rootId, focused) : [];
  const focusedOwnerKeys = new Set([
    `workspace:${rootId}`,
    ...currentArtifacts.map((artifact) => artifact.graphNodeId),
    ...previousArtifacts.map((artifact) => artifact.graphNodeId),
  ]);
  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const plannedPaths = new Set<string>();
  const preservedPaths = new Set<string>();
  const operations: InstallOperation[] = [];

  for (const operation of result.plan.operations) {
    plannedPaths.add(operation.relativeDestPath);
    if (operationMatchesFocusedArtifact(operation, focused, focusedOwnerKeys)) {
      operations.push(operation);
      continue;
    }
    const entry = manifestByPath.get(operation.relativeDestPath);
    if (!entry || preservedPaths.has(entry.path)) continue;
    preservedPaths.add(entry.path);
    operations.push(keepManifestEntryOperation(
      entry,
      result.plan.targetRoot,
      `focused ${focused.type}/${focused.name} update`,
    ));
  }

  for (const entry of manifest?.entries ?? []) {
    if (plannedPaths.has(entry.path) || preservedPaths.has(entry.path)
      || manifestEntryMatchesFocusedArtifact(entry, focused, focusedOwnerKeys)) continue;
    preservedPaths.add(entry.path);
    operations.push(keepManifestEntryOperation(
      entry,
      result.plan.targetRoot,
      `focused ${focused.type}/${focused.name} update`,
    ));
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

function operationMatchesFocusedArtifact(
  operation: InstallOperation,
  focused: FocusedArtifact,
  ownerKeys: Set<string>,
): boolean {
  if (!matchesCanonicalFocusedArtifact(operation.artifactType, operation.artifactName, focused)) {
    return false;
  }
  if (operation.graphNodeId && ownerKeys.has(operation.graphNodeId)) return true;
  return operation.owners?.some((owner) => ownerKeys.has(owner)) === true;
}

function manifestEntryMatchesFocusedArtifact(
  entry: NonNullable<InstallManifest>["entries"][number],
  focused: FocusedArtifact,
  ownerKeys: Set<string>,
): boolean {
  if (!matchesCanonicalFocusedArtifact(entry.artifactType, entry.artifactName, focused)) {
    return false;
  }
  if ("graphNodeId" in entry && entry.graphNodeId && ownerKeys.has(entry.graphNodeId)) return true;
  const owners = "owners" in entry ? entry.owners : [entry.packageName ?? "legacy"];
  return owners.some((owner) => ownerKeys.has(owner));
}

function graphArtifactMatchesFocus(
  artifact: GraphLock["canonical"]["artifacts"][number],
  focused: FocusedArtifact,
): boolean {
  return matchesCanonicalFocusedArtifact(artifact.type, artifact.name, focused);
}

function matchesCanonicalFocusedArtifact(
  artifactType: string | undefined,
  artifactName: string | undefined,
  focused: FocusedArtifact,
): boolean {
  return artifactType === focused.type && artifactName === focused.name;
}

function focusedArtifactsForRoot(
  lock: GraphLock,
  rootId: string,
  focused: FocusedArtifact,
): GraphLock["canonical"]["artifacts"] {
  const rootNodeIds = graphRootClosure(lock, rootId);
  return lock.canonical.artifacts.filter(
    (artifact) => rootNodeIds.has(artifact.graphNodeId) && graphArtifactMatchesFocus(artifact, focused),
  );
}

function focusedGraphLockForInstall(current: GraphLock, rootId: string, focused: FocusedArtifact): GraphLock {
  const artifacts = focusedArtifactsForRoot(current, rootId, focused);
  if (artifacts.length === 0) {
    throw new Error(`Resolved graph does not contain focused artifact ${focused.type}/${focused.name} for ${rootId}.`);
  }
  const nodeIds = focusedGraphNodeIds(current, rootId, artifacts);
  return canonicalizeGraphLock({
    ...current,
    canonical: {
      ...current.canonical,
      nodes: current.canonical.nodes.filter((node) => nodeIds.has(node.id)),
      edges: current.canonical.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
      includeEdges: usedIncludeEdges(current, artifacts).filter(
        (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
      ),
      artifacts,
      namespacing: current.canonical.namespacing.filter((entry) => decisionMatchesFocusedArtifacts(entry, artifacts)),
      overrides: current.canonical.overrides.filter((entry) => decisionMatchesFocusedArtifacts(entry, artifacts)),
      plainNameIncumbents: current.canonical.plainNameIncumbents.filter((entry) => decisionMatchesFocusedArtifacts(entry, artifacts)),
    },
  });
}

function mergeFocusedArtifactGraphLock(
  current: GraphLock,
  previous: GraphLock,
  rootId: string,
  focused: FocusedArtifact,
): GraphLock {
  const currentFocused = focusedArtifactsForRoot(current, rootId, focused);
  if (currentFocused.length === 0) {
    throw new Error(`Resolved graph does not contain focused artifact ${focused.type}/${focused.name} for ${rootId}.`);
  }
  const previousFocused = focusedArtifactsForRoot(previous, rootId, focused);
  const previousFocusedKeys = new Set(previousFocused.map(graphArtifactIdentity));
  const previousPreserved = previous.canonical.artifacts.filter(
    (artifact) => !previousFocusedKeys.has(graphArtifactIdentity(artifact)),
  );
  const currentNodeIds = focusedGraphNodeIds(current, rootId, currentFocused);
  const previousNodeIds = preservedGraphNodeIds(previous, rootId, previousPreserved);
  const currentRoot = current.canonical.roots.find((root) => root.rootId === rootId);
  if (!currentRoot) throw new Error(`Resolved graph root not found for focused update: ${rootId}`);
  const roots = previous.canonical.roots.map((root) => root.rootId === rootId ? currentRoot : root);
  if (!roots.some((root) => root.rootId === rootId)) roots.push(currentRoot);
  const currentIncludes = usedIncludeEdges(current, currentFocused);
  const previousIncludes = usedIncludeEdges(previous, previousPreserved);

  return canonicalizeGraphLock({
    ...current,
    canonical: {
      ...current.canonical,
      roots,
      nodes: uniqueBy(
        [
          ...current.canonical.nodes.filter((node) => currentNodeIds.has(node.id)),
          ...previous.canonical.nodes.filter((node) => previousNodeIds.has(node.id)),
        ],
        (node) => node.id,
      ),
      edges: uniqueBy(
        [
          ...current.canonical.edges.filter((edge) => currentNodeIds.has(edge.from) && currentNodeIds.has(edge.to)),
          ...previous.canonical.edges.filter((edge) => previousNodeIds.has(edge.from) && previousNodeIds.has(edge.to)),
        ],
        (edge) => `${edge.from}\0${edge.alias}\0${edge.to}`,
      ),
      includeEdges: uniqueBy(
        [...currentIncludes, ...previousIncludes],
        (edge) => `${edge.fromNodeId}\0${edge.alias}\0${edge.toNodeId}\0${edge.selector}\0${edge.sourceHash}`,
      ),
      artifacts: [...currentFocused, ...previousPreserved],
      namespacing: [
        ...current.canonical.namespacing.filter((entry) => decisionMatchesFocusedArtifacts(entry, currentFocused)),
        ...previous.canonical.namespacing.filter((entry) => !decisionMatchesFocusedArtifacts(entry, previousFocused)),
      ],
      overrides: [
        ...current.canonical.overrides.filter((entry) => decisionMatchesFocusedArtifacts(entry, currentFocused)),
        ...previous.canonical.overrides.filter((entry) => !decisionMatchesFocusedArtifacts(entry, previousFocused)),
      ],
      plainNameIncumbents: [
        ...current.canonical.plainNameIncumbents.filter((entry) => decisionMatchesFocusedArtifacts(entry, currentFocused)),
        ...previous.canonical.plainNameIncumbents.filter((entry) => !decisionMatchesFocusedArtifacts(entry, previousFocused)),
      ],
    },
  });
}

function focusedGraphNodeIds(
  lock: GraphLock,
  rootId: string,
  artifacts: GraphLock["canonical"]["artifacts"],
): Set<string> {
  const root = lock.canonical.roots.find((candidate) => candidate.rootId === rootId);
  if (!root) throw new Error(`Resolved graph root not found for focused update: ${rootId}`);
  const targets = artifactReferencedNodeIds(lock, artifacts);
  targets.add(root.graphNodeId);
  return graphAncestorPaths(lock, root.graphNodeId, targets);
}

function preservedGraphNodeIds(
  lock: GraphLock,
  replacedRootId: string,
  artifacts: GraphLock["canonical"]["artifacts"],
): Set<string> {
  const selected = artifactReferencedNodeIds(lock, artifacts);
  const replacedRoot = lock.canonical.roots.find((root) => root.rootId === replacedRootId);
  if (replacedRoot) {
    const replacedRootClosure = graphRootClosure(lock, replacedRootId);
    for (const artifact of artifacts) {
      if (!replacedRootClosure.has(artifact.graphNodeId)) continue;
      for (const nodeId of graphAncestorPaths(lock, replacedRoot.graphNodeId, new Set([artifact.graphNodeId]))) {
        selected.add(nodeId);
      }
    }
  }
  for (const root of lock.canonical.roots) {
    if (root.rootId === replacedRootId) continue;
    for (const nodeId of graphRootClosure(lock, root.rootId)) selected.add(nodeId);
  }
  return selected;
}

function artifactReferencedNodeIds(
  lock: GraphLock,
  artifacts: GraphLock["canonical"]["artifacts"],
): Set<string> {
  const selected = new Set(artifacts.map((artifact) => artifact.graphNodeId));
  const includes = usedIncludeEdges(lock, artifacts);
  for (const edge of includes) {
    selected.add(edge.fromNodeId);
    selected.add(edge.toNodeId);
  }
  return selected;
}

function usedIncludeEdges(
  lock: GraphLock,
  artifacts: GraphLock["canonical"]["artifacts"],
): GraphLock["canonical"]["includeEdges"] {
  const selectors = new Set(artifacts.flatMap((artifact) => artifact.composedFrom?.map((entry) => entry.selector) ?? []));
  return lock.canonical.includeEdges.filter((edge) => selectors.has(`${edge.toNodeId}:${edge.selector}`));
}

function graphAncestorPaths(lock: GraphLock, rootNodeId: string, targets: Set<string>): Set<string> {
  const selected = new Set<string>(targets);
  selected.add(rootNodeId);
  const queue = [...targets];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (nodeId === rootNodeId) continue;
    for (const edge of lock.canonical.edges) {
      if (edge.to !== nodeId || selected.has(edge.from)) continue;
      selected.add(edge.from);
      queue.push(edge.from);
    }
  }
  return selected;
}

function graphArtifactIdentity(artifact: GraphLock["canonical"]["artifacts"][number]): string {
  return `${artifact.graphNodeId}\0${artifact.type}\0${artifact.name}\0${artifact.installName}`;
}

function decisionMatchesFocusedArtifacts(
  entry: { graphNodeId: string; type: string; name: string; installName?: string; selector?: string },
  artifacts: GraphLock["canonical"]["artifacts"],
): boolean {
  return artifacts.some((artifact) => entry.graphNodeId === artifact.graphNodeId
    && entry.type === artifact.type
    && (entry.name === artifact.name
      || entry.installName === artifact.installName
      || entry.selector === artifact.logicalSelector));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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
    const transformed = transformOutOfScopeOperation(operation, entry, result.plan.targetRoot, `scoped install ${rootId}`);
    for (const scopedOperation of transformed) {
      if (preservedPaths.has(scopedOperation.relativeDestPath)) continue;
      preservedPaths.add(scopedOperation.relativeDestPath);
      operations.push(scopedOperation);
    }
  }

  for (const entry of manifest?.entries ?? []) {
    if (plannedPaths.has(entry.path) || preservedPaths.has(entry.path) || entryBelongsToScopedRoot(entry, scopedOwners)) continue;
    preservedPaths.add(entry.path);
    operations.push(keepManifestEntryOperation(entry, result.plan.targetRoot, `scoped install ${rootId}`));
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

function scopeUpdatePlanToRoot(
  result: GraphSourcePlanResult,
  rootId: string,
  previousLock: GraphLock,
  manifest: InstallManifest | undefined,
): GraphSourcePlanResult {
  const scoped = scopeInstallPlanToRoot(result, rootId, manifest);
  const selectedCurrentNodeIds = graphRootClosure(scoped.bundle.graphLock, rootId);
  const selectedPreviousNodeIds = graphRootClosure(previousLock, rootId);
  const graphLock = preserveUnrelatedGraphPackages(
    scoped.bundle.graphLock,
    previousLock,
    selectedCurrentNodeIds,
    selectedPreviousNodeIds,
    new Set([rootId]),
  );
  const graphLockDigest = createHash("sha256").update(canonicalGraphLockJson(graphLock)).digest("hex");
  return {
    ...scoped,
    bundle: { ...scoped.bundle, graphLock },
    graphLockDigest,
    graphDiff: diffGraphLocks(previousLock, graphLock),
    plan: {
      ...scoped.plan,
      graphLockDigest,
    },
  };
}

function graphRootClosure(lock: GraphLock, rootId: string): Set<string> {
  const root = lock.canonical.roots.find((candidate) => candidate.rootId === rootId);
  if (!root) return new Set();
  const selected = new Set<string>();
  const queue = [root.graphNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (selected.has(nodeId)) continue;
    selected.add(nodeId);
    for (const edge of lock.canonical.edges) {
      if (edge.from === nodeId) queue.push(edge.to);
    }
  }
  return selected;
}

function transformOutOfScopeOperation(
  operation: InstallOperation,
  entry: NonNullable<InstallManifest>["entries"][number] | undefined,
  targetRoot: string,
  scopeDescription: string,
): InstallOperation[] {
  if (operation.action === "skip") return [operation];
  if (operation.action === "update" || operation.action === "drift") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, scopeDescription, operation, { freshMetadata: true })] : [];
  }
  if (operation.action === "remove") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, scopeDescription)] : [];
  }
  if (operation.action === "plugin" || operation.action === "program") {
    return entry ? [keepManifestEntryOperation(entry, targetRoot, scopeDescription)] : [];
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
  scopeDescription: string,
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
    reason: `preserved outside ${scopeDescription}`,
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
          version: pkg.version,
          ref: pkg.requestedRef,
          select: pkg.selection ? undefined : normalizeArtifactSelectors(pkg.select, pkg.skills),
          selection: pkg.selection,
          aliases: pkg.aliases,
          overrides: pkg.overrides,
          includeSuggestions: options.withSuggestions === true || pkg.withSuggestions === true,
          suggestionAliases: packageSuggestionAliases(pkg, options),
        })),
        targetRoot: remainingGroup.target.targetRoot,
        workspaceRoot: remainingGroup.target.workspaceRoot,
        fleetId: remainingGroup.target.fleetId,
        adapter: remainingAdapter,
        transport,
        targetKey: targetKeyForTarget(remainingGroup.target, remainingAdapter.name),
        targetFingerprintParts: targetFingerprintParts(remainingGroup.target, remainingAdapter, remainingGroup.adapterOptions, remainingGroup.installationType),
        installationType: remainingGroup.installationType,
        includeSuggestions: options.withSuggestions,
        suggestionAliases: suggestionAliasesFromOptions(options),
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
    fleetId: target.fleetId,
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
    fleetId: target.fleetId,
    installationType: installationType ?? target.installationType ?? "local",
    adapterConfig: options.adapterConfig,
    adapterModule: options.adapterModule,
    adapterCodeHash: adapter.programmatic?.hash,
    agentName: target.agentName,
    targetRoot: target.targetRoot,
    transport: target.transport,
    ssh: target.ssh,
    stateKey: target.stateKey,
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
    stateKey: stateKeyFor(adapter.name, {
      installationType,
      stateKey: target.stateKey,
      targetFingerprint,
      fleetId: target.fleetId,
    }),
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
  const report = await collectTargetStatus(target, options);
  printTargetStatus(report);
}

async function collectTargetStatus(target: RuntimeTarget, options: GraphCliOptions): Promise<StatusTarget> {
  const config = await readMergedWorkspaceConfig(target.workspaceRoot);
  const adapterOptions = adapterOptionsForTarget(target, options);
  const adapter = await resolveAdapterForTarget(target, { ...adapterOptions, warn: () => undefined });
  const transport = transportForTarget(target);
  const installationType = options.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
  const state = installStateForTarget(target, adapter, adapterOptions, installationType);
  const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
  let graphLockPath: string | null = null;
  let graphLock: GraphLock | undefined;
  try {
    const result = await readTargetGraphLock(target, adapterOptions);
    graphLockPath = result.path;
    graphLock = result.lock;
  } catch {
    graphLock = undefined;
  }

  const packages: StatusPackage[] = [];
  for (const pkg of config.packages) {
    const root = graphLock?.canonical.roots.find((candidate) => candidate.rootId === pkg.name);
    const node = root ? graphLock?.canonical.nodes.find((candidate) => candidate.id === root.graphNodeId) : undefined;
    const availability = await discoverPackageVersions(pkg, target.workspaceRoot, {
      forceRefresh: options.refresh,
      offline: options.offline,
    });
    const installed = node && manifest?.entries.some((entry) => "graphNodeId" in entry && entry.graphNodeId === node.id)
      ? node.version
      : null;
    const locked = node?.version ?? null;
    const baseline = installed ?? locked;
    packages.push({
      name: pkg.name,
      source: pkg.source,
      mode: pkg.mode,
      policy: pkg.version ?? "*",
      installed,
      locked,
      latestAllowed: availability.latestAllowed,
      latestOverall: availability.latestOverall,
      availability: availability.stale ? "STALE" : availability.checkedAt ? "FRESH" : "UNKNOWN",
      checkedAt: availability.checkedAt,
      ...(availability.error ? { error: availability.error } : {}),
      updateAvailableAllowed: Boolean(
        baseline
        && availability.latestAllowed
        && compareSemverStrings(availability.latestAllowed, baseline) > 0,
      ),
      updateAvailableOverall: Boolean(
        baseline
        && availability.latestOverall
        && compareSemverStrings(availability.latestOverall, baseline) > 0,
      ),
    });
  }

  const pending = await collectPendingInstallWork(target, options);
  const artifacts = (graphLock?.canonical.artifacts ?? []).map((artifact) => {
    const node = graphLock?.canonical.nodes.find((candidate) => candidate.id === artifact.graphNodeId);
    const installed = manifest?.entries.some((entry) => {
      if (!("graphNodeId" in entry) || entry.graphNodeId !== artifact.graphNodeId) return false;
      if ("logicalSelector" in entry && entry.logicalSelector) return entry.logicalSelector === artifact.logicalSelector;
      return entry.artifactType === artifact.type && entry.artifactName === artifact.name;
    }) ?? false;
    return {
      selector: artifact.logicalSelector,
      type: artifact.type,
      name: artifact.name,
      installName: artifact.installName,
      packageName: node?.name ?? null,
      packageVersion: node?.version ?? null,
      hash: artifact.hash,
      installed,
    };
  });
  const health: StatusHealth[] = [];
  if (!manifest || !graphLock) health.push("FAIL");
  if (pending.error) health.push("DEGRADED");
  if (pending.driftCount > 0 || pending.conflictCount > 0) health.push("FAIL");
  else if (pending.pendingCount > 0) health.push("WARN");
  if (packages.some((pkg) => pkg.availability === "STALE" || pkg.error)) health.push("DEGRADED");
  else if (packages.some((pkg) => pkg.updateAvailableAllowed || pkg.updateAvailableOverall)) health.push("WARN");

  return {
    adapter: adapter.name,
    installationType,
    targetRoot: state.installRoot,
    health: worstStatusHealth(health),
    manifestRevision: manifest?.revision ?? null,
    manifestEntryCount: manifest?.entries.length ?? 0,
    graphLockPath,
    packageCount: packages.length,
    artifactCount: graphLock?.canonical.artifacts.length ?? 0,
    pendingCount: pending.pendingCount,
    driftCount: pending.driftCount,
    conflictCount: pending.conflictCount,
    ...(pending.error ? { error: pending.error } : {}),
    packages,
    artifacts,
  };
}

async function resolveSelectedCompositeProfile(options: GraphCliOptions): Promise<{
  workspaceRoot: string;
  name: string;
  profile: Extract<WorkspaceProfile, { members: unknown[] }>;
} | undefined> {
  const workspaceRoot = (await resolveCliWorkspaceScope(options)).root;
  const config = await readMergedWorkspaceConfig(workspaceRoot);
  const name = options.profile ?? (options.all && config.profiles.all ? "all" : undefined);
  if (!name) return undefined;
  const profile = config.profiles[name];
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  if (!isCompositeWorkspaceProfile(profile)) return undefined;
  const chain = parseCompositeChain();
  assertNoCompositeCycle(workspaceRoot, name, chain);
  return { workspaceRoot, name, profile };
}

async function collectCompositeStatus(
  workspaceRoot: string,
  profileName: string,
  profile: Extract<WorkspaceProfile, { members: unknown[] }>,
  options: GraphCliOptions,
): Promise<StatusReport> {
  const chain = parseCompositeChain();
  const members = await collectCompositeMembers({
    cliVersion: CLI_VERSION,
    workspaceRoot,
    profileName,
    profileTtlSeconds: profile.refreshTtlSeconds,
    members: profile.members,
    refresh: options.refresh,
    offline: options.offline,
    chain,
  });
  const repository = await collectRepositoryStatus(workspaceRoot);
  const repositoryHealth: StatusHealth = repository.available
    && repository.ahead === 0
    && repository.behind === 0
    && repository.dirtyCount === 0
    ? "PASS"
    : "WARN";
  return {
    schemaVersion: 1,
    command: "status",
    agentwheelVersion: CLI_VERSION,
    generatedAt: new Date().toISOString(),
    workspace: workspaceRoot,
    profile: profileName,
    health: worstStatusHealth([...members.map((member) => member.health), repositoryHealth]),
    repository,
    targets: [],
    members,
  };
}

async function runCompositeUpdate(
  workspaceRoot: string,
  profileName: string,
  profile: Extract<WorkspaceProfile, { members: unknown[] }>,
  packageName: string | undefined,
  options: GraphCliOptions,
): Promise<void> {
  const preflight = await collectCompositeStatus(workspaceRoot, profileName, profile, options);
  printStatusReport(preflight);
  const blockers = preflight.members.filter((member) => blocksCompositeApply(member.health));
  if (blockers.length > 0) {
    throw new Error(
      `Composite update blocked before member execution: `
      + blockers.map((member) => `${member.id}=${member.health}`).join(", "),
    );
  }

  const incomingChain = parseCompositeChain();
  const memberChain = [...incomingChain, compositeKey(workspaceRoot, profileName)];
  for (const member of profile.members) {
    if (!options.dryRun) {
      const before = preflight.members.find((candidate) => candidate.id === member.id);
      const revalidated = await collectCompositeMembers({
        cliVersion: CLI_VERSION,
        workspaceRoot,
        profileName,
        profileTtlSeconds: profile.refreshTtlSeconds,
        members: [member],
        refresh: true,
        chain: incomingChain,
      });
      const current = revalidated[0]!;
      if (blocksCompositeApply(current.health)) {
        throw new Error(`Composite update stopped before ${member.id}: revalidation is ${current.health}.`);
      }
      if (statusRevisionSignature(before?.report) !== statusRevisionSignature(current.report)) {
        throw new Error(`Composite update stopped before ${member.id}: member revision changed after preflight.`);
      }
    }

    const args = compositeUpdateArguments(member.profile, packageName, options);
    console.log(`${options.dryRun ? "Plan" : "Update"} member ${member.id}:`);
    const result = await runMemberAgentwheel(member, workspaceRoot, args, memberChain);
    if (result.stdout.trim()) console.log(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  }
}

async function runCompositeSkillUpdate(
  workspaceRoot: string,
  profileName: string,
  profile: Extract<WorkspaceProfile, { members: unknown[] }>,
  skillName: string,
  packageName: string | undefined,
  options: GraphCliOptions,
): Promise<void> {
  const preflight = await collectCompositeStatus(workspaceRoot, profileName, profile, options);
  printStatusReport(preflight);
  const blockers = preflight.members.filter((member) => blocksCompositeApply(member.health));
  if (blockers.length > 0) {
    throw new Error(
      "Composite skill update blocked before member execution: "
      + blockers.map((member) => `${member.id}=${member.health}`).join(", "),
    );
  }

  const incomingChain = parseCompositeChain();
  const memberChain = [...incomingChain, compositeKey(workspaceRoot, profileName)];
  for (const member of profile.members) {
    if (!options.dryRun) {
      const before = preflight.members.find((candidate) => candidate.id === member.id);
      const revalidated = await collectCompositeMembers({
        cliVersion: CLI_VERSION,
        workspaceRoot,
        profileName,
        profileTtlSeconds: profile.refreshTtlSeconds,
        members: [member],
        refresh: true,
        chain: incomingChain,
      });
      const current = revalidated[0]!;
      if (blocksCompositeApply(current.health)) {
        throw new Error(`Composite skill update stopped before ${member.id}: revalidation is ${current.health}.`);
      }
      if (statusRevisionSignature(before?.report) !== statusRevisionSignature(current.report)) {
        throw new Error(`Composite skill update stopped before ${member.id}: member revision changed after preflight.`);
      }
    }

    const args = compositeSkillUpdateArguments(member.profile, skillName, packageName, options);
    console.log(`${options.dryRun ? "Plan" : "Update"} member ${member.id}:`);
    const result = await runMemberAgentwheel(member, workspaceRoot, args, memberChain);
    if (result.stdout.trim()) console.log(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  }
}

async function runCompositeInstall(
  workspaceRoot: string,
  profileName: string,
  profile: Extract<WorkspaceProfile, { members: unknown[] }>,
  nameOrSource: string | undefined,
  options: GraphCliOptions,
  behavior: { apply: boolean },
): Promise<void> {
  const preflight = await collectCompositeStatus(workspaceRoot, profileName, profile, options);
  printStatusReport(preflight);
  const blockers = preflight.members.filter((member) => blocksCompositeApply(member.health));
  if (blockers.length > 0) {
    throw new Error(
      `Composite ${behavior.apply ? "install" : "plan"} blocked before member execution: `
      + blockers.map((member) => `${member.id}=${member.health}`).join(", "),
    );
  }

  const incomingChain = parseCompositeChain();
  const memberChain = [...incomingChain, compositeKey(workspaceRoot, profileName)];
  for (const member of profile.members) {
    if (behavior.apply) {
      const before = preflight.members.find((candidate) => candidate.id === member.id);
      const revalidated = await collectCompositeMembers({
        cliVersion: CLI_VERSION,
        workspaceRoot,
        profileName,
        profileTtlSeconds: profile.refreshTtlSeconds,
        members: [member],
        refresh: true,
        chain: incomingChain,
      });
      const current = revalidated[0]!;
      if (blocksCompositeApply(current.health)) {
        throw new Error(`Composite install stopped before ${member.id}: revalidation is ${current.health}.`);
      }
      if (statusRevisionSignature(before?.report) !== statusRevisionSignature(current.report)) {
        throw new Error(`Composite install stopped before ${member.id}: member revision changed after preflight.`);
      }
    }

    const args = compositeInstallArguments(member.profile, nameOrSource, options, behavior.apply);
    console.log(`${behavior.apply ? "Install" : "Plan"} member ${member.id}:`);
    const result = await runMemberAgentwheel(member, workspaceRoot, args, memberChain);
    if (result.stdout.trim()) console.log(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  }
}

function compositeInstallArguments(
  profile: string,
  nameOrSource: string | undefined,
  options: GraphCliOptions,
  apply: boolean,
): string[] {
  const args = [apply ? "install" : "plan"];
  if (nameOrSource) args.push(nameOrSource);
  args.push("--profile", profile);
  if (options.refresh) args.push("--refresh");
  if (options.forceDrift) args.push("--force-drift");
  if (options.forceForeignState) args.push("--force-foreign-state");
  if (options.forceConflict) args.push("--force-conflict");
  if (options.replaceConflict) args.push("--replace-conflict");
  if (options.executePlugins) args.push("--execute-plugins");
  if (shouldReloadRuntimes(options)) args.push("--reload-runtimes");
  if (options.noDeps) args.push("--no-deps");
  if (options.frozenLock) args.push("--frozen-lock");
  if (options.onlySource) args.push("--only-source");
  for (const selection of options.select ?? []) args.push("--select", selection);
  for (const skill of options.skill ?? []) args.push("--skill", skill);
  for (const trust of options.trust ?? []) args.push("--trust", trust);
  if (options.yes) args.push("--yes");
  return args;
}

function compositeUpdateArguments(profile: string, packageName: string | undefined, options: GraphCliOptions): string[] {
  const args = ["update"];
  if (packageName) args.push(packageName);
  args.push("--profile", profile);
  if (options.dryRun) args.push("--dry-run");
  if (options.refresh) args.push("--refresh");
  if (options.forceDrift) args.push("--force-drift");
  if (options.forceForeignState) args.push("--force-foreign-state");
  if (options.forceConflict) args.push("--force-conflict");
  if (options.replaceConflict) args.push("--replace-conflict");
  if (options.executePlugins) args.push("--execute-plugins");
  if (shouldReloadRuntimes(options)) args.push("--reload-runtimes");
  if (options.noDeps) args.push("--no-deps");
  if (options.frozenLock) args.push("--frozen-lock");
  for (const dependency of options.dependency ?? []) args.push("--dependency", dependency);
  for (const trust of options.trust ?? []) args.push("--trust", trust);
  if (options.yes) args.push("--yes");
  return args;
}

function compositeSkillUpdateArguments(
  profile: string,
  skillName: string,
  packageName: string | undefined,
  options: GraphCliOptions,
): string[] {
  const args = ["skill", "update", skillName, "--profile", profile];
  if (packageName) args.push("--package", packageName);
  if (options.dryRun) args.push("--dry-run");
  if (options.adopt) args.push("--adopt");
  if (options.refresh) args.push("--refresh");
  if (options.forceDrift) args.push("--force-drift");
  if (options.forceForeignState) args.push("--force-foreign-state");
  if (options.allowAdapterCode) args.push("--allow-adapter-code");
  if (options.noDeps) args.push("--no-deps");
  if (options.frozenLock) args.push("--frozen-lock");
  if (options.offline) args.push("--offline");
  for (const trust of options.trust ?? []) args.push("--trust", trust);
  if (options.yes) args.push("--yes");
  return args;
}

function statusRevisionSignature(report: StatusReport | undefined): string {
  if (!report) return "missing";
  return JSON.stringify({
    profile: report.profile,
    repository: {
      head: report.repository.head,
      ahead: report.repository.ahead,
      behind: report.repository.behind,
      dirtyCount: report.repository.dirtyCount,
    },
    targets: report.targets.map((target) => ({
      adapter: target.adapter,
      installationType: target.installationType,
      targetRoot: target.targetRoot,
      manifestRevision: target.manifestRevision,
      graphLockPath: target.graphLockPath,
      packages: target.packages.map((pkg) => ({
        name: pkg.name,
        installed: pkg.installed,
        locked: pkg.locked,
        latestAllowed: pkg.latestAllowed,
        latestOverall: pkg.latestOverall,
      })),
    })),
    members: report.members.map((member) => ({
      id: member.id,
      report: statusRevisionSignature(member.report),
    })),
  });
}

async function statusReport(workspace: string, profile: string | null, targets: StatusTarget[]): Promise<StatusReport> {
  const repository = await collectRepositoryStatus(workspace);
  const repositoryHealth: StatusHealth = repository.available
    && repository.ahead === 0
    && repository.behind === 0
    && repository.dirtyCount === 0
    ? "PASS"
    : "WARN";
  return {
    schemaVersion: 1,
    command: "status",
    agentwheelVersion: CLI_VERSION,
    generatedAt: new Date().toISOString(),
    workspace,
    profile,
    health: worstStatusHealth([...targets.map((target) => target.health), repositoryHealth]),
    repository,
    targets,
    members: [],
  };
}

function printStatusReport(report: StatusReport): void {
  console.log(`Status ${report.health} for profile ${report.profile ?? "(direct)"} at ${report.workspace}`);
  console.log(
    `Repository: ${report.repository.available ? report.repository.branch ?? "detached" : "unavailable"}`
    + `; ahead=${report.repository.ahead}; behind=${report.repository.behind}; dirty=${report.repository.dirtyCount}`,
  );
  if (report.members.length > 0) {
    console.log("MEMBER\tTRANSPORT\tPROFILE\tVERSION\tHEALTH\tCACHE");
    for (const member of report.members) {
      console.log([
        member.id,
        member.transport,
        member.profile,
        member.agentwheelVersion ?? "unknown",
        member.health,
        member.stale ? "stale" : "fresh",
      ].join("\t"));
      if (member.error) console.log(`  ${member.error}`);
    }
  }
  for (const target of report.targets) printTargetStatus(target);
}

function printTargetStatus(target: StatusTarget): void {
  console.log(`Status for ${target.adapter}/${target.installationType} at ${target.targetRoot} (health: ${target.health})`);
  console.log(target.manifestRevision
    ? `Install manifest: ${target.manifestEntryCount} entries, revision ${target.manifestRevision}`
    : "Install manifest: missing");
  console.log(target.graphLockPath
    ? `Graph lock: ${target.graphLockPath} (${target.artifactCount} artifacts)`
    : "Graph lock: missing");
  console.log("PACKAGE\tMODE\tPOLICY\tINSTALLED\tLOCKED\tLATEST ALLOWED\tLATEST OVERALL\tSTATUS");
  for (const pkg of target.packages) {
    console.log([
      pkg.name,
      pkg.mode,
      pkg.policy,
      pkg.installed ?? "-",
      pkg.locked ?? "-",
      pkg.latestAllowed ?? "-",
      pkg.latestOverall ?? "-",
      pkg.availability,
    ].join("\t"));
  }
  console.log(`Artifacts: ${target.artifactCount} locked, ${target.artifacts.filter((artifact) => artifact.installed).length} installed`);
  if (target.error) console.log(`Pending install work: unavailable (${target.error})`);
  else if (target.pendingCount === 0) console.log("Pending install work: none");
  else console.log(`Pending install work: ${target.pendingCount} (drift=${target.driftCount}, conflict=${target.conflictCount})`);
}

async function journalStateForTarget(target: RuntimeTarget, options: GraphCliOptions) {
  const adapterOptions = adapterOptionsForTarget(target, options);
  const adapter = await resolveAdapterForTarget(target, adapterOptions);
  const transport = transportForTarget(target);
  const installationType = options.installationType ?? target.installationType ?? resolveInstallationTypeForAdapter(adapter);
  const state = installStateForTarget(target, adapter, adapterOptions, installationType);
  return { adapter, transport, installationType, installRoot: state.installRoot, state };
}

async function printPendingInstallWork(target: RuntimeTarget, options: GraphCliOptions): Promise<void> {
  const pending = await collectPendingInstallWork(target, options);
  if (pending.error) {
    console.log(`Pending install work: unavailable (${pending.error})`);
    return;
  }
  if (pending.pendingCount === 0) {
    console.log("Pending install work: none");
    return;
  }
  const counts = Object.entries(pending.counts).map(([action, count]) => `${action}=${count}`).join(", ");
  const blocking = pending.driftCount + pending.conflictCount;
  console.log(`Pending install work: ${pending.pendingCount} operations (${counts}${blocking ? `; blocking=${blocking}` : ""})`);
}

async function collectPendingInstallWork(target: RuntimeTarget, options: GraphCliOptions): Promise<{
  pendingCount: number;
  driftCount: number;
  conflictCount: number;
  counts: Record<string, number>;
  error?: string;
}> {
  let results: GraphSourcePlanResult[] = [];
  try {
    results = await buildGraphPlansForTarget(
      target,
      undefined,
      { ...options, dryRun: true, warn: options.warn ?? (() => undefined) },
      { mode: "install" },
    );
    const operations = results.flatMap((result) => result.plan.operations);
    const pending = operations.filter(isPendingInstallOperation);
    const counts = Object.fromEntries([...pending.reduce((map, operation) => {
      map.set(operation.action, (map.get(operation.action) ?? 0) + 1);
      return map;
    }, new Map<string, number>())]);
    return {
      pendingCount: pending.length,
      driftCount: counts.drift ?? 0,
      conflictCount: counts.conflict ?? 0,
      counts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pendingCount: 0, driftCount: 0, conflictCount: 0, counts: {}, error: message };
  } finally {
    await Promise.all(results.map((result) => rm(result.bundle.root, { recursive: true, force: true })));
  }
}

async function printDoctor(
  target: RuntimeTarget,
  options: RuntimeScopeOptions & { adapterConfig?: string; adapterModule?: string; allowAdapterCode?: boolean; skill?: string[]; source?: string; json?: boolean },
): Promise<void> {
  const adapterOptions = adapterOptionsForTarget(target, options);
  const adapter = await resolveAdapterForTarget(target, adapterOptions);
  const installationType = options.installationType ?? target.installationType ?? resolveInstallationTypeForArtifacts(adapter, ["skills"]);
  const targetMapping = targetMappingForArtifact(adapter, "skills", installationType);
  if (!targetMapping?.enabled) {
    throw new Error(`Adapter ${adapter.name} does not support skills for installation type '${installationType}'.`);
  }
  const transport = transportForTarget(target);
  const state = installStateForTarget(target, adapter, adapterOptions, installationType);
  const manifest = await readInstallManifest(state.installRoot, adapter.name, transport, state);
  const requestedSkills = doctorSkillRequests(target, options);
  const skills = [];
  for (const request of requestedSkills) {
    const skillPath = join(state.installRoot, targetMapping.dest, request.name);
    const exists = await pathExists(skillPath);
    const manifestEntry = manifest?.entries.find((entry) => {
      if (entry.artifactType !== "skills") return false;
      const legacyInstallName = "installName" in entry && typeof entry.installName === "string" ? entry.installName : undefined;
      return entry.artifactName === request.name
        || legacyInstallName === request.name
        || entry.path === join(targetMapping.dest, request.name);
    });
    const status = manifestEntry ? "managed" : exists ? "present-unmanaged" : "missing";
    skills.push({
      name: request.name,
      source: request.source,
      label: request.label,
      status,
      path: skillPath,
      managed: Boolean(manifestEntry),
      present: exists,
      suggestedCommands: status === "missing"
        ? {
            dryRun: skillInstallCommand(adapter.name, installationType, options, request, { dryRun: true }),
            apply: skillInstallCommand(adapter.name, installationType, options, request),
          }
        : undefined,
    });
  }

  const report = {
    adapter: adapter.name,
    installationType,
    targetRoot: target.targetRoot,
    installRoot: state.installRoot,
    manifest: manifest ? { entries: manifest.entries.length, revision: manifest.revision } : null,
    skills,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Doctor for ${adapter.name}/${installationType} at ${state.installRoot}`);
  for (const skill of skills) {
    const statusLabel = skill.status === "managed" ? "installed" : skill.status === "present-unmanaged" ? "installed (unmanaged)" : "missing";
    console.log(`${skill.label}: ${statusLabel} at ${skill.path}`);
  }
  const missing = skills.filter((skill) => skill.status === "missing");
  if (missing.length > 0) {
    console.log("Suggested commands:");
    for (const skill of missing) {
      console.log(`  ${skill.suggestedCommands?.dryRun}`);
      console.log(`  ${skill.suggestedCommands?.apply}`);
    }
  }
}

interface DoctorSkillRequest {
  name: string;
  source: string;
  label: string;
}

function doctorSkillRequests(target: RuntimeTarget, options: { skill?: string[]; source?: string }): DoctorSkillRequest[] {
  const explicitSkills = normalizeDoctorSkillNames(options.skill ?? []);
  if (explicitSkills.length > 0) {
    return explicitSkills.map((name) => ({
      name,
      source: options.source ?? defaultSourceForSkill(name),
      label: doctorSkillLabel(name),
    }));
  }

  const requests: DoctorSkillRequest[] = [{
    name: COMPANION_SKILL_NAME,
    source: COMPANION_SKILL_SOURCE,
    label: "Agentwheel companion skill",
  }];
  if (isSyncwheelWorkspace(target.targetRoot)) {
    requests.push({
      name: "syncwheel",
      source: "github:NestDevLab/syncwheel",
      label: "Syncwheel skill",
    });
  }
  return requests;
}

function normalizeDoctorSkillNames(skills: string[]): string[] {
  return [...new Set(skills.flatMap(splitSelectorList).map((item) => item.trim()).filter(Boolean))];
}

function defaultSourceForSkill(name: string): string {
  if (name === COMPANION_SKILL_NAME) return COMPANION_SKILL_SOURCE;
  if (name === "syncwheel") return "github:NestDevLab/syncwheel";
  return `github:NestDevLab/${name}`;
}

function doctorSkillLabel(name: string): string {
  if (name === COMPANION_SKILL_NAME) return "Agentwheel companion skill";
  if (name === "syncwheel") return "Syncwheel skill";
  return `${name} skill`;
}

function isSyncwheelWorkspace(targetRoot: string): boolean {
  return existsSync(join(targetRoot, ".syncwheel", "manifest.json"));
}

function skillInstallCommand(
  adapter: string,
  installationType: string,
  options: RuntimeScopeOptions,
  skill: DoctorSkillRequest,
  behavior: { dryRun?: boolean } = {},
): string {
  const args = [
    "agentwheel",
    "install",
    skill.source,
    "--adapter",
    adapter,
    ...(options.targetRoot && installationType === "local" ? [] : installationTypeCommandArgs(installationType)),
    ...targetRootCommandArgs(options),
    "--skill",
    skill.name,
  ];
  if (behavior.dryRun) args.push("--dry-run");
  return args.map(shellQuoteArg).join(" ");
}

function installationTypeCommandArgs(installationType: string): string[] {
  if (installationType === "user") return ["--user"];
  if (installationType === "local") return ["--local"];
  return ["--installation-type", installationType];
}

function targetRootCommandArgs(options: RuntimeScopeOptions): string[] {
  return options.targetRoot && options.installationType !== "user" ? ["--target-root", options.targetRoot] : [];
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function collectSelectOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, got: ${value}`);
  return parsed;
}

function collectSkillOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function collectSuggestionOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function collectTrustOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectValueOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectDependencyOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function sortedUniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function collectOverrideOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

function collectTagOption(value: string, previous: string[]): string[] {
  return [...previous, ...splitSelectorList(value)];
}

interface RuntimeScopeOptions {
  installationType?: string;
  targetRoot?: string;
  user?: boolean;
  local?: boolean;
  fleet?: string;
  agent?: string;
  all?: boolean;
  allDetected?: boolean;
  profile?: string;
  workspaceTargetDerived?: boolean;
}

function normalizeRuntimeScopeOptions<T extends RuntimeScopeOptions>(options: T, behavior: { defaultUser?: boolean } = {}): T {
  if ([options.user === true, options.local === true, options.fleet !== undefined].filter(Boolean).length > 1) {
    throw new Error("Choose exactly one workspace selector: --user, --local, or --fleet <id>.");
  }
  if (options.targetRoot && !options.workspaceTargetDerived && (options.user || options.local || options.fleet)) {
    throw new Error("--target-root conflicts with --user, --local, and --fleet because each selects a workspace root.");
  }

  const canDefaultTargetRoot = !options.agent && !options.all && !options.allDetected && !options.profile;
  const shortcutType = canDefaultTargetRoot
    ? options.user ? "user" : options.local ? "local" : undefined
    : undefined;
  if (shortcutType && options.installationType && options.installationType !== shortcutType) {
    throw new Error(`--${shortcutType} conflicts with --installation-type ${options.installationType}.`);
  }

  let targetRoot = options.targetRoot ? normalizeCliPath(options.targetRoot) : undefined;
  let workspaceTargetDerived = options.workspaceTargetDerived;
  let installationType = options.installationType ?? shortcutType;

  if (!installationType && targetRoot && canDefaultTargetRoot) {
    installationType = isHomePath(targetRoot) ? "user" : "local";
  }

  if (!targetRoot && canDefaultTargetRoot && (options.user || installationType === "user" || behavior.defaultUser)) {
    targetRoot = homedir();
    workspaceTargetDerived = true;
  }

  if (!installationType && behavior.defaultUser) {
    installationType = "user";
  }

  return {
    ...options,
    installationType,
    targetRoot,
    workspaceTargetDerived,
  };
}

async function workspaceRootFromOptions(options: RuntimeScopeOptions): Promise<string> {
  return (await resolveCliWorkspaceScope(options)).root;
}

async function workspaceContextRootFromOptions(options: RuntimeScopeOptions): Promise<string> {
  if (options.targetRoot && !hasWorkspaceSelector(options)) {
    return (await resolveCliWorkspaceScope(options)).root;
  }
  if (options.user || options.local || options.fleet) {
    return (await resolveWorkspaceScope({
      cwd: process.cwd(),
      user: options.user,
      local: options.local,
      fleet: options.fleet,
    })).root;
  }
  return normalizeTargetRoot(process.cwd());
}

async function resolveCliWorkspaceScope(options: RuntimeScopeOptions): Promise<{ root: string; fleetId?: string }> {
  const derivedUserScope = isDerivedUserWorkspaceScope(options);
  if (options.targetRoot && !hasWorkspaceSelector(options) && !derivedUserScope) {
    const root = normalizeTargetRoot(options.targetRoot);
    const config = await readWorkspaceConfig(root);
    if (config.schemaVersion === 3 && config.fleetId) {
      const kind = isHomePath(root) ? "user" : "local";
      throw new Error(
        `The ${kind} config declares fleetId '${config.fleetId}'. Select it through the registered --fleet <id> scope.`,
      );
    }
    return { root };
  }
  return resolveWorkspaceScope({
    cwd: process.cwd(),
    user: options.user || derivedUserScope,
    local: options.local,
    fleet: options.fleet,
  });
}

function formatFleetNormalization(
  result: Awaited<ReturnType<typeof planFleetNormalization>>
    | Awaited<ReturnType<typeof applyFleetNormalization>>
    | Awaited<ReturnType<typeof recoverFleetNormalization>>,
): string {
  if ("recovered" in result) return `Recovered fleet normalization source state and removed journal: ${result.journalPath}`;
  if ("applied" in result) return `Applied fleet normalization ${result.planDigest}: ${result.packages.join(", ")}`;
  const packageArgs = result.packages.map((pkg) => `--package ${shellQuoteArg(pkg.name)}`).join(" ");
  return [
    `Fleet normalization plan: ${result.source.root} -> ${result.destination.root}`,
    `Packages: ${result.packages.map((pkg) => pkg.name).join(", ")}`,
    `Plan digest: ${result.planDigest}`,
    `Apply: agentwheel fleet normalize ${result.destination.fleetId} --from ${result.request.from} ${packageArgs} --apply --plan-digest ${result.planDigest}`,
  ].join("\n");
}

function shouldDefaultUserInstall(nameOrSource: string | undefined, options: RuntimeScopeOptions & { adapter?: string }): boolean {
  return Boolean(
    nameOrSource
      && options.adapter
      && !options.installationType
      && !options.user
      && !options.local
      && !options.fleet
      && !options.targetRoot
      && !options.agent
      && !options.all
      && !options.allDetected
      && !options.profile
      && looksLikeSourceSpecifier(nameOrSource),
  );
}

function hasWorkspaceSelector(options: RuntimeScopeOptions): boolean {
  return options.user === true || options.local === true || options.fleet !== undefined;
}

function isDerivedUserWorkspaceScope(options: RuntimeScopeOptions): boolean {
  return options.workspaceTargetDerived === true && options.installationType === "user";
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

function selectedArtifactsFromOptionsOrRegistry(
  options: { select?: string[]; skill?: string[]; skills?: string[] },
  registryEntry?: Parameters<typeof selectorsFromRegistryEntry>[0],
): string[] | undefined {
  return selectedArtifactsFromOptions(options) ?? selectorsFromRegistryEntry(registryEntry);
}

function suggestionAliasesFromOptions(options: { suggestion?: string[]; suggestions?: string[] }): string[] | undefined {
  const values = options.suggestions ?? options.suggestion;
  if (!values?.length) return undefined;
  return [...new Set(values.flatMap(splitSelectorList).map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function packageSuggestionAliases(pkg: WorkspacePackage, options: { suggestion?: string[]; suggestions?: string[] }): string[] | undefined {
  const aliases = [...(pkg.suggestions ?? []), ...(suggestionAliasesFromOptions(options) ?? [])]
    .map((item) => item.trim())
    .filter(Boolean);
  return aliases.length > 0 ? [...new Set(aliases)].sort((a, b) => a.localeCompare(b)) : undefined;
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
    schemaVersion: CURRENT_OPENPACK_SCHEMA_VERSION,
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

interface SearchCliOptions extends RuntimeScopeOptions {
  json: boolean;
  scope: string;
  type?: string;
  ecosystem?: string;
  limit: string;
  includeArchived: boolean;
  refresh: boolean;
  offline: boolean;
  semantic: boolean;
}

interface SkillTrialCliOptions extends RuntimeScopeOptions {
  driver?: string;
  json: boolean;
  select: string[];
  skill: string[];
}

function parseSearchScope(value: string): SearchScope {
  const parsed = searchScopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid search scope: ${value}. Expected one of: ${searchScopeSchema.options.join(", ")}.`);
}

function parseSearchType(value: string): SearchType {
  const parsed = searchTypeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid artifact type: ${value}. Expected one of: ${searchTypeSchema.options.join(", ")}.`);
}

function parseSearchEcosystem(value: string): SearchEcosystem {
  const parsed = searchEcosystemSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid ecosystem: ${value}. Expected one of: ${searchEcosystemSchema.options.join(", ")}.`);
}

function parseSearchLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`Invalid search limit: ${value}. Expected an integer from 1 to 100.`);
  }
  return limit;
}

function printSearchResults(query: string, results: SearchResult[]): void {
  if (results.length === 0) {
    console.log(`No artifacts found for ${JSON.stringify(query)}.`);
    return;
  }
  for (const [index, result] of results.entries()) {
    const ecosystem = result.ecosystem ?? "unknown";
    const provenances = result.provenances.join("+");
    console.log(
      `${index + 1}. ${result.name} `
      + `[type=${result.type}; ecosystem=${ecosystem}; installability=${result.installability}; provenance=${provenances}]`,
    );
    console.log(`   ${result.description || "(no description)"}`);
    if (result.semanticScore !== undefined) console.log(`   Semantic score: ${result.semanticScore}`);
    if (result.installCommand) {
      console.log(`   Install: ${result.installCommand}`);
    } else if (result.source) {
      console.log(`   Source: ${result.source}`);
    } else {
      console.log("   Install: unavailable");
    }
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
