import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mutationOperationIdSchema } from "./protocol.js";
import { mutationStateRoot } from "./receipts.js";

interface DeclarationState {
  repositoryRoot: string;
  operationId: string;
  journalPath: string;
  paths: Set<string>;
  blockedPaths: Set<string>;
}

let active: DeclarationState | undefined;

export function beginMutationPathDeclarations(
  repositoryRoot: string,
  operationIdInput: string,
  blockedPaths: Iterable<string> = [],
): void {
  if (active) throw new Error("A mutation path declaration scope is already active.");
  const operationId = mutationOperationIdSchema.parse(operationIdInput);
  const root = join(mutationStateRoot(), "declarations");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const journalPath = join(root, `${operationId}.jsonl`);
  const journal = openSync(journalPath, "wx", 0o600);
  try {
    fsyncSync(journal);
  } finally {
    closeSync(journal);
  }
  const directory = openSync(root, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  active = {
    repositoryRoot: resolve(repositoryRoot),
    operationId,
    journalPath,
    paths: new Set(),
    blockedPaths: new Set(blockedPaths),
  };
}

export function resumeMutationPathDeclarations(
  repositoryRoot: string,
  operationIdInput: string,
  blockedPaths: Iterable<string> = [],
): void {
  if (active) throw new Error("A mutation path declaration scope is already active.");
  const operationId = mutationOperationIdSchema.parse(operationIdInput);
  const journalPath = join(mutationStateRoot(), "declarations", `${operationId}.jsonl`);
  const paths = readMutationPathDeclarations(operationId);
  if (paths.length === 0) {
    const journal = openSync(journalPath, "r");
    closeSync(journal);
  }
  active = {
    repositoryRoot: resolve(repositoryRoot),
    operationId,
    journalPath,
    paths: new Set(paths),
    blockedPaths: new Set(blockedPaths),
  };
}

export function declareMutationPath(path: string): void {
  if (!active) return;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  const relativePath = relative(active.repositoryRoot, absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return;
  const normalized = relativePath.split(sep).join("/");
  if (active.blockedPaths.has(normalized)) {
    throw new Error(`Mutation intended path is already dirty and cannot be claimed: ${normalized}.`);
  }
  if (active.paths.has(normalized)) return;
  active.paths.add(normalized);
  const fd = openSync(active.journalPath, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ path: normalized })}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function declaredMutationPaths(): string[] {
  return active ? [...active.paths].sort((a, b) => a.localeCompare(b)) : [];
}

export function endMutationPathDeclarations(): void {
  active = undefined;
}

export function readMutationPathDeclarations(operationIdInput: string): string[] {
  const operationId = mutationOperationIdSchema.parse(operationIdInput);
  const path = join(mutationStateRoot(), "declarations", `${operationId}.jsonl`);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const paths = new Set<string>();
  for (const line of content.split(/\r?\n/u).filter(Boolean)) {
    const record = JSON.parse(line) as { path?: unknown };
    if (typeof record.path !== "string" || !record.path || record.path.startsWith("../") || record.path.includes("\\")) {
      throw new Error(`Invalid mutation declaration journal for '${operationId}'.`);
    }
    paths.add(record.path);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
