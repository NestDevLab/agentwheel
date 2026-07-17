import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

export type MergeValue = null | boolean | number | string | MergeValue[] | { [key: string]: MergeValue };
export type MergeRemoval = Record<string, MergeValue>;

type MergeStrategy = "json-deep" | "openclaw-json-deep" | "yaml-deep" | "codex-toml-mcp";

export async function mergeRemovalForInstall(sourcePath: string, strategy: MergeStrategy, currentContent: string | undefined): Promise<MergeRemoval> {
  const source = await readMergeSource(sourcePath, strategy);
  if (currentContent === undefined) return source;
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
function unquoteTomlKey(key: string): string { if (!key.startsWith("\"")) return key; try { return JSON.parse(key) as string; } catch { return key; } }
