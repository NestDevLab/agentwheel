import { isAbsolute, relative, resolve } from "node:path";
import type { InstallOperation } from "./plan.js";

export function assertSafeInstallName(name: string, label: string): void {
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid install name for ${label}: ${JSON.stringify(name)}`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid install name for ${label}: path separators are not allowed (${JSON.stringify(name)})`);
  }
}

export function assertOperationContained(operation: Pick<InstallOperation, "destPath" | "relativeDestPath">, targetRoot: string): void {
  const root = resolve(targetRoot);
  const dest = resolve(operation.destPath);
  const rel = relative(root, dest);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`Refusing operation outside target root: ${operation.relativeDestPath} -> ${operation.destPath}`);
}
