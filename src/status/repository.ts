import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryStatus {
  available: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  error?: string;
}

export async function collectRepositoryStatus(workspaceRoot: string): Promise<RepositoryStatus> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "status", "--porcelain=v2", "--branch"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const branch = valueAfter(lines, "# branch.head ");
    const head = valueAfter(lines, "# branch.oid ");
    const upstream = valueAfter(lines, "# branch.upstream ");
    const ab = valueAfter(lines, "# branch.ab ");
    const match = ab ? /^\+(\d+)\s+-(\d+)$/.exec(ab) : undefined;
    return {
      available: true,
      branch: branch === "(detached)" ? null : branch,
      head: head === "(initial)" ? null : head,
      upstream,
      ahead: match ? Number(match[1]) : 0,
      behind: match ? Number(match[2]) : 0,
      dirtyCount: lines.filter((line) => !line.startsWith("# ")).length,
    };
  } catch (error) {
    return {
      available: false,
      branch: null,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function valueAfter(lines: string[], prefix: string): string | null {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
}
