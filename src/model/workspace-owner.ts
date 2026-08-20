import { Buffer } from "node:buffer";
import { isAbsolute, resolve } from "node:path";

const workspaceOwnerPrefix = "workspace-root:";
const fleetOwnerSeparator = "|fleet-id:";
const encodedRootPrefix = "v2:";
const fleetIdPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const base64UrlPattern = /^[a-z0-9_-]+$/i;

export interface ParsedWorkspaceOwner {
  root: string;
  fleetId?: string;
}

export function workspaceOwnerForRoot(workspaceRoot: string, fleetId?: string): string {
  const root = resolve(workspaceRoot);
  const encodedRoot = root.includes(fleetOwnerSeparator)
    ? `${encodedRootPrefix}${Buffer.from(root, "utf8").toString("base64url")}`
    : root;
  const legacy = `${workspaceOwnerPrefix}${encodedRoot}`;
  return fleetId ? `${legacy}${fleetOwnerSeparator}${fleetId}` : legacy;
}

export function parseWorkspaceOwner(value: string): ParsedWorkspaceOwner | undefined {
  if (!value.startsWith(workspaceOwnerPrefix)) return undefined;
  const encoded = value.slice(workspaceOwnerPrefix.length);
  const separator = encoded.lastIndexOf(fleetOwnerSeparator);
  const encodedRoot = separator === -1 ? encoded : encoded.slice(0, separator);
  const fleetId = separator === -1 ? undefined : encoded.slice(separator + fleetOwnerSeparator.length);
  const rootValue = decodeRoot(encodedRoot);
  if (!rootValue || !isAbsolute(rootValue) || resolve(rootValue) !== rootValue) return undefined;
  if (fleetId !== undefined && !fleetIdPattern.test(fleetId)) return undefined;
  return { root: rootValue, ...(fleetId ? { fleetId } : {}) };
}

function decodeRoot(value: string): string | undefined {
  if (!value.startsWith(encodedRootPrefix)) return value;
  const payload = value.slice(encodedRootPrefix.length);
  if (!base64UrlPattern.test(payload)) return undefined;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64url") === payload ? decoded : undefined;
}
