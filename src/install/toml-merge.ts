import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists } from "../utils/fs.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export async function mergeCodexTomlMcp(sourcePath: string, destPath: string): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as JsonRecord;
  const servers = extractMcpServers(source);
  const current = await pathExists(destPath) ? await readFile(destPath, "utf8") : "";
  const withoutManaged = removeManagedMcpSections(current, Object.keys(servers));
  const merged = appendMcpServers(withoutManaged, servers);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, merged, "utf8");
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
