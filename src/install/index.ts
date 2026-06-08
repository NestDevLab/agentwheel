export { applyInstallPlan, uninstall } from "./apply.js";
export { readInstallManifest, readSourceLock, writeInstallManifest, writeSourceLock, normalizeTargetRoot } from "./manifest.js";
export { createInstallPlan, summarizePlan, type InstallOperation, type InstallPlan, type PlanAction } from "./plan.js";
export { createUninstallPlan } from "./uninstall.js";
