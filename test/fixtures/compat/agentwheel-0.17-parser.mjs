import { readFile, writeFile } from "node:fs/promises";

const [configPath, planMarker] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
  throw new Error(`Agentwheel 0.17 workspace parser rejects schemaVersion ${String(config.schemaVersion)}`);
}
await writeFile(planMarker, "planned\n", "utf8");
