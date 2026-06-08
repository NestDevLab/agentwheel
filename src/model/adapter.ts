import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { artifactTypeSchema } from "./artifact.js";

export const targetMappingSchema = z.object({
  dest: z.string().min(1),
  enabled: z.boolean().default(true),
  semantic: z.enum(["openclaw-plugin"]).optional(),
  merge: z.enum(["json-deep"]).optional(),
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
});

export type TargetMapping = z.infer<typeof targetMappingSchema>;
export type AdapterConfig = z.infer<typeof adapterSchema> & {
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
