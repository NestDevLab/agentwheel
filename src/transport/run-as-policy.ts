import type { InstallPlan } from "../install/plan.js";
import type { TargetTransport } from "./types.js";

/** Reject executable adapter/plugin plans before acquiring any target lock. */
export function assertRunAsPlanSupported(plan: InstallPlan, transport: TargetTransport): void {
  if (transport.kind !== "local-run-as") return;
  if (plan.adapterCode || plan.operations.some((operation) => operation.action === "program" || operation.action === "plugin"
    || operation.programmaticOperation || operation.programmaticApply || operation.semanticPlugin || operation.semanticCommand)) {
    throw new Error("local-run-as refuses programmatic adapters and semantic plugin operations before writes.");
  }
}
