import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathExists } from "../utils/fs.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function mergeJsonFile(sourcePath: string, destPath: string, retirement?: JsonRetirement): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as JsonValue;
  const current = await pathExists(destPath)
    ? JSON.parse(await readFile(destPath, "utf8")) as JsonValue
    : {};
  const merged = mergeJsonUpdate(current, source, retirement);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export function deepMerge(base: JsonValue, incoming: JsonValue): JsonValue {
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

export function isRecord(value: JsonValue): value is Record<string, JsonValue> {
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

/** Exact, segment-based paths avoid ambiguity for JSON keys containing dots or slashes. */
export interface JsonRetirement {
  remove: Array<{ path: string[]; value: JsonValue }>;
  preserved: Array<{ path: string[]; reason: string }>;
}

export function planJsonRetirement(
  current: JsonValue,
  incoming: JsonValue,
  previous: Record<string, JsonValue>,
  protectedContributions: JsonValue[] = [],
): { retirement: JsonRetirement; retained: Record<string, JsonValue> } {
  const retirement: JsonRetirement = { remove: [], preserved: [] };
  const own = (value: JsonValue | undefined, key: string): boolean =>
    value !== undefined && isRecord(value) && Object.hasOwn(value, key);
  const at = (value: JsonValue | undefined, path: string[]): JsonValue | undefined => {
    for (const key of path) {
      if (!own(value, key)) return undefined;
      value = (value as Record<string, JsonValue>)[key];
    }
    return value;
  };
  const visit = (contribution: Record<string, JsonValue>, path: string[]): Record<string, JsonValue> => {
    const retained: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(contribution)) {
      const next = [...path, key];
      const desiredParent = at(incoming, path);
      if (own(desiredParent, key)) {
        const desired = at(incoming, next)!;
        if (isRecord(value) && isRecord(desired)) {
          const children = visit(value, next);
          if (Object.keys(children).length) retained[key] = children;
        } else {
          // Remember the value now contributed, rather than an obsolete scalar value.
          retained[key] = Array.isArray(value) && Array.isArray(desired)
            ? value.filter((entry) => desired.some((candidate) => jsonEqual(entry, candidate)))
            : desired;
        }
        continue;
      }
      // Objects are traversed by owned leaf: never delete an untracked sibling.
      if (isRecord(value) && Object.keys(value).length) {
        visit(value, next);
        continue;
      }
      const observed = at(current, next);
      if (observed === undefined) continue;
      const shared = protectedContributions.some((other) => {
        // A foreign scalar/array at any ancestor also protects this subtree.
        for (let length = 1; length <= next.length; length++) {
          const candidate = at(other, next.slice(0, length));
          if (candidate !== undefined && (!isRecord(candidate) || length === next.length)) return true;
        }
        return false;
      });
      if (shared || !jsonEqual(observed, value)) {
        retirement.preserved.push({ path: next, reason: shared ? "another artifact contributes this path" : "value changed outside this artifact" });
      } else {
        retirement.remove.push({ path: next, value });
      }
    }
    return retained;
  };
  return { retirement, retained: visit(previous, []) };
}

export function mergeJsonUpdate(current: JsonValue, incoming: JsonValue, retirement?: JsonRetirement): JsonValue {
  const base: JsonValue = structuredClone(current);
  for (const { path, value } of retirement?.remove ?? []) {
    let parent = base;
    for (const segment of path.slice(0, -1)) {
      parent = isRecord(parent) && Object.hasOwn(parent, segment) ? parent[segment]! : null;
    }
    const key = path.at(-1)!;
    if (!isRecord(parent) || !Object.hasOwn(parent, key)) continue;
    if (!jsonEqual(parent[key]!, value)) throw new Error(`JSON retirement value changed since planning: ${JSON.stringify(path)}`);
    delete parent[key];
  }
  return deepMerge(base, incoming);
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]!));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!));
  }
  return left === right;
}
