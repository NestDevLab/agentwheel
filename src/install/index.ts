export { applyCombinedInstallPlan, applyInstallPlan, recoverPendingApply, uninstall } from "./apply.js";
export { computeSourceLockRevision, readInstallManifest, readSourceLock, writeInstallManifest, writeSourceLock, normalizeTargetRoot } from "./manifest.js";
export { createCombinedInstallPlan, createInstallPlan, summarizePlan, type InstallOperation, type InstallPlan, type InstallStateMigration, type MigrationReport, type PlanAction, type TargetStateFilePreconditions } from "./plan.js";
export type { DesiredArtifact, DesiredEntryMeta } from "./desired.js";
export { createOwnershipUninstallPlan, createUninstallPlan } from "./uninstall.js";
export { abortApplyJournal, readApplyJournal, type AbortedApplyJournal } from "./transaction.js";
