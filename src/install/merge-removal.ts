import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { mismatchedCodexTomlMcpServers, type JsonRecord } from "./toml-merge.js";

export type MergeValue = null | boolean | number | string | MergeValue[] | { [key: string]: MergeValue };
export type MergeRemoval = Record<string, MergeValue>;

type MergeStrategy = "json-deep" | "openclaw-json-deep" | "yaml-deep" | "codex-toml-mcp";

export class MergeAdoptionMismatchError extends Error {}

export function combineMergeRemovals(existing: MergeRemoval, incoming: MergeRemoval): MergeRemoval {
  return combineMergeValues(existing, incoming) as MergeRemoval;
}

export function hasMergeRemovalContent(removal: MergeRemoval | undefined): boolean {
  if (!removal) return false;
  return Object.entries(removal).some(([key, value]) => {
    return !(key === "mcpServers" && isRecord(value) && Object.keys(value).length === 0);
  });
}

export async function mergeRemovalForInstall(
  sourcePath: string,
  strategy: MergeStrategy,
  currentContent: string | undefined,
  options: { adoptExistingMcp?: boolean } = {},
): Promise<MergeRemoval> {
  const source = await readMergeSource(sourcePath, strategy);
  if (currentContent === undefined) return source;
  if (options.adoptExistingMcp) {
    if (strategy === "codex-toml-mcp") {
      const mismatched = mismatchedCodexTomlMcpServers(source as JsonRecord, currentContent);
      if (mismatched.length > 0) {
        throw new MergeAdoptionMismatchError(`cannot adopt merged contribution: Codex MCP server content differs or is missing for ${mismatched.join(", ")}`);
      }
      return source;
    }
    if (strategy !== "json-deep") {
      throw new MergeAdoptionMismatchError(`cannot adopt merged contribution: strategy ${strategy} is not supported for MCP adoption`);
    }
    const mismatch = firstMcpContributionMismatch(parseMergeDestination(currentContent, strategy), source);
    if (mismatch) {
      throw new MergeAdoptionMismatchError(`cannot adopt merged contribution: destination differs or is missing at ${mismatch}`);
    }
    return source;
  }
  if (strategy === "codex-toml-mcp") {
    const existingServers = codexTomlMcpServerNames(currentContent);
    const servers = isRecord(source.mcpServers) ? source.mcpServers : source;
    return { mcpServers: Object.fromEntries(Object.entries(servers).filter(([name]) => !existingServers.has(name))) };
  }
  return introducedMergeContent(parseMergeDestination(currentContent, strategy), source);
}

export async function removeMergeContribution(destPath: string, strategy: MergeStrategy, removal: MergeRemoval): Promise<void> {
  const content = await readFile(destPath, "utf8");
  if (strategy === "codex-toml-mcp") {
    const servers = isRecord(removal.mcpServers) ? removal.mcpServers : removal;
    await writeFile(destPath, removeCodexTomlMcpSections(content, Object.keys(servers)), "utf8");
    return;
  }
  const current = parseMergeDestination(content, strategy);
  removeIntroducedContent(current, removal);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, strategy === "yaml-deep" ? stringify(current) : `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

async function readMergeSource(sourcePath: string, strategy: MergeStrategy): Promise<MergeRemoval> {
  const content = await readFile(sourcePath, "utf8");
  if (strategy === "yaml-deep") return requireRecord(normalizeYamlValue(parse(content)), "YAML merge source");
  return requireRecord(JSON.parse(content) as MergeValue, "JSON merge source");
}

function parseMergeDestination(content: string, strategy: MergeStrategy): MergeRemoval {
  if (strategy === "yaml-deep") return requireRecord(normalizeYamlValue(parse(content)), "YAML merge destination");
  return requireRecord(JSON.parse(content) as MergeValue, "JSON merge destination");
}

function introducedMergeContent(base: MergeRemoval, incoming: MergeRemoval): MergeRemoval {
  const introduced: MergeRemoval = {};
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (!(key in base)) { introduced[key] = incomingValue; continue; }
    const baseValue = base[key];
    if (isRecord(baseValue) && isRecord(incomingValue)) {
      const nested = introducedMergeContent(baseValue, incomingValue);
      if (Object.keys(nested).length > 0) introduced[key] = nested;
    } else if (Array.isArray(baseValue) && Array.isArray(incomingValue)) {
      const additions = incomingValue.filter((value) => !baseValue.some((existing) => sameValue(existing, value)));
      if (additions.length > 0) introduced[key] = additions;
    }
  }
  return introduced;
}

function firstMcpContributionMismatch(current: MergeValue, incoming: MergeValue): string | undefined {
  if (!isRecord(current) || !isRecord(incoming)) return "$";
  if (!isRecord(current.mcpServers) || !isRecord(incoming.mcpServers)) return "$.mcpServers";
  for (const [name, incomingServer] of Object.entries(incoming.mcpServers)) {
    if (!(name in current.mcpServers) || !sameMcpValue(current.mcpServers[name]!, incomingServer)) {
      return `$.mcpServers.${name}`;
    }
  }
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (key === "mcpServers") continue;
    if (!(key in current) || !sameMcpValue(current[key]!, incomingValue)) return `$.${key}`;
  }
  return undefined;
}

function combineMergeValues(existing: MergeValue, incoming: MergeValue): MergeValue {
  if (isRecord(existing) && isRecord(incoming)) {
    const combined: MergeRemoval = { ...existing };
    for (const [key, incomingValue] of Object.entries(incoming)) {
      combined[key] = key in combined ? combineMergeValues(combined[key]!, incomingValue) : incomingValue;
    }
    return combined;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming.filter((value) => !existing.some((current) => sameValue(current, value)))];
  }
  return incoming;
}

function removeIntroducedContent(current: MergeRemoval, removal: MergeRemoval): void {
  for (const [key, removalValue] of Object.entries(removal)) {
    if (!(key in current)) continue;
    const currentValue = current[key];
    if (isRecord(currentValue) && isRecord(removalValue)) {
      removeIntroducedContent(currentValue, removalValue);
      if (Object.keys(currentValue).length === 0) delete current[key];
    } else if (Array.isArray(currentValue) && Array.isArray(removalValue)) {
      const remaining = currentValue.filter((value) => !removalValue.some((removed) => sameValue(removed, value)));
      if (remaining.length === 0) delete current[key]; else current[key] = remaining;
    } else delete current[key];
  }
}

function codexTomlMcpServerNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
    const match = section?.match(/^mcp_servers\.([^.\]]+)(?:\.|$)/);
    if (match?.[1]) names.add(unquoteTomlKey(match[1]));
  }
  return names;
}

function removeCodexTomlMcpSections(content: string, serverNames: string[]): string {
  if (serverNames.length === 0 || content.trim() === "") return content;
  const names = new Set(serverNames); const kept: string[] = []; let skipping = false;
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
    if (section) { const match = section.match(/^mcp_servers\.([^.\]]+)(?:\.|$)/); skipping = match ? names.has(unquoteTomlKey(match[1] ?? "")) : false; }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}$/g, "\n\n");
}

function normalizeYamlValue(value: unknown): MergeValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeYamlValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeYamlValue(child)]));
  return value === undefined ? null : String(value);
}

function requireRecord(value: MergeValue, label: string): MergeRemoval { if (!isRecord(value)) throw new Error(`${label} must be an object`); return value; }
function isRecord(value: MergeValue | undefined): value is MergeRemoval { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sameValue(left: MergeValue, right: MergeValue): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameMcpValue(left: MergeValue, right: MergeValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameMcpValue(value, right[index]!));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameMcpValue(left[key]!, right[key]!));
  }
  return left === right;
}
function unquoteTomlKey(key: string): string { if (!key.startsWith("\"")) return key; try { return JSON.parse(key) as string; } catch { return key; } }
