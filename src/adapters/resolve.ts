import { resolve } from "node:path";
import type { AdapterConfig } from "../model/adapter.js";
import { loadAdapterConfig } from "../model/adapter.js";
import { getAdapter } from "./index.js";
import { attachOpenClawProgrammatic } from "./openclaw.js";
import { loadProgrammaticAdapter } from "./programmatic.js";

export interface ResolveAdapterOptions {
  adapter?: string;
  adapterConfig?: string;
  adapterModule?: string;
  allowAdapterCode?: boolean;
  baseDir?: string;
  warn?: (message: string) => void;
}

export async function resolveAdapter(options: ResolveAdapterOptions): Promise<AdapterConfig> {
  if (options.adapterModule) {
    const modulePath = resolve(options.baseDir ?? process.cwd(), options.adapterModule);
    const adapter = await loadProgrammaticAdapter(modulePath, { allowCode: options.allowAdapterCode === true });
    options.warn?.(`WARNING: loaded local adapter code ${adapter.programmatic?.modulePath} (${adapter.programmatic?.hash})`);
    return adapter;
  }
  if (options.adapterConfig) {
    return attachOpenClawProgrammatic(await loadAdapterConfig(resolve(options.baseDir ?? process.cwd(), options.adapterConfig)));
  }
  return getAdapter(options.adapter ?? "openclaw");
}
