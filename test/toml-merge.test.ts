import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, it } from "vitest";
import { mergeCodexTomlMcp, mismatchedManagedCodexTomlMcpServers } from "../src/install/toml-merge.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("updates managed fields while preserving nested user preferences and TOML values", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-toml-merge-"));
  roots.push(root);
  const source = join(root, "source.json");
  const dest = join(root, "config.toml");
  const desired = { mcpServers: { "example.server": {
    command: "new-command", args: ["new-arg"], env: { MANAGED: "new" },
    tools: { search: { enabled: true } },
  } } };
  await writeFile(source, JSON.stringify(desired));
  const prefix = `# Global user comment\r\nmodel = "example-model"\r\n`;
  const suffix = `[mcp_servers.other] # Another server\ncommand = "unmanaged"\n# Keep this comment\n[features]\nexample = true\n`;
  await writeFile(dest, `${prefix}
[mcp_servers.'example.server'] # user preferences
command = "old-command"
args = ["old-arg"]
enabled = true
startup_timeout_sec = 42
large_integer = 9223372036854775807
observed_at = 2026-01-02T03:04:05Z
local_date = 2026-01-02
local_time = 03:04:05
ratio = inf
note = """first line
[mcp_servers.decoy]
last line"""
[mcp_servers.'example.server'.env]
MANAGED = "old"
USER = "keep"
[mcp_servers.'example.server'.tools.search]
enabled = false
approval = "always"
[mcp_servers.'example.server'.tools.other]
enabled = false
[[mcp_servers.'example.server'.custom_routes]]
name = "user-route"
${suffix}`);
  const before = parse(await readFile(dest, "utf8"), { integersAsBigInt: "asNeeded" });
  await mergeCodexTomlMcp(source, dest);
  const first = await readFile(dest, "utf8");
  expect(first.startsWith(prefix)).toBe(true);
  expect(first).toContain(suffix.trimEnd());
  const after = parse(first, { integersAsBigInt: "asNeeded" });
  const expected = before;
  const expectedServer = (expected.mcp_servers as Record<string, typeof desired.mcpServers["example.server"]>)["example.server"]!;
  expectedServer.command = "new-command";
  expectedServer.args = ["new-arg"];
  expectedServer.env.MANAGED = "new";
  expectedServer.tools.search.enabled = true;
  expect(after).toEqual(expected);
  expect(mismatchedManagedCodexTomlMcpServers(desired, first)).toEqual([]);
  await mergeCodexTomlMcp(source, dest);
  expect(await readFile(dest, "utf8")).toBe(first);
});

it("refuses invalid TOML without overwriting the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-toml-merge-"));
  roots.push(root);
  const source = join(root, "source.json");
  const dest = join(root, "config.toml");
  await writeFile(source, JSON.stringify({ mcpServers: { example: { command: "node" } } }));
  const invalid = "[mcp_servers.example\ncommand = 'old'\n";
  await writeFile(dest, invalid);
  await expect(mergeCodexTomlMcp(source, dest)).rejects.toThrow();
  expect(await readFile(dest, "utf8")).toBe(invalid);
});

it("replaces declared arrays and scalar conflicts while preserving omitted tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-toml-merge-"));
  roots.push(root);
  const source = join(root, "source.json");
  const dest = join(root, "config.toml");
  const desired = { mcpServers: { example: {
    command: "node", args: ["new"], tools: { search: { enabled: true } },
  }, added: { url: "https://example.test/mcp" } } };
  await writeFile(source, JSON.stringify(desired));
  await writeFile(dest, `[mcp_servers.example]
command = { old = true }
args = ["old", "extra"]
tools = "old-scalar"
[mcp_servers.example.env]
USER = "keep"
`);
  await mergeCodexTomlMcp(source, dest);
  const content = await readFile(dest, "utf8");
  expect(parse(content)).toEqual({ mcp_servers: {
    example: { ...desired.mcpServers.example, env: { USER: "keep" } },
    added: desired.mcpServers.added,
  } });
  expect(mismatchedManagedCodexTomlMcpServers(desired, content)).toEqual([]);
});
