import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists } from "../utils/fs.js";
import { deepMerge, isRecord, type JsonValue } from "./json-merge.js";

export async function mergeOpenClawJsonFile(sourcePath: string, destPath: string): Promise<void> {
  const source = normalizeOpenClawConfig(JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue);
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = deepMerge(current, source);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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
