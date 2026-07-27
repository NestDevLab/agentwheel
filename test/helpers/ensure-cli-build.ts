import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureCliBuild(cli: string): Promise<void> {
  const key = `agentwheel-test-build-${process.ppid}`;
  const lock = join(tmpdir(), `${key}.lock`);
  const marker = join(tmpdir(), `${key}.done`);
  const started = Date.now();

  while (true) {
    if (await markerMatches(marker, cli)) return;
    try {
      await mkdir(lock);
      try {
        if (!(await markerMatches(marker, cli))) {
          await execFileAsync("pnpm", ["build"], {
            cwd: process.cwd(),
            maxBuffer: 20 * 1024 * 1024,
          });
          const built = await stat(cli);
          await writeFile(marker, String(built.mtimeMs), "utf8");
        }
        return;
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() - started > 30_000) throw new Error(`Timed out waiting for CLI test build lock: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function markerMatches(marker: string, cli: string): Promise<boolean> {
  try {
    const [value, built] = await Promise.all([readFile(marker, "utf8"), stat(cli)]);
    return Number(value) === built.mtimeMs;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "EEXIST";
}
