import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { artifactTypeSchema, type ArtifactType } from "./artifact.js";

export const defaultInstallationType = "local";

export const installationTypeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "installation type must be a stable path-safe identifier");

export const targetMappingSchema = z.object({
  dest: z.string().min(1),
  enabled: z.boolean().default(true),
  root: z.enum(["target", "home"]).optional(),
  semantic: z.enum(["openclaw-plugin"]).optional(),
  merge: z.enum(["json-deep", "codex-toml-mcp"]).optional(),
});

export const targetRegistrySchema = z.record(installationTypeSchema, targetMappingSchema);
const targetRegistryInputSchema = z.union([
  targetMappingSchema.transform((mapping) => ({ [defaultInstallationType]: mapping })),
  targetRegistrySchema,
]);

export const adapterSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  targets: z
    .partialRecord(
      artifactTypeSchema,
      targetRegistryInputSchema,
    )
    .default({}),
});

export type TargetMapping = z.infer<typeof targetMappingSchema>;
export type TargetRegistry = z.infer<typeof targetRegistrySchema>;
export type AdapterConfig = {
  name: string;
  displayName?: string;
  targets: Partial<Record<ArtifactType, TargetRegistry>>;
  programmatic?: ProgrammaticAdapterRuntime;
};

export interface ProgrammaticAdapterOperation {
  name: string;
  reason?: string;
}

export interface ProgrammaticAdapterContext {
  targetRoot: string;
  adapterName: string;
}

export interface ProgrammaticAdapterRuntime {
  modulePath: string;
  hash: string;
  capabilities: string[];
  plan?: (context: ProgrammaticAdapterContext) => Promise<ProgrammaticAdapterOperation[]> | ProgrammaticAdapterOperation[];
  apply?: (operation: ProgrammaticAdapterOperation, context: ProgrammaticAdapterContext) => Promise<void> | void;
  uninstall?: (context: ProgrammaticAdapterContext) => Promise<void> | void;
}

export type ProgrammaticAdapterApply = NonNullable<ProgrammaticAdapterRuntime["apply"]>;
export type ProgrammaticAdapterUninstall = NonNullable<ProgrammaticAdapterRuntime["uninstall"]>;

export function supportedInstallationTypes(adapter: AdapterConfig, artifactType?: ArtifactType): string[] {
  const registries = artifactType
    ? [adapter.targets[artifactType]]
    : Object.entries(adapter.targets)
      .filter(([type]) => type !== "fragments")
      .map(([, registry]) => registry);
  const types = new Set<string>();
  for (const registry of registries) {
    for (const [installationType, target] of Object.entries(registry ?? {})) {
      if (target.enabled) types.add(installationType);
    }
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

export function resolveInstallationTypeForArtifacts(
  adapter: AdapterConfig,
  artifactTypes: ArtifactType[],
  requested?: string,
): string {
  const installableTypes = [...new Set(artifactTypes.filter((type) => type !== "fragments"))];
  if (installableTypes.length === 0) {
    return requested ?? resolveInstallationTypeForAdapter(adapter, requested);
  }

  for (const type of installableTypes) {
    const supported = supportedInstallationTypes(adapter, type);
    if (supported.length === 0) {
      throw new Error(`Adapter ${adapter.name} does not support ${type} artifacts for any installation type.`);
    }
    if (requested && !supported.includes(requested)) {
      throw new Error(`Adapter ${adapter.name} does not support ${type} artifacts for installation type '${requested}'. Supported: ${supported.join(", ")}`);
    }
  }

  if (requested) return requested;

  const [firstType, ...restTypes] = installableTypes;
  let candidates = new Set(supportedInstallationTypes(adapter, firstType));
  for (const type of restTypes) {
    const supported = new Set(supportedInstallationTypes(adapter, type));
    candidates = new Set([...candidates].filter((candidate) => supported.has(candidate)));
  }

  const available = [...candidates].sort((a, b) => a.localeCompare(b));
  if (available.length === 1) return available[0]!;
  if (available.length === 0) {
    throw new Error(`Adapter ${adapter.name} has no common installation type for: ${installableTypes.join(", ")}`);
  }
  throw new Error(`Installation type required for ${adapter.name}; supported for selected artifacts: ${available.join(", ")}. Pass --installation-type <type>.`);
}

export function resolveInstallationTypeForAdapter(adapter: AdapterConfig, requested?: string): string {
  const supported = supportedInstallationTypes(adapter);
  if (requested) {
    if (!supported.includes(requested)) {
      throw new Error(`Adapter ${adapter.name} does not support installation type '${requested}'. Supported: ${supported.join(", ") || "<none>"}`);
    }
    return requested;
  }
  if (supported.length === 1) return supported[0]!;
  if (supported.length === 0) return defaultInstallationType;
  throw new Error(`Installation type required for ${adapter.name}; supported: ${supported.join(", ")}. Pass --installation-type <type>.`);
}

export function targetMappingForArtifact(
  adapter: AdapterConfig,
  artifactType: ArtifactType,
  installationType: string,
): TargetMapping | undefined {
  return adapter.targets[artifactType]?.[installationType];
}

export function installRootForArtifacts(
  adapter: AdapterConfig,
  targetRoot: string,
  installationType: string,
  artifactTypes: ArtifactType[],
): string {
  const roots = new Set(
    [...new Set(artifactTypes.filter((type) => type !== "fragments"))]
      .map((type) => targetMappingForArtifact(adapter, type, installationType)?.root ?? "target"),
  );
  if (roots.has("home") && roots.has("target")) {
    throw new Error(`Installation type '${installationType}' for ${adapter.name} mixes home-rooted and target-rooted artifacts.`);
  }
  return roots.has("home") ? userHomeRoot() : targetRoot;
}

export function installRootForAdapterInstallationType(
  adapter: AdapterConfig,
  targetRoot: string,
  installationType: string,
): string {
  const roots = new Set<string>();
  for (const registry of Object.values(adapter.targets)) {
    const target = registry?.[installationType];
    if (target?.enabled) roots.add(target.root ?? "target");
  }
  if (roots.has("home") && roots.has("target")) {
    throw new Error(`Installation type '${installationType}' for ${adapter.name} mixes home-rooted and target-rooted artifacts.`);
  }
  return roots.has("home") ? userHomeRoot() : targetRoot;
}

function userHomeRoot(): string {
  return process.env.AGENTWHEEL_TEST_HOME || process.env.HOME || homedir();
}

export async function loadAdapterConfig(path: string): Promise<AdapterConfig> {
  const content = await readFile(path, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Invalid adapter config ${path}: ${details}`);
  }
  return adapterSchema.parse(parsed) as AdapterConfig;
}
