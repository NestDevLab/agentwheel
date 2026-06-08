import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { getAdapter } from "../adapters/index.js";
import { loadAdapterConfig } from "../model/adapter.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, normalizeTargetRoot, readInstallManifest, readSourceLock, uninstall } from "../install/index.js";
import { formatPlan } from "./format.js";
import { getSourceDriver } from "../source/index.js";
import { inferSourceDriverName } from "../source/identify.js";
import { stageSource } from "../staging/staging.js";
import { readWorkspaceConfig, upsertPackage, writeWorkspaceConfig } from "../model/workspace.js";
import type { WorkspacePackage } from "../model/workspace.js";
import { ejectArtifact, remember } from "../lifecycle/customization.js";
import { shouldUpdatePackage } from "../lifecycle/update.js";
import { RegistryClient, resolvePackageSource } from "../registry/client.js";

const program = new Command();

program
  .name("agentwheel")
  .description("Multi-runtime agent artifact orchestrator")
  .version("0.2.0");

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
  .option("--target-root <path>", "workspace root", process.cwd())
  .option("--mode <mode>", "pinned or tracking", "pinned")
  .option("--name <name>", "package alias")
  .action(async (source, options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const resolvedInput = await resolvePackageSource(source, targetRoot);
    const resolvedSource = resolvedInput.source;
    const driverName = options.driver ?? inferSourceDriverName(resolvedSource);
    const driver = getSourceDriver(driverName);
    const adapter = options.adapterConfig ? await loadAdapterConfig(options.adapterConfig) : getAdapter(options.adapter);
    const bundle = await stageSource(driver, resolvedSource, {
      workspaceRoot: targetRoot,
      adapter,
      cacheRoot: join(targetRoot, ".agentwheel", "cache"),
      mode: options.mode,
    });
    const name = options.name ?? resolvedInput.registryEntry?.name ?? bundle.source.packageName ?? source;
    const entry: WorkspacePackage = {
      name,
      source: resolvedSource,
      driver: driverName,
      adapter: adapter.name,
      adapterConfig: options.adapterConfig,
      mode: options.mode,
      requestedRef: bundle.source.requestedRef,
    };
    await writeWorkspaceConfig(targetRoot, upsertPackage(await readWorkspaceConfig(targetRoot), entry));
    await rm(bundle.root, { recursive: true, force: true });
    console.log(`Added ${name}.`);
  });

program
  .command("list")
  .argument("<source>", "local source directory")
  .option("--driver <driver>", "source driver")
  .action(async (source, options) => {
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(source));
    const resolved = await driver.resolve(source);
    const artifacts = await driver.list(resolved);
    for (const artifact of artifacts) {
      console.log(`${artifact.type}\t${artifact.name}\t${artifact.relativePath}`);
    }
  });

program
  .command("scan")
  .argument("<source>", "local source directory")
  .option("--driver <driver>", "source driver")
  .action(async (source, options) => {
    const driver = getSourceDriver(options.driver ?? inferSourceDriverName(source));
    const resolved = await driver.resolve(source);
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
  .option("--target-root <path>", "runtime/project root", process.cwd())
  .option("--mode <mode>", "pinned or tracking")
  .action(async (source, options) => {
    const { plan, bundle } = await buildPlan(source, options);
    console.log(formatPlan(plan));
    await rm(bundle.root, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
  });

program
  .command("sync")
  .argument("<source>", "source directory")
  .option("--driver <driver>", "source driver")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--target-root <path>", "runtime/project root", process.cwd())
  .option("--mode <mode>", "pinned or tracking")
  .option("--dry-run", "show plan without writing", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .action(async (source, options) => {
    const { plan, bundle } = await buildPlan(source, options);
    console.log(formatPlan(plan));
    if (!options.dryRun) {
      await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins });
      console.log("Applied.");
    }
    await rm(bundle.root, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
  });

program
  .command("update")
  .option("--target-root <path>", "workspace root", process.cwd())
  .option("--dry-run", "show plans without writing", false)
  .option("--execute-plugins", "execute semantic plugin installs", false)
  .action(async (options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const config = await readWorkspaceConfig(targetRoot);
    if (config.packages.length === 0) {
      console.log("No packages configured.");
      return;
    }
    for (const pkg of config.packages) {
      const adapter = pkg.adapterConfig ? await loadAdapterConfig(pkg.adapterConfig) : getAdapter(pkg.adapter);
      const lock = await readSourceLock(targetRoot, adapter.name);
      const decision = shouldUpdatePackage(pkg, lock);
      if (!decision.shouldUpdate) {
        console.log(`Skipping ${pkg.name}: ${decision.reason}.`);
        continue;
      }
      const { plan, bundle } = await buildPlan(pkg.source, {
        driver: pkg.driver,
        adapter: pkg.adapter,
        adapterConfig: pkg.adapterConfig,
        targetRoot,
        mode: pkg.mode,
      });
      console.log(`Update ${pkg.name}:`);
      console.log(formatPlan(plan));
      if (!options.dryRun) {
        await applyInstallPlan(plan, bundle.sourceLock, { executePlugins: options.executePlugins });
        console.log(`Applied ${pkg.name}.`);
      }
      await rm(bundle.root, { recursive: true, force: true });
      if (plan.hasBlockingChanges) process.exitCode = 1;
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
  .option("--target-root <path>", "runtime/project root", process.cwd())
  .option("--dry-run", "show removals without writing", false)
  .action(async (options) => {
    const targetRoot = normalizeTargetRoot(options.targetRoot);
    const manifest = await readInstallManifest(targetRoot, options.adapter);
    if (!manifest) {
      console.log(`No install manifest for ${options.adapter} at ${targetRoot}`);
      return;
    }
    const plan = await createUninstallPlan(manifest);
    console.log(formatPlan(plan));
    await uninstall(plan, options.dryRun);
    if (!options.dryRun) console.log("Uninstalled.");
    if (plan.hasBlockingChanges) process.exitCode = 1;
  });

async function buildPlan(source: string, options: { driver?: string; adapter: string; adapterConfig?: string; targetRoot: string; mode?: "pinned" | "tracking" }) {
  const driver = getSourceDriver(options.driver ?? inferSourceDriverName(source));
  const adapter = options.adapterConfig ? await loadAdapterConfig(options.adapterConfig) : getAdapter(options.adapter);
  const targetRoot = normalizeTargetRoot(options.targetRoot);
  const bundle = await stageSource(driver, source, {
    workspaceRoot: targetRoot,
    adapter,
    cacheRoot: join(targetRoot, ".agentwheel", "cache"),
    mode: options.mode,
  });
  const manifest = await readInstallManifest(targetRoot, adapter.name);
  const plan = await createInstallPlan(bundle, adapter, targetRoot, manifest);
  return { plan, bundle };
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

function printRegistryEntries(entries: Array<{ name: string; type: string; source: string; description: string; tags?: string[] }>): void {
  for (const entry of entries) {
    const tags = entry.tags?.length ? ` [${entry.tags.join(",")}]` : "";
    console.log(`${entry.name}\t${entry.type}\t${entry.source}\t${entry.description}${tags}`);
  }
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
