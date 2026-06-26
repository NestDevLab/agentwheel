import { ClawHubSourceDriver } from "./clawhub.js";
import { GitSourceDriver } from "./git.js";
import { LocalSourceDriver } from "./local.js";
import { McpRegistrySourceDriver } from "./mcp-registry.js";
import { SkillKitSourceDriver } from "./skillkit.js";
import type { SourceDriver } from "./types.js";
import { VercelSkillsSourceDriver } from "./vercel-skills.js";

const drivers: SourceDriver[] = [
  new LocalSourceDriver(),
  new GitSourceDriver(),
  new SkillKitSourceDriver(),
  new VercelSkillsSourceDriver(),
  new McpRegistrySourceDriver(),
  new ClawHubSourceDriver(),
];

export function getSourceDriver(name = "local"): SourceDriver {
  const driver = drivers.find((candidate) => candidate.name === name);
  if (!driver) {
    throw new Error(`Unknown source driver: ${name}`);
  }
  return driver;
}

export type { ResolvedSource, ScanFinding, ScanResult, SourceDriver } from "./types.js";
