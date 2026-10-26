import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, readInstallManifest, type DesiredArtifact } from "../src/install/index.js";
import { recoverPendingApply } from "../src/install/apply.js";
import { assertExactMcpMergeContribution, assertMergedSourceContribution } from "../src/install/merge-removal.js";
import { installManifestPath } from "../src/install/paths.js";
import { applyJournalPath } from "../src/install/transaction.js";
import { localTransport } from "../src/transport/index.js";
import { hashPath, pathExists } from "../src/utils/fs.js";

const roots: string[] = [];
const environmentCases: Record<string, string>[] = [{}, { SCOPE: "test" }];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(env: Record<string, string> = { SCOPE: "test" }) {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-managed-mcp-")); roots.push(root);
  const target = join(root, "target"), sourcePath = join(root, "mcp.json");
  const contribution = { mcpServers: { fixture: { command: "fixture-command", args: ["--stdio"], env } } };
  await writeFile(sourcePath, JSON.stringify(contribution));
  const artifact: DesiredArtifact = { type: "mcp", name: "fixture.json", sourcePath, stagedPath: sourcePath,
    relativePath: "mcp/fixture.json", kind: "file", hash: await hashPath(sourcePath), channel: "managed",
    meta: { logicalSelector: "mcp/fixture.json", dependencyRole: "root", owners: ["fixture"] } };
  const initial = await createCombinedInstallPlan([artifact], codexAdapter, target, undefined, localTransport, { installationType: "local" });
  await applyCombinedInstallPlan(initial);
  const config = join(target, ".codex/config.toml");
  const original = await readFile(config, "utf8");
  const preferences = '\n# User-owned preferences\n[mcp_servers.fixture.tools]\nenabled = false\n[mcp_servers.fixture.tools."custom.call"]\nenabled = false\n';
  return { root, target, sourcePath, contribution, artifact, config, original, preferences };
}

async function nextPlan(f: Awaited<ReturnType<typeof fixture>>) {
  return createCombinedInstallPlan([f.artifact], codexAdapter, f.target,
    await readInstallManifest(f.target, "codex", localTransport, { installationType: "local" }),
    localTransport, { installationType: "local" });
}

describe("managed Codex MCP verification", () => {
  it("skips a managed server with user preferences without rewriting any bytes", async () => {
    const f = await fixture(), content = f.original + f.preferences;
    await writeFile(f.config, content);
    const plan = await nextPlan(f);
    expect(plan.operations.map((op) => op.action)).toEqual(["skip"]);
    await applyCombinedInstallPlan(plan);
    expect(await readFile(f.config, "utf8")).toBe(content);
    await applyCombinedInstallPlan(await nextPlan(f));
    expect(await readFile(f.config, "utf8")).toBe(content);
    expect(() => assertExactMcpMergeContribution(f.contribution, "codex-toml-mcp", content)).toThrow();
  });

  it.each(environmentCases)("recovers a pending skip with env %j, preserving preferences", async (env) => {
    const f = await fixture(env);
    await writeFile(f.config, (f.original + f.preferences).replace('command = "fixture-command"', 'command = "changed-command"'));
    await expect(applyCombinedInstallPlan(await nextPlan(f))).rejects.toThrow(/differs|missing/);
    expect(await pathExists(applyJournalPath(f.target, "codex", { installationType: "local" }))).toBe(true);
    const repaired = f.original + f.preferences;
    await writeFile(f.config, repaired);
    expect(await recoverPendingApply(f.target, "codex", localTransport, { installationType: "local" })).toBeDefined();
    expect(await readFile(f.config, "utf8")).toBe(repaired);
    expect(await pathExists(applyJournalPath(f.target, "codex", { installationType: "local" }))).toBe(false);
  });

  it("verifies the renderer's omitted empty environment on repeated installs", async () => {
    const f = await fixture({});
    const content = f.original + f.preferences;
    await writeFile(f.config, content);
    await applyCombinedInstallPlan(await nextPlan(f));
    expect(await readFile(f.config, "utf8")).toBe(content);
  });

  it.each([true, false])("keeps exact adoption guarded through apply and recovery (new flag=%s)", async (newFlag) => {
    const f = await fixture();
    await rm(installManifestPath(f.target, "codex", { installationType: "local" }));
    const plan = await createCombinedInstallPlan([f.artifact], codexAdapter, f.target, undefined, localTransport,
      { installationType: "local", forceConflict: true });
    expect(plan.operations[0]?.exactMergeAdoption).toBe(true);
    if (!newFlag) delete plan.operations[0]!.exactMergeAdoption;
    const changed = f.original + f.preferences;
    await writeFile(f.config, changed);
    await expect(applyCombinedInstallPlan(plan)).rejects.toThrow(/differs|missing/);
    await expect(recoverPendingApply(f.target, "codex", localTransport, { installationType: "local" }))
      .rejects.toThrow(/differs|missing/);
    expect(await readFile(f.config, "utf8")).toBe(changed);
  });

  it("accepts equivalent TOML formatting and additional unowned keys", async () => {
    const f = await fixture();
    const current = '# Comment\n[mcp_servers.fixture]\nargs = [ "--stdio", ]\ncommand = \'fixture-command\'\nenabled = false\n[mcp_servers.fixture.env]\nSCOPE = "test"\nEXTRA = "keep"\n' + f.preferences;
    await expect(assertMergedSourceContribution(f.sourcePath, "codex-toml-mcp", current)).resolves.toBeUndefined();
  });

  it.each([
    ['changed command', (s: string) => s.replace('fixture-command', 'changed-command')],
    ['changed arguments', (s: string) => s.replace('--stdio', '--other')],
    ['extra argument', (s: string) => s.replace('["--stdio"]', '["--stdio", "--other"]')],
    ['missing server', (s: string) => s.replaceAll('mcp_servers.fixture', 'mcp_servers.other')],
    ['changed environment', (s: string) => s.replace('SCOPE = "test"', 'SCOPE = "changed"')],
    ['duplicate key', (s: string) => s + '\n[mcp_servers.fixture]\ncommand = "other"\n'],
  ])("rejects %s", async (_label, alter) => {
    const f = await fixture();
    await expect(assertMergedSourceContribution(f.sourcePath, "codex-toml-mcp", alter(f.original + f.preferences))).rejects.toThrow();
  });
});
