import { AsyncLocalStorage } from "node:async_hooks";

export type ReadEffectPolicy = "observe" | "refresh";
const contexts = new AsyncLocalStorage<ReadEffectPolicy>();

export function readEffectPolicy(options: { refresh?: boolean; offline?: boolean }): ReadEffectPolicy {
  return options.refresh === true && options.offline !== true ? "refresh" : "observe";
}

export function withReadEffects<T>(options: { refresh?: boolean; offline?: boolean }, action: () => T): T {
  return contexts.run(readEffectPolicy(options), action);
}

export function isObservation(): boolean { return contexts.getStore() === "observe"; }

export function requireRefreshEffect(effect: string): void {
  if (isObservation()) throw new Error(`Observation refuses ${effect}. Use an explicit --refresh to update caches.`);
}

// Conservative early suppression of the optional update notifier. Actual admission is scoped by the parsed action.
export function isObservationInvocation(argv: string[]): boolean {
  return argv.includes("status") && readEffectPolicy({ refresh: argv.includes("--refresh"), offline: argv.includes("--offline") }) === "observe";
}
