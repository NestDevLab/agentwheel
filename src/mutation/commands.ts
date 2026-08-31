export interface GovernedCommandFlags {
  apply?: boolean;
  recover?: boolean;
  dryRun?: boolean;
}

export type CommandGovernanceMode =
  | "governed-always"
  | "governed-unless-dry-run"
  | "governed-apply"
  | "governed-apply-or-recover"
  | "receipt-recovery"
  | "incidental-cache"
  | "read-only";

// Canonical audit table for every Commander leaf registration in src/cli/index.ts.
// Adding a CLI action without classifying it makes the preAction hook fail closed.
export const commandGovernance = {
  init: "governed-always",
  "fleet register": "governed-always",
  "fleet list": "read-only",
  "fleet show": "read-only",
  "fleet normalize": "governed-apply-or-recover",
  "cache prune": "governed-apply",
  add: "governed-always",
  list: "incidental-cache",
  search: "incidental-cache",
  try: "incidental-cache",
  scan: "incidental-cache",
  plan: "incidental-cache",
  install: "governed-unless-dry-run",
  serve: "incidental-cache",
  sync: "governed-unless-dry-run",
  update: "governed-unless-dry-run",
  "skill update": "governed-unless-dry-run",
  "deps tree": "incidental-cache",
  "deps why": "read-only",
  "registry update": "incidental-cache",
  "registry list": "incidental-cache",
  "registry publish": "read-only",
  "trust forget": "governed-always",
  "package validate": "read-only",
  "package migrate": "governed-always",
  remember: "governed-always",
  "ownership handoff": "governed-unless-dry-run",
  "ownership retire-stale": "governed-apply",
  "mcp retire": "governed-apply",
  eject: "governed-always",
  uninstall: "governed-unless-dry-run",
  status: "read-only",
  "journal list": "read-only",
  "journal abort": "governed-always",
  "mutation check": "read-only",
  "mutation list": "read-only",
  "mutation show": "read-only",
  "mutation finalize": "receipt-recovery",
  "mutation recover": "receipt-recovery",
  "mutation recover-runtime": "receipt-recovery",
  doctor: "read-only",
} as const satisfies Record<string, CommandGovernanceMode>;

export function commandGovernanceMode(path: string): CommandGovernanceMode {
  const mode = (commandGovernance as Record<string, CommandGovernanceMode>)[path];
  if (!mode) throw new Error(`CLI command '${path}' has no mutation-governance classification.`);
  return mode;
}

export function isGovernedCommand(path: string, flags: GovernedCommandFlags = {}): boolean {
  const mode = commandGovernanceMode(path);
  if (mode === "governed-always") return true;
  if (mode === "governed-unless-dry-run") return flags.dryRun !== true;
  if (mode === "governed-apply") return flags.apply === true;
  if (mode === "governed-apply-or-recover") return flags.apply === true || flags.recover === true;
  return false;
}

export function requiresCleanMutationPreflight(path: string): boolean {
  return !new Set([
    "init",
    "fleet register",
    "add",
    "package migrate",
    "remember",
    "journal abort",
  ]).has(path);
}
