// Fixture-only observer. Evidence is the single explicitly excluded trace file.
const fs = require("node:fs");
const child = require("node:child_process");
const util = require("node:util");
const { syncBuiltinESMExports } = require("node:module");
function record(kind, name, args) {
  fs.appendFileSync(process.env.SYNTHETIC_EFFECT_TRACE, JSON.stringify({ kind, name, args }) + "\n");
}
for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync"]) {
  const original = child[name];
  const wrapped = function(...args) { record("process", name, args.slice(0,2)); return original.apply(this,args); };
  if (original[util.promisify.custom]) wrapped[util.promisify.custom] = function(...args) {
    record("process", name, args.slice(0,2)); return original[util.promisify.custom].apply(this,args);
  };
  child[name] = wrapped;
}
for (const [moduleName, names] of [["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:net", ["connect", "createConnection"]]]) {
  const module = require(moduleName);
  for (const name of names) module[name] = function() { record("network", `${moduleName}.${name}`, []); throw new Error("Synthetic fixture forbids network"); };
}
globalThis.fetch = async function() { record("network", "fetch", []); throw new Error("Synthetic fixture forbids network"); };
syncBuiltinESMExports();
