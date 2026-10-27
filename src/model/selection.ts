import type { Artifact, ArtifactType } from "./artifact.js";
import { artifactTypeSchema } from "./artifact.js";

export type ArtifactSelector = `${ArtifactType}/${string}`;

export function artifactSelectorKey(artifact: Pick<Artifact, "type" | "name">): ArtifactSelector {
  return `${artifact.type}/${artifact.name}` as ArtifactSelector;
}

export function artifactSelectorAliases(artifact: Pick<Artifact, "type" | "name" | "kind">): ArtifactSelector[] {
  const primary = artifactSelectorKey(artifact);
  if (artifact.type !== "subagents") return [primary];

  const baseName = subagentBaseName(artifact.name);
  if (baseName === artifact.name) return [primary];
  return [primary, `subagents/${baseName}` as ArtifactSelector];
}

export function normalizeArtifactSelectors(select?: string[], legacySkills?: string[]): ArtifactSelector[] | undefined {
  const selected = [
    ...(select ?? []),
    ...(legacySkills ?? []).map((name) => `skills/${name}`),
  ].flatMap(splitSelectorList);
  if (selected.length === 0) return undefined;
  return [...new Set(selected.map(parseArtifactSelector))];
}

export function skillNamesToSelectors(skills?: string[]): ArtifactSelector[] | undefined {
  if (!skills?.length) return undefined;
  return normalizeArtifactSelectors(undefined, skills);
}

export function filterArtifactsBySelection(
  artifacts: Artifact[],
  selectors?: string[],
  legacySkills?: string[],
  options: { validationArtifacts?: Artifact[] } = {},
): Artifact[] {
  const selected = normalizeArtifactSelectors(selectors, legacySkills);
  if (!selected?.length) return artifacts;

  const selectedSet = new Set(selected);
  const available = new Set((options.validationArtifacts ?? artifacts).flatMap(artifactSelectorAliases));
  const missing = selected.filter((selector) => !available.has(selector));
  if (missing.length > 0) {
    throw new Error(`Selected artifact not found in package: ${missing.join(", ")}`);
  }

  return artifacts.filter((artifact) => artifact.required || artifactSelectorAliases(artifact).some((selector) => selectedSet.has(selector)));
}

export function splitSelectorList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArtifactSelector(value: string): ArtifactSelector {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid artifact selector: ${value}. Expected <type>/<name>.`);
  }
  const type = value.slice(0, slash);
  const name = value.slice(slash + 1);
  const parsedType = artifactTypeSchema.safeParse(type);
  if (!parsedType.success) {
    throw new Error(`Invalid artifact selector type: ${type}`);
  }
  return `${parsedType.data}/${name}` as ArtifactSelector;
}

function subagentBaseName(name: string): string {
  return name
    .replace(/\.agent\.md$/i, "")
    .replace(/\.toml$/i, "")
    .replace(/\.md$/i, "");
}
