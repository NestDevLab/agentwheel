import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 300;
const REGISTRY_URL = "https://registry.npmjs.org/agentwheel";

interface WritableStderr {
  write(message: string): unknown;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  cachePath?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  stderr?: WritableStderr;
  env?: Record<string, string | undefined>;
  argv?: string[];
  isTTY?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
}

interface UpdateCheckCache {
  checkedAt: string;
  latest: string;
}

export async function maybeCheckForUpdate(options: UpdateCheckOptions): Promise<void> {
  if (isDisabled(options)) return;

  const now = options.now?.() ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = options.cachePath ?? join(homedir(), ".agentwheel", "update-check.json");

  try {
    const cached = await readCache(cachePath);
    if (cached && now.getTime() - Date.parse(cached.checkedAt) < ttlMs) {
      warnIfNewer(cached.latest, options.currentVersion, options.stderr);
      return;
    }

    const latest = await fetchLatestVersion(options.fetchImpl ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!latest) return;
    await writeCache(cachePath, { checkedAt: now.toISOString(), latest });
    warnIfNewer(latest, options.currentVersion, options.stderr);
  } catch {
    // Best-effort only: update checks must never break or slow normal commands.
  }
}

function isDisabled(options: UpdateCheckOptions): boolean {
  const env = options.env ?? process.env;
  if (env.AGENTWHEEL_NO_UPDATE_CHECK === "1" || env.AGENTWHEEL_NO_UPDATE_CHECK === "true") return true;
  if (env.CI) return true;
  if (options.argv?.includes("--no-update-check")) return true;
  if (options.argv?.includes("--offline")) return true;
  const isTTY = options.isTTY ?? process.stderr.isTTY === true;
  return !isTTY;
}

async function fetchLatestVersion(fetchImpl: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return undefined;
    const body = await response.json() as { "dist-tags"?: { latest?: unknown } };
    return typeof body["dist-tags"]?.latest === "string" ? body["dist-tags"].latest : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function readCache(path: string): Promise<UpdateCheckCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof parsed.checkedAt !== "string" || typeof parsed.latest !== "string") return undefined;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: UpdateCheckCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function warnIfNewer(latest: string, current: string, stderr: WritableStderr = process.stderr): void {
  if (compareVersions(latest, current) <= 0) return;
  stderr.write(`agentwheel ${latest} is available (you have ${current}). Update: npm i -g agentwheel\n`);
}

export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-", 1)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}
