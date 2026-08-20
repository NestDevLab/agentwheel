import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";
import {
  findExistingWorkspaceRoot,
  fleetIdSchema,
  globalWorkspaceConfigPath,
  readWorkspaceConfig,
  registeredFleetSchema,
  workspaceConfigPath,
  workspaceConfigSchema,
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  type RegisteredFleet,
  type WorkspaceConfig,
} from "./workspace.js";

export type WorkspaceScopeKind = "user" | "local" | "fleet";

export interface WorkspaceScope {
  kind: WorkspaceScopeKind;
  root: string;
  config: WorkspaceConfig;
  fleetId?: string;
}

export interface WorkspaceScopeRequest {
  cwd?: string;
  user?: boolean;
  local?: boolean;
  fleet?: string;
  globalRoot?: string;
}

export interface FleetRegistration extends RegisteredFleet {
  id: string;
}

export interface RegisterFleetRequest {
  id: string;
  root: string;
  requiredPackages: string[];
  globalRoot?: string;
}

export async function resolveWorkspaceScope(request: WorkspaceScopeRequest = {}): Promise<WorkspaceScope> {
  const selected = [request.user === true, request.local === true, request.fleet !== undefined].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Choose exactly one workspace selector: --user, --local, or --fleet <id>.");
  }
  const globalRoot = resolve(request.globalRoot ?? homedir());

  if (request.user) {
    // An explicitly selected user workspace may be empty. This preserves the
    // established bootstrap flow while still rejecting a misplaced fleet config.
    const config = await readWorkspaceConfig(globalRoot);
    assertNonFleetScope("user", config);
    return { kind: "user", root: globalRoot, config };
  }
  if (request.fleet !== undefined) {
    const id = fleetIdSchema.parse(request.fleet);
    const registration = await showRegisteredFleet(id, { globalRoot });
    const root = await assertCanonicalDirectory(registration.root, `Registered fleet '${id}' root`);
    const config = await readRequiredConfig(root, `fleet '${id}'`);
    assertFleetContract(id, registration, config);
    return { kind: "fleet", root, fleetId: id, config };
  }

  const cwd = resolve(request.cwd ?? process.cwd());
  const discoveredRoot = await findExistingWorkspaceRoot(cwd);
  if (!discoveredRoot || discoveredRoot === globalRoot) {
    if (request.local === true && cwd !== globalRoot) {
      return { kind: "local", root: cwd, config: await readWorkspaceConfig(cwd) };
    }
    throw missingScopeError(request.local === true ? "local" : "implicit local");
  }
  const config = await readRequiredConfig(discoveredRoot, "local");
  assertNonFleetScope("local", config);
  return { kind: "local", root: discoveredRoot, config };
}

export async function registerFleet(request: RegisterFleetRequest): Promise<FleetRegistration> {
  const id = fleetIdSchema.parse(request.id);
  const requiredPackages = sortedUnique(request.requiredPackages);
  if (requiredPackages.length === 0) throw new Error("Fleet registration requires at least one --required-package <name>.");
  const globalRoot = resolve(request.globalRoot ?? homedir());
  const home = await readWorkspaceConfig(globalRoot);
  if (home.schemaVersion === 3 && home.fleetId) {
    throw new Error(`The home config is fleet '${home.fleetId}', so it cannot own the global fleet registry.`);
  }
  const existing = home.schemaVersion === 3 ? await canonicalizeExistingFleetRoots(home.fleets, globalRoot) : {};
  if (existing[id]) throw new Error(`Fleet '${id}' is already registered.`);
  const root = await assertCanonicalDirectory(request.root, `Fleet '${id}' root`);
  const duplicateRoot = Object.entries(existing).find(([, value]) => value.root === root);
  if (duplicateRoot) throw new Error(`Fleet root ${root} is already registered as '${duplicateRoot[0]}'.`);
  if (root === globalRoot) throw new Error("A fleet root must be outside the user config root contract.");
  const target = await readRequiredConfig(root, `fleet '${id}'`);
  const registration = registeredFleetSchema.parse({ root, requiredPackages });
  assertFleetContract(id, registration, target);

  const upgraded = workspaceConfigSchema.parse({
    ...home,
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    exports: home.schemaVersion >= 2 ? home.exports : { selections: {} },
    fleets: { ...existing, [id]: registration },
  });
  await writeJsonAtomic(globalWorkspaceConfigPath(globalRoot), upgraded);
  return { id, ...registration };
}

async function canonicalizeExistingFleetRoots(
  fleets: Record<string, RegisteredFleet>,
  globalRoot: string,
): Promise<Record<string, RegisteredFleet>> {
  const canonical = new Map<string, string>();
  const normalized: Record<string, RegisteredFleet> = {};
  for (const [id, registration] of Object.entries(fleets).sort(([a], [b]) => a.localeCompare(b))) {
    const root = await canonicalizeDirectory(registration.root, `Registered fleet '${id}' root`);
    if (root === globalRoot) throw new Error(`Registered fleet '${id}' root must be outside the user config root contract.`);
    const incumbent = canonical.get(root);
    if (incumbent) {
      throw new Error(`Fleet root ${root} is registered more than once as '${incumbent}' and '${id}'.`);
    }
    canonical.set(root, id);
    normalized[id] = registeredFleetSchema.parse({ ...registration, root });
  }
  return normalized;
}

export async function listRegisteredFleets(options: { globalRoot?: string } = {}): Promise<FleetRegistration[]> {
  const globalRoot = resolve(options.globalRoot ?? homedir());
  const home = await readWorkspaceConfig(globalRoot);
  if (home.schemaVersion !== 3) return [];
  return Object.entries(home.fleets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, registration]) => ({ id, ...registration }));
}

export async function showRegisteredFleet(idInput: string, options: { globalRoot?: string } = {}): Promise<FleetRegistration> {
  const id = fleetIdSchema.parse(idInput);
  const fleets = await listRegisteredFleets(options);
  const registration = fleets.find((candidate) => candidate.id === id);
  if (!registration) {
    throw new Error(`Unknown fleet '${id}'. Use 'agentwheel fleet list' or register it with 'agentwheel fleet register'.`);
  }
  return registration;
}

async function readRequiredConfig(root: string, label: string): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath(root);
  if (!(await pathExists(path))) throw missingScopeError(label);
  try {
    return workspaceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`Invalid ${label} Agentwheel config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertFleetContract(id: string, registration: RegisteredFleet, config: WorkspaceConfig): void {
  if (config.schemaVersion !== 3) {
    throw new Error(`Fleet '${id}' config must use schemaVersion 3 before registration or selection.`);
  }
  if (config.fleetId !== id) {
    throw new Error(`Fleet fleetId mismatch: expected '${id}', found '${config.fleetId ?? "missing"}'.`);
  }
  if (Object.keys(config.fleets).length > 0) {
    throw new Error(`Fleet '${id}' config may not contain the home fleets registry.`);
  }
  const names = new Set(config.packages.map((pkg) => pkg.name));
  for (const packageName of registration.requiredPackages) {
    if (!names.has(packageName)) throw new Error(`Fleet '${id}' is missing required package '${packageName}'.`);
  }
}

async function assertCanonicalDirectory(input: string, label: string): Promise<string> {
  const canonical = await canonicalizeDirectory(input, label);
  const normalized = resolve(input);
  const stats = await lstat(input);
  if (stats.isSymbolicLink() || canonical !== normalized || input !== normalized) {
    throw new Error(`${label} must be canonical and symlink-unambiguous: ${input} resolves to ${canonical}.`);
  }
  return canonical;
}

async function canonicalizeDirectory(input: string, label: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error(`${label} must be an absolute canonical path.`);
  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch {
    throw new Error(`${label} does not exist: ${input}`);
  }
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${input}`);
  return canonical;
}

function missingScopeError(label: string): Error {
  return new Error(
    `Missing ${label} Agentwheel workspace config. Select --user, --local, or --fleet <id>, `
    + "or run 'agentwheel init workspace' in the intended local root. Agentwheel never falls back to home desired state.",
  );
}

function assertNonFleetScope(kind: "user" | "local", config: WorkspaceConfig): void {
  if (config.schemaVersion === 3 && config.fleetId) {
    throw new Error(
      `The ${kind} config declares fleetId '${config.fleetId}'. Select it through the registered --fleet <id> scope.`,
    );
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
