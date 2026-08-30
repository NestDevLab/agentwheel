import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists } from "../utils/fs.js";
import { deepMerge, isRecord, type JsonValue } from "./json-merge.js";

export async function mergeOpenClawJsonFile(sourcePath: string, destPath: string): Promise<void> {
  const source = await renderOpenClawJsonMergeSource(sourcePath);
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = mergeOpenClawJson(current, source);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export async function renderOpenClawJsonMergeSource(sourcePath: string): Promise<JsonValue> {
  return expandEnvPlaceholders(
    normalizeOpenClawConfig(JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue),
    sourcePath,
  );
}

function mergeOpenClawJson(base: JsonValue, incoming: JsonValue, path: string[] = []): JsonValue {
  if (isMcpServerCodexAgentsPath(path) && Array.isArray(incoming)) {
    return incoming;
  }
  if (path.join(".") === "agents.list" && Array.isArray(base) && Array.isArray(incoming)) {
    return mergeOpenClawAgentsById(base, incoming);
  }
  if (isAgentwheelSkillRouterRepositoriesPath(path) && Array.isArray(base) && Array.isArray(incoming)) {
    return mergeOpenClawRecordsByKey(base, incoming, "name");
  }
  if (Array.isArray(base) && Array.isArray(incoming)) {
    return deepMerge(base, incoming);
  }
  if (isRecord(base) && isRecord(incoming)) {
    const out: Record<string, JsonValue> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = key in out ? mergeOpenClawJson(out[key], value, [...path, key]) : value;
    }
    return out;
  }
  return incoming;
}

function isMcpServerCodexAgentsPath(path: string[]): boolean {
  return path.length === 5 && path[0] === "mcp" && path[1] === "servers" && path[3] === "codex" && path[4] === "agents";
}

function isAgentwheelSkillRouterRepositoriesPath(path: string[]): boolean {
  return path.join(".") === "plugins.entries.agentwheel-skill-router.config.repositories";
}

function expandEnvPlaceholders(value: JsonValue, sourcePath: string): JsonValue {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) {
        throw new Error(`Missing environment variable ${name} while rendering OpenClaw JSON merge artifact ${sourcePath}`);
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvPlaceholders(item, sourcePath));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, expandEnvPlaceholders(child, sourcePath)]),
  );
}

function normalizeOpenClawConfig(value: JsonValue): JsonValue {
  if (!isRecord(value)) return value;
  const rootMcpServers = isRecord(value.mcpServers) ? value.mcpServers : undefined;
  if (!rootMcpServers) return value;

  const out: Record<string, JsonValue> = { ...value };
  const normalizedServers: Record<string, JsonValue> = {};
  for (const [name, server] of Object.entries(rootMcpServers)) {
    if (isRecord(server)) normalizedServers[name] = normalizeOpenClawMcpServer(server);
  }

  const mcp = isRecord(out.mcp) ? out.mcp : {};
  out.mcp = deepMerge(mcp, { servers: normalizedServers });
  delete out.mcpServers;
  return out;
}

function normalizeOpenClawMcpServer(server: Record<string, JsonValue>): JsonValue {
  const out: Record<string, JsonValue> = { ...server };
  const type = typeof out.type === "string" ? out.type : undefined;
  if (type && typeof out.transport !== "string") out.transport = type;
  delete out.type;
  return out;
}

function mergeOpenClawAgentsById(base: JsonValue[], incoming: JsonValue[]): JsonValue[] {
  const out = [...base];
  const indexById = new Map<string, number>();
  for (const [index, value] of out.entries()) {
    const id = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
    if (id) indexById.set(id, index);
  }
  for (const value of incoming) {
    const id = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
    if (!id || !indexById.has(id)) {
      out.push(value);
      if (id) indexById.set(id, out.length - 1);
      continue;
    }
    out[indexById.get(id)!] = value;
  }
  return out;
}

function mergeOpenClawRecordsByKey(base: JsonValue[], incoming: JsonValue[], key: string): JsonValue[] {
  const replacements = new Map<string, JsonValue>();
  for (const value of incoming) {
    const recordKey = isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
    if (recordKey) replacements.set(recordKey, value);
  }

  const out: JsonValue[] = [];
  const emitted = new Set<string>();
  for (const value of base) {
    const recordKey = isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
    const replacement = recordKey ? replacements.get(recordKey) : undefined;
    if (!recordKey || !replacement) {
      out.push(value);
      continue;
    }
    if (!emitted.has(recordKey)) {
      out.push(replacement);
      emitted.add(recordKey);
    }
  }

  for (const value of incoming) {
    const recordKey = isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
    if (!recordKey || !emitted.has(recordKey)) {
      out.push(value);
      if (recordKey) emitted.add(recordKey);
    }
  }
  return out;
}
