import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { trustedOpenClawEntry, trustedRunAsCode } from "./run-as-trust.js";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { readFileSync } from "node:fs";
import { hashRunAsCopyPayload, validateRunAsCopyPayload } from "./run-as-staging.js";

export type ReadOperation = "pathExists" | "hashPath" | "readFile" | "listDir" | "ownershipSnapshot";
export interface ReadRequest { version: 1; operation: ReadOperation; path: string }
const relativePath = z.string().min(1).max(4096).refine((path) => path === "." || (!isAbsolute(path)
  && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")), { message: "Run-as path is not a contained relative path." });
const requestSchema = z.object({
  version: z.literal(1),
  operation: z.enum(["pathExists", "hashPath", "readFile", "listDir", "ownershipSnapshot", "probe", "mkdirExclusive", "writeFileAtomic", "copy", "copyWithin", "rm", "validateOpenClawConfig"]),
  path: relativePath,
  validatorRoot: z.string().optional(), validationSnapshot: z.string().optional(), content: z.string().optional(), source: relativePath.optional(), payload: z.unknown().optional(),
}).strict();
export type RunAsRequest = z.infer<typeof requestSchema>;
const snapshotEntrySchema = z.object({ path: z.string(), kind: z.enum(["file", "dir"]), mode: z.number().int().min(0).max(0o7777), content: z.string().optional() }).strict();
const helperPath = fileURLToPath(new URL("./run-as-fs.py", import.meta.url));
const pythonPath = "/usr/bin/python3";
const maxBytes = 20 * 1024 * 1024;

/** Lexical gate; actual filesystem resolution is always delegated to openat2. */
export async function containedReadPath(root: string, requested: string): Promise<string> {
  relativePath.parse(requested);
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Run-as root must be absolute and normalized.");
  return resolve(root, requested);
}

async function filesystem(root: string, uid: number, gid: number, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(pythonPath, ["-I", helperPath, "--root", root, "--uid", String(uid), "--gid", String(gid)],
      { timeout: 120_000, maxBuffer: maxBytes, env: { HOME: root, PATH: "/usr/local/bin:/usr/bin:/bin" } }, (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const response = JSON.parse(stdout) as { version?: number; result?: unknown; error?: { message: string; code?: string } };
          if (response.version !== 1) throw new Error("Invalid confined filesystem response.");
          if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
          if (!("result" in response)) throw new Error("Missing confined filesystem result.");
          resolveResult(response.result);
        } catch (failure) { reject(failure); }
      });
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify({ version: 1, ...request }));
  });
}

function sortedChildren<T extends { path: string }>(entries: T[], directory: string, locale = false): T[] {
  return entries.filter((entry) => entry.path !== "" && posix.dirname(entry.path) === (directory || "."))
    .sort((left, right) => locale ? posix.basename(left.path).localeCompare(posix.basename(right.path))
      : posix.basename(left.path) < posix.basename(right.path) ? -1 : posix.basename(left.path) > posix.basename(right.path) ? 1 : 0);
}

export async function executeRequest(root: string, uid: number, gid: number, input: unknown): Promise<unknown> {
  const request = requestSchema.parse(input);
  await containedReadPath(root, request.path);
  const fs = (operation: string, fields: Record<string, unknown> = {}) => filesystem(root, uid, gid, { operation, path: request.path, ...fields });
  if (["pathExists", "listDir", "mkdirExclusive", "rm", "probe"].includes(request.operation)) return fs(request.operation);
  if (request.operation === "readFile") return Buffer.from(String(await fs("readFile")), "base64").toString("utf8");
  if (request.operation === "hashPath" || request.operation === "ownershipSnapshot") {
    const entries = z.array(snapshotEntrySchema).min(1).max(4096).parse(await fs("snapshot", { includeIgnored: request.operation === "ownershipSnapshot" }));
    if (request.operation === "hashPath") {
      const staged = entries.map((entry) => entry.kind === "dir"
        ? { path: entry.path, kind: "dir" as const, mode: 0o700 as const }
        : { path: entry.path, kind: "file" as const, mode: 0o600 as const, content: entry.content! });
      const payload = { version: 1 as const, kind: entries[0]!.kind, hash: "0".repeat(64), entries: staged };
      payload.hash = hashRunAsCopyPayload(payload);
      return validateRunAsCopyPayload(payload).hash;
    }
    const hash = createHash("sha256");
    const visit = (entry: z.infer<typeof snapshotEntrySchema>): void => {
      hash.update(JSON.stringify([entry.path, entry.kind, entry.mode]));
      if (entry.kind === "dir") for (const child of sortedChildren(entries, entry.path)) visit(child);
      else { const bytes = Buffer.from(entry.content!, "base64"); hash.update(String(bytes.length)).update("\0").update(bytes); }
    };
    if (entries[0]!.path !== "") throw new Error("Invalid ownership snapshot root.");
    visit(entries[0]!);
    return hash.digest("hex");
  }
  if (request.operation === "copy") {
    const payload = validateRunAsCopyPayload(request.payload);
    return fs("installSnapshot", { entries: payload.entries });
  }
  if (request.operation === "copyWithin") {
    if (!request.source) throw new Error("Run-as copyWithin requires a contained source.");
    return fs("copyWithin", { source: request.source });
  }
  if (request.operation === "writeFileAtomic") {
    if (request.content === undefined) throw new Error("Run-as write requires content.");
    return fs("writeFileAtomic", { content: Buffer.from(request.content).toString("base64") });
  }
  // This is the sole subprocess operation; no caller-supplied command or argv exists.
  await fs("readFile"); // Confined regular-file/path verification before validation.
  const groups = [...new Set([gid, ...(process.getgroups?.() ?? [])])];
  const entry = trustedOpenClawEntry(request.validatorRoot ?? "/usr/local/lib/node_modules/openclaw", uid, groups);
  const binary = trustedRunAsCode(process.execPath, uid, groups, "Node executable");
  if (!request.validationSnapshot) throw new Error("OpenClaw validation requires a caller-owned config snapshot.");
  const configPath = trustedRunAsCode(request.validationSnapshot, uid, groups, "validation snapshot");
  assertSelfContainedOpenClawConfig(readFileSync(configPath, "utf8"));
  const result = await new Promise<string>((resolveResult, reject) => {
    execFile(binary, [entry, "config", "validate", "--json"], {
      timeout: 120_000, maxBuffer: maxBytes, cwd: root,
      env: { HOME: root, PATH: "/usr/local/bin:/usr/bin:/bin", OPENCLAW_CONFIG_PATH: configPath },
    }, (error, stdout) => error ? reject(new Error("OpenClaw config validator failed.")) : resolveResult(stdout));
  });
  if (JSON.parse(result)?.valid !== true) throw new Error("OpenClaw config validation failed.");
  return null;
}

export function assertSelfContainedOpenClawConfig(content: string): void {
  const errors: ParseError[] = [];
  const config = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length) throw new Error("local-run-as OpenClaw validation requires valid JSON/JSONC syntax; render a self-contained config.");
  const rejectIncludes = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && Object.hasOwn(value, "$include")) throw new Error("local-run-as OpenClaw validation does not support $include; render a self-contained config.");
    for (const child of Object.values(value)) rejectIncludes(child);
  };
  rejectIncludes(config);
}

export async function executeRead(root: string, request: ReadRequest): Promise<unknown> {
  return executeRequest(root, process.getuid!(), process.getgid!(), request);
}

async function main(): Promise<void> {
  const [flagRoot, root, flagUid, rawUid, flagGid, rawGid] = process.argv.slice(2);
  if (flagRoot !== "--root" || flagUid !== "--uid" || flagGid !== "--gid" || !root || !rawUid || !rawGid || process.argv.length !== 8) throw new Error("Invalid run-as worker arguments.");
  const uid = Number(rawUid), gid = Number(rawGid);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0 || process.getuid?.() !== uid || process.getgid?.() !== gid) throw new Error("Run-as worker UID/GID mismatch.");
  for (const code of [helperPath, pythonPath]) trustedRunAsCode(code, uid, [...new Set([gid, ...(process.getgroups?.() ?? [])])], "helper/interpreter");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > maxBytes) throw new Error("Run-as request exceeds 20 MiB."); chunks.push(chunk); }
  try {
    const result = await executeRequest(root, uid, gid, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(`${JSON.stringify({ version: 1, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, error: { message: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code } })}\n`);
  }
}
if (process.argv[1] && /run-as-worker\.(?:js|mjs|ts)$/.test(process.argv[1])) main().catch((error) => { process.stderr.write(`run-as worker: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
