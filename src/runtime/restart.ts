import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { InstallPlan, PlanAction } from "../install/plan.js";
import type { WorkspaceRestart } from "../model/workspace.js";
import type { RuntimeTarget } from "./target.js";

const execFileAsync = promisify(execFile);
const restartActions = new Set<PlanAction>(["create", "update", "remove", "program"]);

export interface RuntimeRestartAdvice {
  adapter: string;
  targetRoot: string;
  targetLabel: string;
  kind: "restart" | "session";
  reason: string;
  changedOperations: number;
  command?: string[];
}

export function restartAdviceForPlan(plan: InstallPlan, target: Pick<RuntimeTarget, "adapter" | "agentName" | "targetRoot" | "transport" | "ssh" | "restart">): RuntimeRestartAdvice | undefined {
  const changedOperations = plan.operations.filter((operation) => restartActions.has(operation.action)).length;
  if (changedOperations === 0) return undefined;
  const restart = target.restart;
  const adapter = plan.adapter;
  const targetLabel = target.agentName ?? `${adapter} at ${target.targetRoot}`;
  const command = restartCommand(restart);

  if (restart || isGatewayAdapter(adapter)) {
    return {
      adapter,
      targetRoot: target.targetRoot,
      targetLabel,
      kind: "restart",
      reason: restart?.reason ?? `${adapter} changed; long-running gateways may need a restart to reload generated config, skills, rules, or plugin state.`,
      changedOperations,
      command,
    };
  }

  if (isSessionRuntime(adapter)) {
    return {
      adapter,
      targetRoot: target.targetRoot,
      targetLabel,
      kind: "session",
      reason: `${adapter} changed; already-open sessions may need a new session or app reload to read updated generated files.`,
      changedOperations,
    };
  }

  return undefined;
}

export function formatRestartAdvice(advice: RuntimeRestartAdvice, options: { execute?: boolean; dryRun?: boolean } = {}): string {
  const label = advice.kind === "restart" ? "RESTART" : "SESSION";
  const command = advice.command ? ` Command: ${formatCommand(advice.command)}.` : "";
  const suffix = options.execute
    ? advice.command ? " Running configured command." : " No configured command; advice only."
    : options.dryRun && advice.command ? " Dry-run: command not executed." : "";
  return `${label} ${advice.targetLabel}: ${advice.reason} (${advice.changedOperations} changed operation${advice.changedOperations === 1 ? "" : "s"}).${command}${suffix}`;
}

export async function executeRestartAdvice(advice: RuntimeRestartAdvice, target: Pick<RuntimeTarget, "transport" | "ssh">): Promise<void> {
  if (!advice.command) {
    throw new Error(`No restart command configured for ${advice.targetLabel}`);
  }
  if (target.transport === "ssh") {
    if (!target.ssh) throw new Error(`Missing SSH config for ${advice.targetLabel}`);
    await runSshCommand(target.ssh, advice.command);
    return;
  }
  await execFileAsync(advice.command[0]!, advice.command.slice(1));
}

function restartCommand(restart: WorkspaceRestart | undefined): string[] | undefined {
  if (!restart) return undefined;
  if (restart.command) return restart.command;
  if (!restart.service) return undefined;
  const command = ["systemctl", "restart", restart.service];
  return restart.sudo ? ["sudo", ...command] : command;
}

function isGatewayAdapter(adapter: string): boolean {
  return adapter === "openclaw" || adapter.startsWith("openclaw-") || adapter === "hermes" || adapter.startsWith("hermes-");
}

function isSessionRuntime(adapter: string): boolean {
  return adapter === "claude" || adapter === "codex";
}

function formatCommand(command: string[]): string {
  return command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

async function runSshCommand(config: NonNullable<RuntimeTarget["ssh"]>, command: string[]): Promise<void> {
  const endpoint = config.user ? `${config.user}@${config.host}` : config.host;
  const args = ["-o", "BatchMode=yes"];
  if (config.port) args.push("-p", String(config.port));
  if (config.identityFile) args.push("-i", config.identityFile);
  args.push(endpoint, command.map(quoteSh).join(" "));
  await waitForProcess(spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] }), "ssh");
}

function waitForProcess(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const message = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}${message ? `: ${message}` : ""}`));
    });
  });
}

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
