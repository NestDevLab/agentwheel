import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { TargetTransport } from "../transport/index.js";

export const managedInstructionBlockMode = "managed-block" as const;
export type ManagedInstructionBlockMode = typeof managedInstructionBlockMode;

export const managedInstructionBanner = "<!-- agentwheel-managed: edit fragments, not this block -->";

export interface ManagedInstructionBlockState {
  exists: boolean;
  hasBlock: boolean;
  hash?: string;
  markerHash?: string;
  drifted: boolean;
}

export interface ManagedInstructionBlockMutationOptions {
  expectedHash?: string;
  allowDrift?: boolean;
}

interface LocatedBlock {
  start: number;
  end: number;
  body: string;
  markerHash: string;
}

export async function desiredManagedInstructionBlockHash(sourcePath: string): Promise<string> {
  const source = await readFile(sourcePath, "utf8");
  return hashText(managedBlockBody(source));
}

export async function readManagedInstructionBlockState(
  destPath: string,
  selector: string,
  transport: TargetTransport,
): Promise<ManagedInstructionBlockState> {
  if (!(await transport.pathExists(destPath))) {
    return { exists: false, hasBlock: false, drifted: false };
  }
  const content = await transport.readFile(destPath);
  const block = findManagedInstructionBlock(content, selector);
  if (!block) return { exists: true, hasBlock: false, drifted: false };
  const hash = hashText(block.body);
  return {
    exists: true,
    hasBlock: true,
    hash,
    markerHash: block.markerHash,
    drifted: hash !== block.markerHash,
  };
}

export async function writeManagedInstructionBlock(
  sourcePath: string,
  destPath: string,
  selector: string,
  transport: TargetTransport,
  options: ManagedInstructionBlockMutationOptions = {},
): Promise<string> {
  const source = await readFile(sourcePath, "utf8");
  const desired = renderManagedInstructionBlock(selector, source);
  const existing = await readOptionalText(destPath, transport);
  const merged = upsertManagedInstructionBlock(existing ?? "", selector, desired.block, options);
  await writeTextWithTransport(destPath, merged, transport);
  return desired.hash;
}

export async function removeManagedInstructionBlock(
  destPath: string,
  selector: string,
  transport: TargetTransport,
  options: ManagedInstructionBlockMutationOptions = {},
): Promise<void> {
  if (!(await transport.pathExists(destPath))) return;
  const existing = await transport.readFile(destPath);
  const updated = removeManagedBlockFromContent(existing, selector, options);
  await writeTextWithTransport(destPath, updated, transport);
}

export async function managedInstructionBlockLanded(
  destPath: string,
  selector: string,
  expectedHash: string | undefined,
  transport: TargetTransport,
): Promise<boolean> {
  if (!expectedHash) return false;
  const state = await readManagedInstructionBlockState(destPath, selector, transport);
  return state.exists && state.hasBlock && !state.drifted && state.hash === expectedHash;
}

export async function managedInstructionPhysicalKey(destPath: string, transport: TargetTransport): Promise<string> {
  if (transport.kind !== "local" || !(await transport.pathExists(destPath))) return destPath;
  return realpath(destPath);
}

export async function claudeInstructionBridgesAgents(
  claudePath: string,
  agentsPath: string,
  transport: TargetTransport,
): Promise<boolean> {
  if (!(await transport.pathExists(claudePath))) return false;
  if (await samePhysicalPath(claudePath, agentsPath, transport)) return true;
  const claudeContent = await transport.readFile(claudePath);
  return referencesAgentsMd(claudeContent, claudePath, agentsPath);
}

export function managedInstructionSelector(selector: string | undefined, artifactType: string, artifactName: string): string {
  if (!selector) return `${artifactType}/${artifactName}`;
  const unscoped = selector.split(":").at(-1);
  return unscoped?.includes("/") ? unscoped : selector;
}

function renderManagedInstructionBlock(selector: string, source: string): { block: string; hash: string } {
  const body = managedBlockBody(source);
  const hash = hashText(body);
  return {
    block: `<!-- BEGIN openpack:include ${selector} sha256:${hash} -->\n${body}<!-- END openpack:include ${selector} -->\n`,
    hash,
  };
}

function upsertManagedInstructionBlock(
  content: string,
  selector: string,
  block: string,
  options: ManagedInstructionBlockMutationOptions,
): string {
  const { expectedHash, allowDrift = false } = options;
  const existing = findManagedInstructionBlock(content, selector);
  if (!existing) {
    if (expectedHash) throw new Error(`Managed instruction block missing for ${selector}`);
    return appendManagedInstructionBlock(content, block);
  }
  if (!allowDrift) {
    assertCleanBlock(existing, selector);
    if (expectedHash && hashText(existing.body) !== expectedHash) {
      throw new Error(`Managed instruction block drift detected for ${selector}`);
    }
  }
  return `${content.slice(0, existing.start)}${block}${content.slice(existing.end)}`;
}

function removeManagedBlockFromContent(
  content: string,
  selector: string,
  options: ManagedInstructionBlockMutationOptions,
): string {
  const { expectedHash, allowDrift = false } = options;
  const existing = findManagedInstructionBlock(content, selector);
  if (!existing) return content;
  if (!allowDrift) {
    assertCleanBlock(existing, selector);
    if (expectedHash && hashText(existing.body) !== expectedHash) {
      throw new Error(`Managed instruction block drift detected for ${selector}`);
    }
  }
  return `${content.slice(0, existing.start)}${content.slice(existing.end)}`;
}

function findManagedInstructionBlock(content: string, selector: string): LocatedBlock | undefined {
  const beginPattern = new RegExp(`<!-- BEGIN openpack:include ${escapeRegex(selector)} sha256:([a-f0-9]+) -->\\r?\\n?`);
  const begin = beginPattern.exec(content);
  if (!begin || begin.index === undefined) return undefined;
  const markerHash = begin[1]!;
  const bodyStart = begin.index + begin[0].length;
  const endMarker = `<!-- END openpack:include ${selector} -->`;
  const endIndex = content.indexOf(endMarker, bodyStart);
  if (endIndex < 0) {
    return {
      start: begin.index,
      end: content.length,
      body: content.slice(bodyStart),
      markerHash,
    };
  }
  let blockEnd = endIndex + endMarker.length;
  if (content[blockEnd] === "\r" && content[blockEnd + 1] === "\n") blockEnd += 2;
  else if (content[blockEnd] === "\n") blockEnd += 1;
  return {
    start: begin.index,
    end: blockEnd,
    body: content.slice(bodyStart, endIndex),
    markerHash,
  };
}

function managedBlockBody(source: string): string {
  return `${managedInstructionBanner}\n${ensureTrailingNewline(source)}`;
}

function appendManagedInstructionBlock(content: string, block: string): string {
  if (content.length === 0) return block;
  const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}`;
}

function assertCleanBlock(block: LocatedBlock, selector: string): void {
  const actual = hashText(block.body);
  if (actual !== block.markerHash) {
    throw new Error(`Managed instruction block drift detected for ${selector}`);
  }
}

function referencesAgentsMd(content: string, claudePath: string, agentsPath: string): boolean {
  const claudeDir = dirname(claudePath);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const atImport = /^@import\s+(.+)$/i.exec(line);
    const atPath = /^@(.+AGENTS\.md)$/i.exec(line);
    const referenced = atImport?.[1] ?? atPath?.[1];
    if (!referenced) continue;
    const cleaned = referenced.trim().replace(/^["']|["']$/g, "");
    if (!/AGENTS\.md$/i.test(cleaned)) continue;
    const candidate = cleaned.startsWith("/") ? cleaned : join(claudeDir, cleaned);
    if (relative(dirname(agentsPath), candidate).replaceAll("\\", "/") === "AGENTS.md") return true;
    if (candidate === agentsPath) return true;
  }
  return false;
}

async function samePhysicalPath(left: string, right: string, transport: TargetTransport): Promise<boolean> {
  if (transport.kind !== "local") return false;
  if (!(await transport.pathExists(left)) || !(await transport.pathExists(right))) return false;
  return (await realpath(left)) === (await realpath(right));
}

async function readOptionalText(path: string, transport: TargetTransport): Promise<string | undefined> {
  if (!(await transport.pathExists(path))) return undefined;
  return transport.readFile(path);
}

async function writeTextWithTransport(path: string, content: string, transport: TargetTransport): Promise<void> {
  if (transport.kind === "local") {
    await transport.writeFileAtomic(path, content);
    return;
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-instructions-"));
  const localPath = join(tempRoot, basename(path) || "instructions.md");
  try {
    await writeFile(localPath, content, "utf8");
    await transport.atomicCopy(localPath, path, "file");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
