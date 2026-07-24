import type {
  CatalogueProvenance,
  EnrichedCatalogue,
  EnrichedCatalogueEntry,
  Installability,
  SearchEcosystem,
  SearchResult,
  SearchType,
  VercelCatalogue,
  VercelCatalogueEntry,
} from "../model/catalogue.js";
import type { RegistryEntry } from "../model/registry.js";

const SCORE = {
  exactName: 10_000,
  namePrefix: 5_000,
  namePhrase: 3_000,
  tagProvidesPhrase: 2_000,
  descriptionPhrase: 1_000,
  typeEcosystemPhrase: 800,
  repositoryPhrase: 400,
  nameToken: 300,
  nameTokenPrefix: 200,
  tagProvidesToken: 180,
  descriptionToken: 80,
  typeEcosystemToken: 60,
  repositoryToken: 40,
  allTerms: 500,
} as const;

const PROVENANCE_ORDER: CatalogueProvenance[] = ["registry", "enriched", "vercel"];
const MATCHED_FIELD_ORDER = ["name", "tags", "provides", "description", "type", "ecosystem", "repository"];

export interface SearchEntry {
  id: string;
  name: string;
  description: string;
  type: SearchType;
  ecosystem?: SearchEcosystem;
  tags: string[];
  provides: string[];
  source?: string;
  repoUrl?: string;
  installCommand?: string;
  installability: Installability;
  provenances: CatalogueProvenance[];
  archived: boolean;
  featured: boolean;
  stars?: number;
  lastPush?: string;
  alternateDescriptions: string[];
  descriptionRank: number;
  hasRegistrySelectors: boolean;
}

export interface BuildSearchEntriesInput {
  registry?: RegistryEntry[];
  enriched?: EnrichedCatalogue | EnrichedCatalogueEntry[];
  vercel?: VercelCatalogue | VercelCatalogueEntry[];
}

export interface SearchEntriesOptions {
  type?: SearchType;
  ecosystem?: SearchEcosystem;
  limit?: number;
  includeArchived?: boolean;
}

export function buildSearchEntries(input: BuildSearchEntriesInput): SearchEntry[] {
  const enriched = catalogueEntries(input.enriched);
  const vercel = catalogueEntries(input.vercel);
  assertUniqueIdentities(enriched.map((entry) => entry.id), "enriched catalogue");
  assertUniqueIdentities(vercel.map((entry) => `${entry.o}/${entry.r}/${entry.s}`), "Vercel catalogue");
  const records = [
    ...(input.registry ?? []).map(normalizeRegistryEntry),
    ...enriched.map(normalizeEnrichedEntry),
    ...vercel.map(normalizeVercelEntry),
  ];
  const byId = new Map<string, SearchEntry>();

  for (const record of records) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? mergeEntry(existing, record) : record);
  }

  // Name-only merging is unsafe. The one permitted fallback is a selector-free
  // registry record whose literal name and canonical source identify one entry.
  for (const [registryId, registryEntry] of [...byId]) {
    if (
      registryEntry.provenances.length !== 1
      || registryEntry.provenances[0] !== "registry"
      || registryEntry.hasRegistrySelectors
      || !registryEntry.source
    ) {
      continue;
    }
    const canonicalSource = canonicalizeSource(registryEntry.source);
    const candidates = [...byId.entries()].filter(([candidateId, candidate]) =>
      candidateId !== registryId
      && !candidate.provenances.includes("registry")
      && candidate.name === registryEntry.name
      && candidate.source !== undefined
      && canonicalizeSource(candidate.source) === canonicalSource,
    );
    if (candidates.length !== 1) continue;

    const [candidateId, candidate] = candidates[0]!;
    byId.set(candidateId, mergeEntry(registryEntry, candidate, candidateId));
    byId.delete(registryId);
  }

  return [...byId.values()].sort(compareStableEntries);
}

export function searchEntries(
  entries: SearchEntry[],
  query: string,
  options: SearchEntriesOptions = {},
): SearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);
  if (!normalizedQuery || queryTokens.length === 0) return [];

  const results = entries
    .filter((entry) => options.includeArchived || !entry.archived)
    .filter((entry) => options.type === undefined || entry.type === options.type)
    .filter((entry) => options.ecosystem === undefined || entry.ecosystem === options.ecosystem)
    .map((entry) => ({ entry, result: scoreEntry(entry, normalizedQuery, queryTokens) }))
    .filter(({ result }) => result.score > 0)
    .sort((a, b) =>
      b.result.score - a.result.score
      || Number(b.entry.featured) - Number(a.entry.featured)
      || (b.entry.stars ?? Number.NEGATIVE_INFINITY) - (a.entry.stars ?? Number.NEGATIVE_INFINITY)
      || compareText(b.entry.lastPush ?? "", a.entry.lastPush ?? "")
      || compareText(normalizeSearchText(a.result.name), normalizeSearchText(b.result.name))
      || compareText(a.result.id, b.result.id),
    )
    .map(({ result }) => result);

  const limit = options.limit === undefined
    ? 20
    : Math.min(100, Math.max(0, Math.trunc(options.limit)));
  return results.slice(0, limit);
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? [...new Set(normalized.split(" "))] : [];
}

function normalizeRegistryEntry(entry: RegistryEntry): SearchEntry {
  return {
    id: `registry:${entry.name}`,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    ecosystem: inferEcosystem(entry.source),
    tags: sortedUniqueStrings(entry.tags),
    provides: [],
    source: entry.source,
    installCommand: `npx agentwheel install ${shellQuote(entry.name)}`,
    installability: "registry",
    provenances: ["registry"],
    archived: false,
    featured: false,
    alternateDescriptions: [],
    descriptionRank: 2,
    hasRegistrySelectors: Boolean(entry.select?.length || entry.skills?.length),
  };
}

function normalizeEnrichedEntry(entry: EnrichedCatalogueEntry): SearchEntry {
  const source = nonEmpty(entry.source);
  const installCommand = enrichedInstallCommand(entry, source);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? "",
    type: entry.type ?? inferType(entry.ecosystem),
    ecosystem: entry.ecosystem ?? undefined,
    tags: sortedUniqueStrings(entry.tags ?? []),
    provides: sortedUniqueStrings(entry.provides ?? []),
    source,
    repoUrl: nonEmpty(entry.repoUrl),
    installCommand,
    installability: source || installCommand ? "source" : "informational",
    provenances: ["enriched"],
    archived: entry.archived ?? false,
    featured: entry.featured ?? false,
    stars: entry.stars ?? undefined,
    lastPush: nonEmpty(entry.lastPush),
    alternateDescriptions: [],
    descriptionRank: 3,
    hasRegistrySelectors: false,
  };
}

function normalizeVercelEntry(entry: VercelCatalogueEntry): SearchEntry {
  const path = `${entry.o}/${entry.r}/${entry.s}`;
  const source = `vercel:skills.sh/${path}`;
  return {
    id: `vercel:${path}`,
    name: entry.s,
    description: entry.d ?? "",
    type: "skill",
    ecosystem: "vercel",
    tags: [],
    provides: ["skills"],
    source,
    repoUrl: `https://github.com/${entry.o}/${entry.r}`,
    installCommand: `npx agentwheel install ${shellQuote(source)}`,
    installability: "source",
    provenances: ["vercel"],
    archived: false,
    featured: false,
    alternateDescriptions: [],
    descriptionRank: 1,
    hasRegistrySelectors: false,
  };
}

function mergeEntry(first: SearchEntry, second: SearchEntry, id = first.id): SearchEntry {
  const primary = second.description && second.descriptionRank > first.descriptionRank ? second : first;
  const secondary = primary === first ? second : first;
  const descriptions = uniqueStrings([
    primary.description,
    ...primary.alternateDescriptions,
    secondary.description,
    ...secondary.alternateDescriptions,
  ]).filter(Boolean);
  const description = descriptions[0] ?? "";
  return {
    id,
    name: first.name || second.name,
    description,
    type: first.type ?? second.type,
    ecosystem: first.ecosystem ?? second.ecosystem,
    tags: sortedUniqueStrings([...first.tags, ...second.tags]),
    provides: sortedUniqueStrings([...first.provides, ...second.provides]),
    source: first.source ?? second.source,
    repoUrl: first.repoUrl ?? second.repoUrl,
    installCommand: first.installCommand ?? second.installCommand,
    installability: betterInstallability(first.installability, second.installability),
    provenances: PROVENANCE_ORDER.filter((provenance) =>
      first.provenances.includes(provenance) || second.provenances.includes(provenance),
    ),
    archived: first.archived || second.archived,
    featured: first.featured || second.featured,
    stars: maxDefined(first.stars, second.stars),
    lastPush: maxText(first.lastPush, second.lastPush),
    alternateDescriptions: descriptions.slice(1),
    descriptionRank: Math.max(first.descriptionRank, second.descriptionRank),
    hasRegistrySelectors: first.hasRegistrySelectors || second.hasRegistrySelectors,
  };
}

function scoreEntry(entry: SearchEntry, query: string, queryTokens: string[]): SearchResult {
  let score = 0;
  const matched = new Set<string>();
  const name = normalizeSearchText(entry.name);
  const descriptions = [entry.description, ...entry.alternateDescriptions].map(normalizeSearchText);
  const tags = entry.tags.map(normalizeSearchText);
  const provides = entry.provides.map(normalizeSearchText);
  const type = normalizeSearchText(entry.type);
  const ecosystem = normalizeSearchText(entry.ecosystem ?? "");
  const repositories = [entry.source ?? "", entry.repoUrl ?? ""].map(normalizeSearchText);

  if (name === query) {
    score += SCORE.exactName;
    matched.add("name");
  } else if (name.startsWith(query)) {
    score += SCORE.namePrefix;
    matched.add("name");
  } else if (name.includes(query)) {
    score += SCORE.namePhrase;
    matched.add("name");
  }
  const tagsPhraseMatch = matchesPhrase(tags, query);
  const providesPhraseMatch = matchesPhrase(provides, query);
  if (tagsPhraseMatch || providesPhraseMatch) {
    score += SCORE.tagProvidesPhrase;
    if (tagsPhraseMatch) matched.add("tags");
    if (providesPhraseMatch) matched.add("provides");
  }
  if (matchesPhrase(descriptions, query)) {
    score += SCORE.descriptionPhrase;
    matched.add("description");
  }
  const typePhraseMatch = type.includes(query);
  const ecosystemPhraseMatch = ecosystem.includes(query);
  if (typePhraseMatch || ecosystemPhraseMatch) {
    score += SCORE.typeEcosystemPhrase;
    if (typePhraseMatch) matched.add("type");
    if (ecosystemPhraseMatch) matched.add("ecosystem");
  }
  if (matchesPhrase(repositories, query)) {
    score += SCORE.repositoryPhrase;
    matched.add("repository");
  }

  const nameTokens = name.split(" ");
  const tagTokenText = tags.join(" ");
  const provideTokenText = provides.join(" ");
  const descriptionTokenText = descriptions.join(" ");
  const repositoryTokenText = repositories.join(" ");
  let allTermsCovered = true;

  for (const token of queryTokens) {
    const nameTokenMatch = includesToken(name, token);
    if (nameTokenMatch) {
      score += SCORE.nameToken;
      matched.add("name");
    } else if (nameTokens.some((candidate) => candidate.startsWith(token))) {
      score += SCORE.nameTokenPrefix;
      matched.add("name");
    }
    const tagTokenMatch = includesToken(tagTokenText, token);
    const provideTokenMatch = includesToken(provideTokenText, token);
    if (tagTokenMatch || provideTokenMatch) {
      score += SCORE.tagProvidesToken;
      if (tagTokenMatch) matched.add("tags");
      if (provideTokenMatch) matched.add("provides");
    }
    const descriptionTokenMatch = includesToken(descriptionTokenText, token);
    if (descriptionTokenMatch) {
      score += SCORE.descriptionToken;
      matched.add("description");
    }
    const typeTokenMatch = includesToken(type, token);
    const ecosystemTokenMatch = includesToken(ecosystem, token);
    if (typeTokenMatch || ecosystemTokenMatch) {
      score += SCORE.typeEcosystemToken;
      if (typeTokenMatch) matched.add("type");
      if (ecosystemTokenMatch) matched.add("ecosystem");
    }
    const repositoryTokenMatch = includesToken(repositoryTokenText, token);
    if (repositoryTokenMatch) {
      score += SCORE.repositoryToken;
      matched.add("repository");
    }
    if (
      !nameTokenMatch
      && !tagTokenMatch
      && !provideTokenMatch
      && !descriptionTokenMatch
      && !typeTokenMatch
      && !ecosystemTokenMatch
      && !repositoryTokenMatch
    ) {
      allTermsCovered = false;
    }
  }

  if (allTermsCovered) {
    score += SCORE.allTerms;
  }

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    ...(entry.ecosystem ? { ecosystem: entry.ecosystem } : {}),
    tags: entry.tags,
    provides: entry.provides,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.repoUrl ? { repoUrl: entry.repoUrl } : {}),
    ...(entry.installCommand ? { installCommand: entry.installCommand } : {}),
    installability: entry.installability,
    provenances: entry.provenances,
    score,
    matchedFields: MATCHED_FIELD_ORDER.filter((field) => matched.has(field)),
  };
}

function catalogueEntries<T>(catalogue: { entries: T[] } | T[] | undefined): T[] {
  if (!catalogue) return [];
  return Array.isArray(catalogue) ? catalogue : catalogue.entries;
}

function canonicalizeSource(source: string): string {
  const value = source.normalize("NFKC").trim();
  const github = value.match(
    /^(?:github:|git:(?:git\+)?https?:\/\/github\.com\/|(?:git\+)?https?:\/\/github\.com\/)([^/#]+)\/([^#]+?)(?:#(.*))?$/i,
  );
  if (github) {
    const owner = github[1]!.toLowerCase();
    const repository = github[2]!.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    const ref = github[3];
    return `github:${owner}/${repository}${ref === undefined ? "" : `#${ref}`}`;
  }
  return value.replace(/\/+$/, "");
}

function inferEcosystem(source: string): SearchEcosystem | undefined {
  const canonical = canonicalizeSource(source);
  if (canonical.startsWith("vercel:")) return "vercel";
  if (canonical.startsWith("mcp-registry:")) return "mcp-registry";
  if (canonical.startsWith("clawhub:")) return "clawhub";
  if (canonical.startsWith("skillkit:")) return "skillkit";
  return undefined;
}

function inferType(ecosystem: SearchEcosystem | null): SearchType {
  if (ecosystem === "vercel" || ecosystem === "skillkit") return "skill";
  if (ecosystem === "mcp-registry") return "mcp";
  if (ecosystem === "clawhub") return "plugin";
  return "package";
}

function betterInstallability(a: Installability, b: Installability): Installability {
  const rank: Record<Installability, number> = { registry: 3, source: 2, informational: 1 };
  return rank[a] >= rank[b] ? a : b;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedUniqueStrings(values: string[]): string[] {
  return uniqueStrings(values).sort(compareText);
}

function enrichedInstallCommand(
  entry: EnrichedCatalogueEntry,
  source: string | undefined,
): string | undefined {
  const catalogueCommand = nonEmpty(entry.installCommand);
  if (!source) return catalogueCommand;
  if (entry.ecosystem === "mcp-registry" || entry.ecosystem === "clawhub") {
    return catalogueCommand ?? `npx agentwheel install ${shellQuote(source)}`;
  }
  return `npx agentwheel install ${shellQuote(source)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function matchesPhrase(fields: string[], query: string): boolean {
  return fields.some((field) => field.includes(query));
}

function compareStableEntries(a: SearchEntry, b: SearchEntry): number {
  return compareText(normalizeSearchText(a.name), normalizeSearchText(b.name))
    || compareText(a.id, b.id);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function maxText(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

function assertUniqueIdentities(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Duplicate ${label} id: ${id}`);
    seen.add(id);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function includesToken(normalizedText: string, token: string): boolean {
  return normalizedText === token
    || normalizedText.startsWith(`${token} `)
    || normalizedText.endsWith(` ${token}`)
    || normalizedText.includes(` ${token} `);
}
