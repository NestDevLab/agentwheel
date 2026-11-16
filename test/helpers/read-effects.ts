import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitSourceDriver } from "../../src/source/git.js";
import { releaseGitSnapshotLease } from "../../src/source/cache.js";
import { diffEffects, snapshot } from "./effects.js";

export async function readFixture(warm: boolean) {
  const root = await mkdtemp(join(tmpdir(), "synthetic-read-"));
  const home = join(root,"home"); const workspace = join(root,"workspace");
  const temp = join(root,"temp"); const source = join(root,"source");
  const cacheRoot = join(workspace,".agentwheel/cache");
  for (const path of [home, workspace, temp, join(source,"skills/synthetic"), join(workspace,".agentwheel")]) await mkdir(path, { recursive: true });
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C",dir,...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  for (const dir of [workspace, source]) {
    git(dir,"init","-b","main"); git(dir,"config","user.name","Synthetic"); git(dir,"config","user.email","synthetic@example.invalid");
  }
  await writeFile(join(workspace,"sentinel"),"user bytes"); git(workspace,"add","sentinel"); git(workspace,"commit","-m","fixture");
  await writeFile(join(source,"skills/synthetic/SKILL.md"), "---\nname: synthetic\ndescription: Synthetic skill.\n---\n# Synthetic\n");
  await writeFile(join(source,"openpack.json"), JSON.stringify({ schemaVersion: 2, name: "fixture/synthetic", version: "1.0.0", provides: [{ type: "skills", path: "skills" }] }));
  git(source,"add","openpack.json","skills"); git(source,"commit","-m","fixture");
  const sourceUrl = `git:${source}#main`;
  await writeFile(join(workspace,".agentwheel/config.json"), JSON.stringify({ schemaVersion: 1, bootstrapSkills: false,
    packages: [{ name: "synthetic", source: sourceUrl, driver: "git", mode: "pinned", requestedRef: "main", adapter: "codex", installationType: "local" }], registry: {}, profiles: {}, agents: {} }));
  const driver = new GitSourceDriver();
  const resolved = await driver.resolve(sourceUrl,{ cacheRoot });
  if (warm) {
    const fetched = await driver.fetch(resolved); await releaseGitSnapshotLease(fetched.cacheLeasePath);
    for (const prefix of ["111111111111","222222222222","333333333333","444444444444"]) {
      const path = `${resolved.resolvedPath}-${prefix}`;
      await mkdir(path); await writeFile(join(path,"sentinel"),"retained cache evidence"); await utimes(path,1,1);
    }
  }
  const trace = join(root,"trace.jsonl"); await writeFile(trace,"");
  const policy = { exclude: { "trace.jsonl": "Only the fixture observer evidence is excluded; command state is compared exactly." } };
  return {
    root, workspace, home, temp, cacheRoot, resolved,
    async probe(extra: string[] = [], entry = join(process.cwd(),"dist/index.js"), env: NodeJS.ProcessEnv = {}) {
      const before = await snapshot(root,policy);
      const result = spawnSync(process.execPath, [entry,"status","--installation-type","local","--adapter","codex","--target-root",workspace,"--json",...extra], {
        cwd: workspace, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home,".config"), XDG_CACHE_HOME: join(home,".cache"), TMPDIR: temp,
          AGENTWHEEL_NO_UPDATE_CHECK: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          NODE_OPTIONS: `--require=${resolve("test/helpers/read-effects-preload.cjs")}`, SYNTHETIC_EFFECT_TRACE: trace, ...env },
      });
      const calls = (await readFile(trace,"utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; name: string; args: unknown[] });
      return { result, calls, changes: diffEffects(before,await snapshot(root,policy)) };
    },
    dispose: () => rm(root,{ recursive: true, force: true }),
  };
}
