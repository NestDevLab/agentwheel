import { z } from "zod";
import { isAbsolute, resolve } from "node:path";

export const REVISION_PROVIDER_PROTOCOL_VERSION = 1 as const;

const providerIdSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const gitRevisionProviderSchema = z.object({
  kind: z.literal("git"),
  id: providerIdSchema.default("git"),
  protocolVersion: z.literal(REVISION_PROVIDER_PROTOCOL_VERSION),
}).strict();

export const commandRevisionProviderSchema = z.object({
  kind: z.literal("command"),
  id: providerIdSchema,
  command: z.array(z.string().min(1)).min(1).superRefine((command, ctx) => {
    const executable = command[0];
    if (!isAbsolute(executable) || resolve(executable) !== executable || /[\r\n\0]/u.test(executable)) {
      ctx.addIssue({
        code: "custom",
        path: [0],
        message: "Command provider executables must use an absolute normalized path",
      });
    }
  }),
  executableSha256: sha256Schema,
  trustBoundary: z.literal("entrypoint"),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  protocolVersion: z.literal(REVISION_PROVIDER_PROTOCOL_VERSION),
}).strict();

export const revisionProviderConfigSchema = z.discriminatedUnion("kind", [
  gitRevisionProviderSchema,
  commandRevisionProviderSchema,
]);

const revisioningOffSchema = z.object({
  mode: z.literal("off"),
}).strict();

const commitAfterVerifySchema = z.object({
  mode: z.literal("commit-after-verify"),
  allowNoCommitOverride: z.boolean().default(false),
  reasonInCommit: z.literal("full"),
  provider: revisionProviderConfigSchema,
}).strict();

export const mutationPolicySchema = z.object({
  reason: z.enum(["optional", "required"]),
  journal: z.enum(["off", "required"]),
  revisioning: z.discriminatedUnion("mode", [revisioningOffSchema, commitAfterVerifySchema]),
}).strict().superRefine((policy, ctx) => {
  if (policy.revisioning.mode === "commit-after-verify" && policy.journal !== "required") {
    ctx.addIssue({
      code: "custom",
      path: ["journal"],
      message: "commit-after-verify requires durable mutation journaling",
    });
  }
});

export type RevisionProviderConfig = z.infer<typeof revisionProviderConfigSchema>;
export type RevisionProviderConfigInput = z.input<typeof revisionProviderConfigSchema>;
export type MutationPolicy = z.infer<typeof mutationPolicySchema>;
