import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { dirname } from "node:path";
import { pathExists } from "../utils/fs.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export async function mergeCodexTomlMcp(sourcePath: string, destPath: string): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as JsonRecord;
  const servers = extractMcpServers(source);
  const current = await pathExists(destPath) ? await readFile(destPath, "utf8") : "";
  const withoutManaged = removeManagedMcpSections(current, Object.keys(servers));
  const merged = appendMcpServers(withoutManaged, servers);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, merged, "utf8");
}

export function mismatchedCodexTomlMcpServers(source: JsonRecord, currentContent: string): string[] {
  const servers = extractMcpServers(source);
  return Object.entries(servers)
    .filter(([name, server]) => extractMcpServerBlock(currentContent, name) !== formatMcpServer(name, server))
    .map(([name]) => name);
}

/** Verify owned fields without claiming or rewriting user-owned preferences. */
export function mismatchedManagedCodexTomlMcpServers(source: JsonRecord, currentContent: string): string[] {
  const servers = extractMcpServers(source);
  let current: Record<string, unknown> | undefined;
  try {
    const parsed = parseToml(currentContent, { integersAsBigInt: "asNeeded" });
    current = isPlainRecord(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
  } catch {
    return Object.keys(servers);
  }
  return Object.entries(servers).filter(([name, server]) => {
    try {
      // Compare the renderer's owned representation, including omitted empty env tables.
      const rendered = parseToml(formatMcpServer(name, server), { integersAsBigInt: "asNeeded" });
      const expected = isPlainRecord(rendered.mcp_servers) ? rendered.mcp_servers[name] : undefined;
      return !current || !Object.hasOwn(current, name) || !managedValueMatches(current[name], expected);
    } catch {
      return true;
    }
  }).map(([name]) => name);
}

function managedValueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => managedValueMatches(actual[index], value));
  }
  if (isPlainRecord(expected)) {
    return isPlainRecord(actual) && Object.entries(expected)
      .every(([key, value]) => Object.hasOwn(actual, key) && managedValueMatches(actual[key], value));
  }
  return actual === expected;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function extractMcpServers(source: JsonRecord): Record<string, JsonRecord> {
  const raw = isRecord(source.mcpServers) ? source.mcpServers : source;
  const servers: Record<string, JsonRecord> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    servers[name] = value;
  }
  if (Object.keys(servers).length === 0) {
    throw new Error("Codex MCP TOML merge needs a JSON object with mcpServers");
  }
  return servers;
}

function removeManagedMcpSections(content: string, serverNames: string[]): string {
  if (serverNames.length === 0 || content.trim() === "") return content;
  const names = new Set(serverNames);
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
    if (section) {
      const match = section.match(/^mcp_servers\.([^.\]]+)(?:\.|$)/);
      skipping = match ? names.has(unquoteTomlKey(match[1] ?? "")) : false;
    }
    if (!skipping) kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}$/g, "\n\n");
}

function appendMcpServers(content: string, servers: Record<string, JsonRecord>): string {
  const blocks = Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => formatMcpServer(name, server));
  const prefix = content.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${blocks.join("\n\n")}\n`;
}

function formatMcpServer(name: string, server: JsonRecord): string {
  const env = isRecord(server.env) ? server.env : undefined;
  const lines = [`[mcp_servers.${quoteTomlKey(name)}]`];
  for (const [key, value] of Object.entries(server)) {
    if (key === "env" || value === undefined) continue;
    lines.push(`${quoteTomlKey(key)} = ${formatTomlValue(value)}`);
  }
  if (env && Object.keys(env).length > 0) {
    lines.push("", `[mcp_servers.${quoteTomlKey(name)}.env]`);
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${quoteTomlKey(key)} = ${formatTomlValue(value)}`);
    }
  }
  return lines.join("\n");
}

function extractMcpServerBlock(content: string, serverName: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const blocks: string[][] = [];
  let block: string[] | undefined;
  let collecting = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
    if (section) {
      const match = section.match(/^mcp_servers\.([^\.\]]+)(?:\.|$)/);
      const name = match?.[1] ? unquoteTomlKey(match[1]) : undefined;
      if (collecting && block) {
        while (block.at(-1)?.trim() === "") block.pop();
        blocks.push(block);
      }
      collecting = name === serverName;
      block = collecting ? [] : undefined;
    }
    if (collecting) block?.push(line);
  }

  if (collecting && block) {
    while (block.at(-1)?.trim() === "") block.pop();
    blocks.push(block);
  }
  if (blocks.length === 0) return undefined;
  return blocks.map((lines) => lines.join("\n")).join("\n\n");
}

function formatTomlValue(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, child]) => `${quoteTomlKey(key)} = ${formatTomlValue(child)}`);
    return `{ ${entries.join(", ")} }`;
  }
  return "\"\"";
}

function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function unquoteTomlKey(key: string): string {
  if (!key.startsWith("\"")) return key;
  try {
    return JSON.parse(key) as string;
  } catch {
    return key;
  }
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
