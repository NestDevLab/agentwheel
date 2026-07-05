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

export async function mergeOpenClawJsonFile(sourcePath: string, destPath: string): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue;
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = deepMergeOpenClaw(current, source, []);
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

function deepMergeOpenClaw(base: JsonValue, incoming: JsonValue, path: string[]): JsonValue {
  if (typeof incoming === "string") {
    const expanded = expandEnvPlaceholders(incoming);
    if (expanded.unresolved && base !== undefined) return base;
    return expanded.value;
  }
  if (Array.isArray(base) && Array.isArray(incoming)) {
    if (path.join(".") === "agents.list") return mergeOpenClawAgentsById(base, incoming);
    return dedupeArray([...base, ...incoming]);
  }
  if (isRecord(base) && isRecord(incoming)) {
    const out: Record<string, JsonValue> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = key in out ? deepMergeOpenClaw(out[key], value, [...path, key]) : value;
    }
    return out;
  }
  return incoming;
}

function expandEnvPlaceholders(value: string): { value: string; unresolved: boolean } {
  let unresolved = false;
  const expanded = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
    const replacement = process.env[name];
    if (replacement === undefined) {
      unresolved = true;
      return match;
    }
    return replacement;
  });
  return { value: expanded, unresolved };
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
