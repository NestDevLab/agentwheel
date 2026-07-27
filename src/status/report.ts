import { z } from "zod";

export const statusHealthSchema = z.enum([
  "PASS",
  "WARN",
  "FAIL",
  "STALE",
  "DEGRADED",
  "INCOMPATIBLE",
  "BUSY",
]);

export const statusPackageSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  mode: z.enum(["pinned", "tracking"]),
  policy: z.string().min(1),
  installed: z.string().nullable(),
  locked: z.string().nullable(),
  latestAllowed: z.string().nullable(),
  latestOverall: z.string().nullable(),
  availability: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  checkedAt: z.string().nullable(),
  error: z.string().optional(),
  updateAvailableAllowed: z.boolean(),
  updateAvailableOverall: z.boolean(),
});

export const statusArtifactSchema = z.object({
  selector: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  installName: z.string().min(1),
  packageName: z.string().nullable(),
  packageVersion: z.string().nullable(),
  hash: z.string().min(16),
  installed: z.boolean(),
});

export const statusTargetSchema = z.object({
  adapter: z.string().min(1),
  installationType: z.string().min(1),
  targetRoot: z.string().min(1),
  health: statusHealthSchema,
  manifestRevision: z.string().nullable(),
  manifestEntryCount: z.number().int().nonnegative(),
  graphLockPath: z.string().nullable(),
  packageCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  driftCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  packages: z.array(statusPackageSchema),
  artifacts: z.array(statusArtifactSchema),
});

export type StatusHealth = z.infer<typeof statusHealthSchema>;
export type StatusPackage = z.infer<typeof statusPackageSchema>;
export type StatusTarget = z.infer<typeof statusTargetSchema>;

export interface StatusMember {
  id: string;
  transport: "local" | "ssh";
  workspace: string;
  profile: string;
  health: StatusHealth;
  agentwheelVersion: string | null;
  checkedAt: string | null;
  stale: boolean;
  error?: string;
  report?: StatusReport;
}

export interface StatusReport {
  schemaVersion: 1;
  command: "status";
  agentwheelVersion: string;
  generatedAt: string;
  workspace: string;
  profile: string | null;
  health: StatusHealth;
  repository: {
    available: boolean;
    branch: string | null;
    head: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    dirtyCount: number;
    error?: string;
  };
  targets: StatusTarget[];
  members: StatusMember[];
}

export const statusReportSchema: z.ZodType<StatusReport> = z.lazy(() => z.object({
  schemaVersion: z.literal(1),
  command: z.literal("status"),
  agentwheelVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  workspace: z.string().min(1),
  profile: z.string().nullable(),
  health: statusHealthSchema,
  repository: z.object({
    available: z.boolean(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    dirtyCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
  targets: z.array(statusTargetSchema),
  members: z.array(z.object({
    id: z.string().min(1),
    transport: z.enum(["local", "ssh"]),
    workspace: z.string().min(1),
    profile: z.string().min(1),
    health: statusHealthSchema,
    agentwheelVersion: z.string().nullable(),
    checkedAt: z.string().nullable(),
    stale: z.boolean(),
    error: z.string().optional(),
    report: statusReportSchema.optional(),
  })),
}));

const HEALTH_RANK: Record<StatusHealth, number> = {
  PASS: 0,
  WARN: 1,
  STALE: 2,
  DEGRADED: 3,
  BUSY: 4,
  INCOMPATIBLE: 5,
  FAIL: 6,
};

export function worstStatusHealth(values: StatusHealth[]): StatusHealth {
  return values.reduce<StatusHealth>(
    (worst, value) => HEALTH_RANK[value] > HEALTH_RANK[worst] ? value : worst,
    "PASS",
  );
}

export function blocksCompositeApply(health: StatusHealth): boolean {
  return !["PASS", "WARN"].includes(health);
}
