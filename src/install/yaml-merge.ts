import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { pathExists } from "../utils/fs.js";

export async function mergeYamlFile(sourcePath: string, destPath: string): Promise<void> {
  const source = parseYamlValue(await readFile(sourcePath, "utf8"));
  const current = await pathExists(destPath)
    ? parseYamlValue(await readFile(destPath, "utf8"))
    : {};
  const merged = deepMerge(current, source);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, stringify(merged), "utf8");
}

type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

function parseYamlValue(content: string): YamlValue {
  return normalizeYamlValue(parse(content));
}

function normalizeYamlValue(value: unknown): YamlValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeYamlValue);
  if (isPlainObject(value)) {
    const out: Record<string, YamlValue> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = normalizeYamlValue(child);
    }
    return out;
  }
  return value === undefined ? null : String(value);
}

function deepMerge(base: YamlValue, incoming: YamlValue): YamlValue {
  if (Array.isArray(base) && Array.isArray(incoming)) {
    return dedupeArray([...base, ...incoming]);
  }
  if (isRecord(base) && isRecord(incoming)) {
    const out: Record<string, YamlValue> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return incoming;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeArray(values: YamlValue[]): YamlValue[] {
  const seen = new Set<string>();
  const out: YamlValue[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
