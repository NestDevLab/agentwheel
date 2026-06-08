import { GitSourceDriver } from "./git.js";
import { LocalSourceDriver } from "./local.js";
import type { SourceDriver } from "./types.js";

const drivers: SourceDriver[] = [new LocalSourceDriver(), new GitSourceDriver()];

export function getSourceDriver(name = "local"): SourceDriver {
  const driver = drivers.find((candidate) => candidate.name === name);
  if (!driver) {
    throw new Error(`Unknown source driver: ${name}`);
  }
  return driver;
}

export type { ResolvedSource, ScanFinding, ScanResult, SourceDriver } from "./types.js";
