import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string | Buffer;
    allowExitCodes?: number[];
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    includeFailureOutput?: boolean;
    timeoutMs?: number;
    inheritedFileDescriptor?: number;
    killProcessGroup?: boolean;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.inheritedFileDescriptor === undefined
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", options.inheritedFileDescriptor],
      detached: useProcessGroup,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const terminate = () => {
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child if the process group already disappeared.
        }
      }
      child.kill("SIGKILL");
    };
    const timeout = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs);
    const collect = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer) => {
      if (outputExceeded) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (options.maxOutputBytes !== undefined
        && (stdoutBytes > options.maxOutputBytes || stderrBytes > options.maxOutputBytes)) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => collect(stdout, "stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect(stderr, "stderr", chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      const exitCode = code ?? 1;
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode };
      if (timedOut) {
        reject(new Error(`${command} exceeded the ${options.timeoutMs}ms execution timeout.`));
        return;
      }
      if (outputExceeded) {
        reject(new Error(`${command} exceeded the provider output limit.`));
        return;
      }
      if (!(options.allowExitCodes ?? [0]).includes(exitCode)) {
        const detail = options.includeFailureOutput === false
          ? ""
          : result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        reject(new Error(`${command} exited ${exitCode}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(result);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
    else child.stdin!.end();
  });
}
