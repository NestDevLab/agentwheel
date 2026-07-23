export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

type ComparatorOp = "=" | ">" | ">=" | "<" | "<=";

interface Comparator {
  op: ComparatorOp;
  version: ParsedSemver;
}

const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: string): ParsedSemver | undefined {
  const match = semverPattern.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

export function satisfiesVersionRange(version: string, range: string | undefined): boolean {
  if (!range || range.trim() === "" || range.trim() === "*") return true;
  const parsedVersion = parseSemver(version);
  const trimmed = range.trim();

  if (!parsedVersion) {
    return trimmed === "*" || trimmed === version;
  }

  const comparators = parseRange(trimmed);
  if (!comparators) return trimmed === version;
  return comparators.every((comparator) => compareWith(parsedVersion, comparator));
}

export function semverMajorOrVersion(version: string): string {
  const parsed = parseSemver(version);
  return parsed ? String(parsed.major) : version;
}

export function compareSemverStrings(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);
  return compareSemver(parsedA, parsedB);
}

export function isSupportedVersionRange(range: string): boolean {
  const trimmed = range.trim();
  return trimmed === "*" || parseRange(trimmed) !== undefined;
}

function parseRange(range: string): Comparator[] | undefined {
  if (range === "*") return [];
  if (range.startsWith("^")) {
    const base = parseSemver(range.slice(1));
    if (!base) return undefined;
    return [
      { op: ">=", version: base },
      { op: "<", version: caretUpperBound(base) },
    ];
  }
  if (range.startsWith("~")) {
    const base = parseSemver(range.slice(1));
    if (!base) return undefined;
    return [
      { op: ">=", version: base },
      { op: "<", version: { major: base.major, minor: base.minor + 1, patch: 0 } },
    ];
  }

  const parts = range.split(/\s+/).filter(Boolean);
  const comparators: Comparator[] = [];
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!match) return undefined;
    const version = parseSemver(match[2] ?? "");
    if (!version) return undefined;
    comparators.push({ op: (match[1] as ComparatorOp | undefined) ?? "=", version });
  }
  return comparators;
}

function caretUpperBound(version: ParsedSemver): ParsedSemver {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

function compareWith(version: ParsedSemver, comparator: Comparator): boolean {
  const order = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
  }
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}
