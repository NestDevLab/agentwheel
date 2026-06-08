import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathExists } from "../utils/fs.js";

export async function mergeJsonFile(sourcePath: string, destPath: string): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue;
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = deepMerge(current, source);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function deepMerge(base: JsonValue, incoming: JsonValue): JsonValue {
  if (Array.isArray(base) && Array.isArray(incoming)) {
    return dedupeArray([...base, ...incoming]);
  }
  if (isRecord(base) && isRecord(incoming)) {
    const out: Record<string, JsonValue> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return incoming;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeArray(values: JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const out: JsonValue[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
