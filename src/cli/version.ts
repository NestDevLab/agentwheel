import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

/**
 * Resolve the agentwheel CLI version from the package.json that ships with the
 * package instead of hardcoding it.
 *
 * Walking up from this module's location works for both the published, bundled
 * `dist/index.js` (package.json one level up) and for running or testing from
 * `src/cli/` (package.json two levels up). The `name` guard avoids latching onto
 * an unrelated parent package.json in monorepo or workspace layouts, and the
 * fallback keeps the CLI usable even if package.json cannot be located.
 */
export function resolveCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "agentwheel" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No readable package.json at this level; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return FALLBACK_VERSION;
    dir = parent;
  }
}
