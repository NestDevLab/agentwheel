import { stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { extname, join, resolve } from "node:path";
import ts from "typescript";
import { adapterSchema, type AdapterConfig, type ProgrammaticAdapterRuntime } from "../model/adapter.js";
import { hashPath } from "../utils/fs.js";

export interface ProgrammaticAdapterLoadOptions {
  allowCode: boolean;
}

export async function loadProgrammaticAdapter(modulePath: string, options: ProgrammaticAdapterLoadOptions): Promise<AdapterConfig> {
  if (!options.allowCode) {
    throw new Error("Refusing to load adapter code without --allow-adapter-code");
  }
  if (modulePath.startsWith("http://") || modulePath.startsWith("https://") || modulePath.startsWith("github:") || modulePath.startsWith("git:")) {
    throw new Error("Programmatic adapters must be loaded from an explicit local path");
  }

  const resolvedPath = resolve(modulePath);
  const stats = await stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Programmatic adapter module is not a file: ${resolvedPath}`);
  }

  const hash = await hashPath(resolvedPath);
  const importPath = extname(resolvedPath) === ".ts" ? await transpileTypeScriptAdapter(resolvedPath, hash) : resolvedPath;
  const imported = await import(`${pathToFileURL(importPath).href}?agentwheel=${Date.now()}`);
  const candidate = imported.adapter;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Programmatic adapter module must export "adapter": ${resolvedPath}`);
  }
  const parsed = adapterSchema.parse(candidate) as AdapterConfig;
  const runtime: ProgrammaticAdapterRuntime = {
    modulePath: resolvedPath,
    hash,
    capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.filter((item: unknown) => typeof item === "string") : [],
    plan: typeof candidate.plan === "function" ? candidate.plan.bind(candidate) : undefined,
    apply: typeof candidate.apply === "function" ? candidate.apply.bind(candidate) : undefined,
    uninstall: typeof candidate.uninstall === "function" ? candidate.uninstall.bind(candidate) : undefined,
  };
  return { ...parsed, programmatic: runtime };
}

async function transpileTypeScriptAdapter(modulePath: string, hash: string): Promise<string> {
  const source = await readFile(modulePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      sourceMap: false,
    },
    fileName: modulePath,
  });
  const outPath = join(tmpdir(), `agentwheel-adapter-${hash}.mjs`);
  await writeFile(outPath, output.outputText, "utf8");
  return outPath;
}
