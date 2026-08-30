import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { z } from "zod";
import { REVISION_PROVIDER_PROTOCOL_VERSION } from "../model/mutation.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableSha256Schema = sha256Schema.nullable();
export const gitCommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const nullableGitCommitShaSchema = gitCommitShaSchema.nullable();

export const mutationOperationIdSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i);

export const mutationReasonSchema = z.string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
    message: "Mutation reasons may not contain control characters",
  });

export const revisionPathSchema = z.object({
  path: z.string().min(1).max(4096).refine(isSafeRepoRelativePath, {
    message: "Revision paths must be normalized repository-relative paths",
  }),
  beforeSha256: nullableSha256Schema,
  afterSha256: nullableSha256Schema,
}).strict().superRefine((entry, ctx) => {
  if (entry.beforeSha256 === entry.afterSha256) {
    ctx.addIssue({ code: "custom", message: "Revision path hashes must describe a change" });
  }
});

const revisionActionSchema = z.enum(["check", "preflight", "finalize", "recover", "release"]);

const requestBase = z.object({
  protocolVersion: z.literal(REVISION_PROVIDER_PROTOCOL_VERSION),
  action: revisionActionSchema,
  operationId: mutationOperationIdSchema,
  repositoryRoot: z.string().min(1).max(4096).refine(isCanonicalAbsolutePath, {
    message: "repositoryRoot must be an absolute normalized path",
  }),
  expectedHead: gitCommitShaSchema,
  expectedManifestDigest: sha256Schema.optional(),
  commandName: z.string().min(1).max(256).refine((value) => !/[\r\n\u0000-\u001f\u007f]/u.test(value), {
    message: "commandName must be a single printable line",
  }),
  reason: mutationReasonSchema,
  noCommit: z.boolean(),
  paths: z.array(revisionPathSchema),
}).strict();

const revisionProviderRequestUnion = z.discriminatedUnion("action", [
  requestBase.extend({ action: z.literal("check") }).strict(),
  requestBase.extend({ action: z.literal("preflight") }).strict(),
  requestBase.extend({ action: z.literal("finalize") }).strict(),
  requestBase.extend({ action: z.literal("recover") }).strict(),
  requestBase.extend({ action: z.literal("release") }).strict(),
]);

export const revisionProviderRequestSchema = revisionProviderRequestUnion.superRefine((request, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of request.paths.entries()) {
    if (seen.has(entry.path)) {
      ctx.addIssue({ code: "custom", path: ["paths", index, "path"], message: `Duplicate revision path: ${entry.path}` });
    }
    seen.add(entry.path);
  }
});

const responseBase = z.object({
  protocolVersion: z.literal(REVISION_PROVIDER_PROTOCOL_VERSION),
  providerId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  action: revisionActionSchema,
  operationId: mutationOperationIdSchema,
  ok: z.literal(true),
  status: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
}).strict();

const terminalResponseFields = {
  expectedHead: gitCommitShaSchema,
  resultingHead: gitCommitShaSchema,
  productCommitSha: nullableGitCommitShaSchema,
  draftStackId: z.string().min(1).max(256).nullable(),
  draftBranch: z.string().min(1).max(1024).refine(isSafeGitBranch, { message: "draftBranch must be a valid branch name" }).nullable(),
  draftTipSha: nullableGitCommitShaSchema,
  controlCommitSha: nullableGitCommitShaSchema,
  manifestDigest: sha256Schema.nullable(),
  unmappedIntegrationCommits: z.array(gitCommitShaSchema).superRefine(rejectDuplicates),
  published: z.literal(false),
};

const terminalErrorResponseFields = {
  expectedHead: nullableGitCommitShaSchema,
  resultingHead: nullableGitCommitShaSchema,
  productCommitSha: nullableGitCommitShaSchema,
  draftStackId: z.string().min(1).max(256).nullable(),
  draftBranch: z.string().min(1).max(1024).refine(isSafeGitBranch, { message: "draftBranch must be a valid branch name" }).nullable(),
  draftTipSha: nullableGitCommitShaSchema,
  controlCommitSha: nullableGitCommitShaSchema,
  manifestDigest: sha256Schema.nullable(),
  unmappedIntegrationCommits: z.array(gitCommitShaSchema).superRefine(rejectDuplicates),
  published: z.literal(false),
};

export const revisionProviderResponseSchema = z.discriminatedUnion("action", [
  responseBase.extend({ action: z.literal("check") }).strict(),
  responseBase.extend({ action: z.literal("preflight") }).strict(),
  responseBase.extend({ action: z.literal("release") }).strict(),
  responseBase.extend({ action: z.literal("finalize"), ...terminalResponseFields }).strict(),
  responseBase.extend({ action: z.literal("recover"), ...terminalResponseFields }).strict(),
]);

const errorResponseBase = z.object({
  protocolVersion: z.literal(REVISION_PROVIDER_PROTOCOL_VERSION),
  providerId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  operationId: z.string().min(1).max(128),
  ok: z.literal(false),
  status: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  error: z.string().min(1).max(4096),
});

const unknownErrorActionSchema = z.string().min(1).max(80).refine(
  (value) => !revisionActionSchema.options.includes(value as z.infer<typeof revisionActionSchema>),
  { message: "Known provider actions must use their action-specific error schema" },
);

export const revisionProviderErrorResponseSchema = z.union([
  errorResponseBase.extend({ action: z.literal("check") }).strict(),
  errorResponseBase.extend({ action: z.literal("preflight") }).strict(),
  errorResponseBase.extend({ action: z.literal("release") }).strict(),
  errorResponseBase.extend({ action: z.literal("finalize"), ...terminalErrorResponseFields }).strict(),
  errorResponseBase.extend({ action: z.literal("recover"), ...terminalErrorResponseFields }).strict(),
  errorResponseBase.extend({ action: unknownErrorActionSchema }).strict(),
]);

export const revisionProviderResultSchema = z.union([
  revisionProviderResponseSchema,
  revisionProviderErrorResponseSchema,
]);

export type RevisionPath = z.infer<typeof revisionPathSchema>;
export type RevisionProviderRequest = z.infer<typeof revisionProviderRequestSchema>;
export type RevisionProviderResponse = z.infer<typeof revisionProviderResponseSchema>;
export type RevisionProviderErrorResponse = z.infer<typeof revisionProviderErrorResponseSchema>;
export type RevisionProviderResult = z.infer<typeof revisionProviderResultSchema>;
export type RevisionProviderAction = z.infer<typeof revisionActionSchema>;

export function revisionRequestDigest(request: RevisionProviderRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function isSafeRepoRelativePath(value: string): boolean {
  if (isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
  const normalized = posix.normalize(value);
  const parts = value.split("/");
  if (normalized !== value || parts.some((part) => part === "" || part === "." || part === "..")) return false;
  const first = value.split("/", 1)[0];
  if (first === ".git") return false;
  if (value === ".syncwheel/manifest.json" || value === ".syncwheel/ledger" || value.startsWith(".syncwheel/ledger/")) return false;
  return true;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value)
    && !value.includes("\0")
    && !/[\r\n]/u.test(value)
    && resolve(value) === value;
}

function isSafeGitBranch(value: string): boolean {
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("@{")) return false;
  if (/[\u0000-\u0020\u007f~^:?*\\[]/u.test(value) || value.includes("..") || value.includes("//")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.endsWith(".lock"));
}

function rejectDuplicates(values: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) ctx.addIssue({ code: "custom", path: [index], message: `Duplicate value: ${value}` });
    seen.add(value);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
