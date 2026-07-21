import type { InstallPlan } from "../install/plan.js";
import type { TargetTransport } from "../transport/index.js";
import type { RuntimeTarget } from "./target.js";

export interface RuntimeReloadOptions {
  enabled?: boolean;
  executePlugins?: boolean;
}

export function hasExecutedSemanticPluginChanges(plan: InstallPlan, options: RuntimeReloadOptions = {}): boolean {
  return plan.operations.some((operation) => {
    if (operation.action === "plugin") return options.executePlugins === true;
    if (operation.action === "remove" && operation.semanticPlugin) return operation.execute !== false;
    return false;
  });
}

export async function reloadRuntimeAfterPluginChanges(
  plan: InstallPlan,
  target: RuntimeTarget,
  transport: TargetTransport,
  options: RuntimeReloadOptions = {},
): Promise<boolean> {
  if (!options.enabled) return false;
  if (!hasExecutedSemanticPluginChanges(plan, options)) return false;

  const commands = target.reloadCommands ?? [];
  if (commands.length === 0) {
    throw new Error(`--reload-runtimes requested for ${targetLabel(target)} but no reloadCommands are configured on the agent or profile runtime.`);
  }
  if (!transport.execFile) {
    throw new Error(`Cannot reload ${targetLabel(target)} over ${transport.description}: transport does not support command execution.`);
  }

  for (const [command, ...args] of commands) {
    if (!command) throw new Error(`Invalid empty reload command for ${targetLabel(target)}.`);
    await transport.execFile(command, args, { cwd: target.targetRoot });
  }
  return true;
}

export function formatReloadCommands(commands: string[][] | undefined): string {
  return (commands ?? []).map((command) => command.join(" ")).join(" && ");
}

function targetLabel(target: RuntimeTarget): string {
  return target.targetKey ?? target.agentName ?? `${target.adapter} at ${target.targetRoot}`;
}
