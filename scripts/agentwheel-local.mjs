#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(process.env.AGENTWHEEL_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const entry = join(root,"dist/index.js");
function newest(path) {
  let stat;
  try { stat = statSync(path); } catch { return 0; }
  return stat.isDirectory() ? Math.max(stat.mtimeMs,...readdirSync(path).map(name => newest(join(path,name)))) : stat.mtimeMs;
}
let built = 0;
try { built = statSync(entry).mtimeMs; } catch { /* Missing builds are refused below. */ }
if (!built || ["src","package.json","pnpm-lock.yaml","tsconfig.json","tsup.config.ts"].some(path => newest(join(root,path)) > built)) {
  console.error("agentwheel: built CLI is missing or stale. Build explicitly with pnpm build in the selected checkout; this wrapper never builds implicitly.");
  process.exitCode = 127;
} else {
  const result = spawnSync(process.execPath,[entry,...process.argv.slice(2)],{ stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
