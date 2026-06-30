import type { RegistryEntry } from "../model/registry.js";
import { normalizeArtifactSelectors } from "../model/selection.js";

export const DEFAULT_REGISTRY_SUBMISSION_URL = "https://github.com/NestDevLab/agentwheel-registry/issues/new";

export type RegistryEntryType = RegistryEntry["type"];

export interface RegistryPublishDraftOptions {
  name?: string;
  type?: string;
  description?: string;
  tags?: string[];
  select?: string[];
  skills?: string[];
  submissionUrl?: string;
}

export interface RegistryPublishDraft {
  entry: RegistryEntry;
  installCommand: string;
  issueUrl: string;
}

const registryEntryTypes = ["package", "skill", "plugin", "mcp", "adapter"] as const;
const explicitSourcePrefixes = ["github:", "git:", "skillkit:", "vercel:", "mcp-registry:", "clawhub:"] as const;

export function createRegistryPublishDraft(sourceInput: string, options: RegistryPublishDraftOptions = {}): RegistryPublishDraft {
  const source = normalizeCatalogueSource(sourceInput);
  const entry: RegistryEntry = {
    name: normalizeRegistryName(options.name ?? inferRegistryName(source)),
    source,
    type: options.type ? parseRegistryEntryType(options.type) : inferRegistryEntryType(source),
    description: options.description?.trim() ?? "",
    tags: normalizeTags(options.tags ?? []),
  };
  const selectors = normalizeArtifactSelectors(options.select, options.skills);
  if (selectors?.length) entry.select = selectors;
  if (options.skills?.length) entry.skills = normalizeSkillNames(options.skills);
  const installCommand = installCommandForEntry(entry);
  return {
    entry,
    installCommand,
    issueUrl: registrySubmissionUrl(entry, installCommand, options.submissionUrl ?? DEFAULT_REGISTRY_SUBMISSION_URL),
  };
}

export function normalizeCatalogueSource(sourceInput: string): string {
  const source = sourceInput.trim();
  if (!source) throw new Error("Catalogue source is required.");

  const unprefixedGitUrl = source.startsWith("git+http://") || source.startsWith("git+https://")
    ? source.slice("git+".length)
    : source;
  const githubSource = normalizeGitHubUrl(unprefixedGitUrl);
  if (githubSource) return githubSource;
  if (isHttpUrl(unprefixedGitUrl)) return `git:${unprefixedGitUrl}`;
  if (explicitSourcePrefixes.some((prefix) => source.startsWith(prefix))) return source;
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("local:")) {
    throw new Error("Catalogue submissions must use a public source, not a local path.");
  }

  const shorthand = normalizeOwnerRepoShorthand(source);
  if (shorthand) return shorthand;
  throw new Error(`Unsupported catalogue source: ${sourceInput}. Use a GitHub URL, github:owner/repo, git:https://..., skillkit:, vercel:, mcp-registry:, or clawhub:.`);
}

export function inferRegistryEntryType(source: string): RegistryEntryType {
  if (source.startsWith("mcp-registry:")) return "mcp";
  if (source.startsWith("clawhub:")) return "plugin";
  if (source.startsWith("skillkit:") || source.startsWith("vercel:")) return "skill";
  return "package";
}

export function parseRegistryEntryType(value: string): RegistryEntryType {
  const normalized = value.trim().toLowerCase();
  if ((registryEntryTypes as readonly string[]).includes(normalized)) return normalized as RegistryEntryType;
  throw new Error(`Unsupported registry entry type: ${value}. Use ${registryEntryTypes.join(", ")}.`);
}

export function installCommandForEntry(entry: Pick<RegistryEntry, "source" | "type" | "select" | "skills">): string {
  const base = ["agentwheel", "install", entry.source, ...selectorArgsForEntry(entry)];
  if (entry.type === "mcp") return [...base, "--adapter", "claude", "--local", "--dry-run"].map(shellQuoteArg).join(" ");
  if (entry.source.startsWith("clawhub:") || entry.type === "plugin") {
    return [...base, "--adapter", "openclaw", "--local", "--dry-run"].map(shellQuoteArg).join(" ");
  }
  return [...base, "--adapter", "codex", "--local", "--dry-run"].map(shellQuoteArg).join(" ");
}

function registrySubmissionUrl(entry: RegistryEntry, installCommand: string, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("title", `Catalogue submission: ${entry.name}`);
  url.searchParams.set("body", registrySubmissionBody(entry, installCommand));
  return url.toString();
}

function registrySubmissionBody(entry: RegistryEntry, installCommand: string): string {
  const descriptionNote = entry.description
    ? []
    : ["", "Note: add a concise description before submitting."];
  return [
    "## Agentwheel catalogue submission",
    "",
    "Please review this generated registry entry:",
    "",
    "```json",
    JSON.stringify(entry, null, 2),
    "```",
    "",
    "## Verification",
    "",
    `Source: \`${entry.source}\``,
    `Suggested check: \`${installCommand}\``,
    "",
    "## Checklist",
    "",
    "- [ ] The source is public and installable.",
    "- [ ] The description is concise and factual.",
    "- [ ] Tags help discovery.",
    ...descriptionNote,
  ].join("\n");
}

function normalizeGitHubUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const [owner, repoSegment] = segments;
  if (!owner || !repoSegment) return undefined;
  const repo = repoSegment.replace(/\.git$/i, "");
  let ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
  if (segments[2] === "tree" && segments.length > 3) {
    ref = segments.slice(3).join("/");
  }
  return `github:${owner}/${repo}${ref ? `#${ref}` : ""}`;
}

function normalizeOwnerRepoShorthand(value: string): string | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(#[^\s]+)?$/.exec(value);
  if (!match) return undefined;
  return `github:${match[1]}/${match[2]}${match[3] ?? ""}`;
}

function inferRegistryName(source: string): string {
  const withoutRef = source.split("#", 1)[0];
  if (withoutRef.startsWith("github:")) return lastPathSegment(withoutRef.slice("github:".length));
  if (withoutRef.startsWith("git:")) return nameFromGitUrl(withoutRef.slice("git:".length));
  if (withoutRef.startsWith("skillkit:")) return lastPathSegment(withoutRef.slice("skillkit:".length));
  if (withoutRef.startsWith("vercel:")) return lastPathSegment(withoutRef.slice("vercel:".length));
  if (withoutRef.startsWith("mcp-registry:")) return lastPathSegment(withoutRef.slice("mcp-registry:".length));
  if (withoutRef.startsWith("clawhub:")) return lastPathSegment(withoutRef.slice("clawhub:".length));
  return withoutRef;
}

function nameFromGitUrl(value: string): string {
  try {
    return lastPathSegment(new URL(value).pathname);
  } catch {
    return lastPathSegment(value);
  }
}

function lastPathSegment(value: string): string {
  const trimmed = value.replace(/\.git$/i, "").replace(/\/+$/g, "");
  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1) ?? trimmed;
}

function normalizeRegistryName(value: string): string {
  const name = slugify(value);
  if (!name) throw new Error("Registry entry name could not be inferred. Pass --name <short-name>.");
  return name;
}

function normalizeTags(tags: string[]): string[] {
  const normalized = tags
    .flatMap((tag) => tag.split(","))
    .map((tag) => slugify(tag))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function normalizeSkillNames(skills: string[]): string[] {
  return [...new Set(skills.flatMap((skill) => skill.split(",")).map((skill) => skill.trim()).filter(Boolean))];
}

function selectorArgsForEntry(entry: Pick<RegistryEntry, "select" | "skills">): string[] {
  if (entry.skills?.length) return entry.skills.flatMap((skill) => ["--skill", skill]);
  return (entry.select ?? []).flatMap((selector) => ["--select", selector]);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
