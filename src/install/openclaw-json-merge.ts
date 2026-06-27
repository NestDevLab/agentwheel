import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathExists } from "../utils/fs.js";
import { deepMerge, isRecord, type JsonValue } from "./json-merge.js";

export async function mergeOpenClawJsonFile(sourcePath: string, destPath: string): Promise<void> {
  const source = expandEnvPlaceholders(
    normalizeOpenClawConfig(JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue),
    sourcePath,
  );
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = deepMerge(current, source);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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
