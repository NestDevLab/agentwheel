import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { artifactTypeSchema } from "./artifact.js";
import type { ArtifactType, FileKind } from "./artifact.js";
import type { TargetTransport } from "../transport/types.js";

export const targetMappingSchema = z.object({
  dest: z.string().min(1),
  enabled: z.boolean().default(true),
  semantic: z.enum(["openclaw-plugin"]).optional(),
  merge: z.enum(["json-deep", "codex-toml-mcp"]).optional(),
});

const openClawAgentSkillsSchema = z.object({
  enabled: z.boolean().default(false),
  configPath: z.string().min(1).default(".openclaw/openclaw.json"),
  mode: z.enum(["append-managed"]).default("append-managed"),
  agents: z.object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  }).optional(),
  includeAgentsWithoutExplicitSkills: z.boolean().default(false),
});

export const adapterSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  targets: z
    .partialRecord(
      artifactTypeSchema,
      targetMappingSchema,
    )
    .default({}),
  openclaw: z.object({
    agentSkills: openClawAgentSkillsSchema.optional(),
  }).optional(),
});

export type TargetMapping = z.infer<typeof targetMappingSchema>;
export type AdapterConfig = z.infer<typeof adapterSchema> & {
  programmatic?: ProgrammaticAdapterRuntime;
};

export interface ProgrammaticAdapterOperation {
  name: string;
  reason?: string;
  hash?: string;
  data?: unknown;
}

export interface ProgrammaticAdapterArtifact {
  type: ArtifactType;
  name: string;
  installName?: string;
  kind: FileKind;
}

export interface ProgrammaticAdapterContext {
  targetRoot: string;
  adapterName: string;
  transport?: TargetTransport;
  artifacts?: ProgrammaticAdapterArtifact[];
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
  return adapterSchema.parse(parsed);
}
