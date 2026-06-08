import { rm } from "node:fs/promises";
import { Command } from "commander";
import { getAdapter } from "../adapters/index.js";
import { loadAdapterConfig } from "../model/adapter.js";
import { applyInstallPlan, createInstallPlan, createUninstallPlan, normalizeTargetRoot, readInstallManifest, uninstall } from "../install/index.js";
import { formatPlan } from "./format.js";
import { getSourceDriver } from "../source/index.js";
import { stageSource } from "../staging/staging.js";

const program = new Command();

program
  .name("agentweave")
  .description("Multi-runtime agent artifact orchestrator")
  .version("0.1.0");

program
  .command("list")
  .argument("<source>", "local source directory")
  .option("--driver <driver>", "source driver", "local")
  .action(async (source, options) => {
    const driver = getSourceDriver(options.driver);
    const resolved = await driver.resolve(source);
    const artifacts = await driver.list(resolved);
    for (const artifact of artifacts) {
      console.log(`${artifact.type}\t${artifact.name}\t${artifact.relativePath}`);
    }
  });

program
  .command("scan")
  .argument("<source>", "local source directory")
  .option("--driver <driver>", "source driver", "local")
  .action(async (source, options) => {
    const driver = getSourceDriver(options.driver);
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
  .option("--driver <driver>", "source driver", "local")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--target-root <path>", "runtime/project root", process.cwd())
  .action(async (source, options) => {
    const { plan, bundle } = await buildPlan(source, options);
    console.log(formatPlan(plan));
    await rm(bundle.root, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
  });

program
  .command("sync")
  .argument("<source>", "source directory")
  .option("--driver <driver>", "source driver", "local")
  .option("--adapter <adapter>", "built-in adapter", "openclaw")
  .option("--adapter-config <path>", "adapter JSON/JSONC file")
  .option("--target-root <path>", "runtime/project root", process.cwd())
  .option("--dry-run", "show plan without writing", false)
  .action(async (source, options) => {
    const { plan, bundle } = await buildPlan(source, options);
    console.log(formatPlan(plan));
    if (!options.dryRun) {
      await applyInstallPlan(plan, bundle.sourceLock);
      console.log("Applied.");
    }
    await rm(bundle.root, { recursive: true, force: true });
    if (plan.hasBlockingChanges) process.exitCode = 1;
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

async function buildPlan(source: string, options: { driver: string; adapter: string; adapterConfig?: string; targetRoot: string }) {
  const driver = getSourceDriver(options.driver);
  const adapter = options.adapterConfig ? await loadAdapterConfig(options.adapterConfig) : getAdapter(options.adapter);
  const targetRoot = normalizeTargetRoot(options.targetRoot);
  const bundle = await stageSource(driver, source);
  const manifest = await readInstallManifest(targetRoot, adapter.name);
  const plan = await createInstallPlan(bundle, adapter, targetRoot, manifest);
  return { plan, bundle };
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
