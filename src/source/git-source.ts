import { posix } from "node:path";

export interface ParsedGitSource {
  url: string;
  ref?: string;
  subpath?: string;
}

// Git ref names cannot contain "//" (git check-ref-format), so it separates ref from subpath
// without ambiguity, including for refs that themselves contain slashes.
const SUBPATH_SEPARATOR = "//";

export function parseGitSource(source: string): ParsedGitSource {
  if (source.startsWith("github:")) {
    const rest = source.slice("github:".length);
    const hashIndex = rest.indexOf("#");
    const repo = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
    if (!repo.includes("/")) throw new Error(`Invalid GitHub source: ${source}`);
    return {
      url: `https://github.com/${repo.replace(/\.git$/i, "")}.git`,
      ...splitFragment(hashIndex >= 0 ? rest.slice(hashIndex + 1) : undefined, source),
    };
  }
  if (source.startsWith("git:")) {
    const rest = source.slice("git:".length);
    const hashIndex = rest.lastIndexOf("#");
    if (hashIndex < 0) return { url: rest };
    return { url: rest.slice(0, hashIndex), ...splitFragment(rest.slice(hashIndex + 1), source) };
  }
  throw new Error(`Invalid git source: ${source}`);
}

export function formatGitSource(url: string, ref: string, subpath?: string): string {
  return subpath ? `git:${url}#${ref}${SUBPATH_SEPARATOR}${subpath}` : `git:${url}#${ref}`;
}

/**
 * Normalizes a repository-relative package path, or returns undefined for the repository root.
 * Rejects anything that could leave the checked-out snapshot.
 */
export function normalizeGitSubpath(subpath: string | undefined, source: string): string | undefined {
  if (subpath === undefined) return undefined;
  if (subpath.includes("\\")) throw new Error(`Git source subpath must use forward slashes: ${source}`);
  if (subpath.startsWith("/")) throw new Error(`Git source subpath must be relative to the repository: ${source}`);
  const normalized = posix.normalize(subpath).replace(/\/+$/g, "");
  if (normalized === "." || normalized === "") return undefined;
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Git source subpath escapes the repository: ${source}`);
  }
  return normalized;
}

/**
 * Resolves a dependency path declared inside a git package to a path from the repository root.
 * `declaringSubpath` is where the declaring package sits; `relative` is its "./" or "../" source.
 */
export function resolveGitRelativeSubpath(
  declaringSubpath: string | undefined,
  relative: string,
  source: string,
): string | undefined {
  const joined = posix.normalize(posix.join(declaringSubpath ?? ".", relative));
  if (joined === ".." || joined.startsWith("../")) {
    throw new Error(`Relative dependency '${relative}' escapes the git repository it is declared in: ${source}`);
  }
  return normalizeGitSubpath(joined, source);
}

function splitFragment(fragment: string | undefined, source: string): { ref?: string; subpath?: string } {
  if (fragment === undefined) return {};
  const separator = fragment.indexOf(SUBPATH_SEPARATOR);
  if (separator < 0) return fragment ? { ref: fragment } : {};
  const ref = fragment.slice(0, separator);
  const subpath = normalizeGitSubpath(fragment.slice(separator + SUBPATH_SEPARATOR.length), source);
  return { ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}) };
}
