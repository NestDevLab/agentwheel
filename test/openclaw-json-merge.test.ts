import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeOpenClawJsonFile, renderOpenClawJsonMergeSource } from "../src/install/openclaw-json-merge.js";

const roots: string[] = [];
const envNames = ["AGENTWHEEL_TEST_PLAIN", "AGENTWHEEL_TEST_SECRET"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const name of envNames) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

async function fixture(source: unknown, current?: unknown): Promise<{ sourcePath: string; destPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentwheel-openclaw-merge-"));
  roots.push(root);
  const sourcePath = join(root, "source.json");
  const destPath = join(root, "openclaw.json");
  await writeFile(sourcePath, JSON.stringify(source), "utf8");
  if (current !== undefined) await writeFile(destPath, JSON.stringify(current), "utf8");
  return { sourcePath, destPath };
}

describe("OpenClaw JSON environment placeholders", () => {
  it("expands ordinary placeholders and still fails when their variables are missing", async () => {
    const { sourcePath } = await fixture({ value: "before-${AGENTWHEEL_TEST_PLAIN}-after" });
    process.env.AGENTWHEEL_TEST_PLAIN = "synthetic-plain";
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual({ value: "before-synthetic-plain-after" });
    delete process.env.AGENTWHEEL_TEST_PLAIN;
    await expect(renderOpenClawJsonMergeSource(sourcePath)).rejects.toThrow(
      `Missing environment variable AGENTWHEEL_TEST_PLAIN while rendering OpenClaw JSON merge artifact ${sourcePath}`,
    );
  });

  it("leaves marked secrets for runtime whether the install environment is unset or set", async () => {
    const { sourcePath, destPath } = await fixture({
      nested: { values: ["prefix-${secret:AGENTWHEEL_TEST_SECRET}-suffix"] },
    });
    delete process.env.AGENTWHEEL_TEST_SECRET;
    const expected = { nested: { values: ["prefix-${AGENTWHEEL_TEST_SECRET}-suffix"] } };
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual(expected);
    process.env.AGENTWHEEL_TEST_SECRET = "synthetic-secret-value";
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual(expected);
    await mergeOpenClawJsonFile(sourcePath, destPath);
    const installed = await readFile(destPath, "utf8");
    expect(JSON.parse(installed)).toEqual(expected);
    expect(installed).not.toContain("synthetic-secret-value");
  });

  it("renders mixed placeholders once in nested arrays and objects", async () => {
    process.env.AGENTWHEEL_TEST_PLAIN = "plain-${AGENTWHEEL_TEST_SECRET}";
    process.env.AGENTWHEEL_TEST_SECRET = "synthetic-secret-value";
    const { sourcePath } = await fixture({
      nested: [{ value: "${AGENTWHEEL_TEST_PLAIN}/${secret:AGENTWHEEL_TEST_SECRET}" }],
    });
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual({
      nested: [{ value: "plain-${AGENTWHEEL_TEST_SECRET}/${AGENTWHEEL_TEST_SECRET}" }],
    });
  });

  it("preserves ordinary placeholder behavior around unsupported syntax", async () => {
    process.env.AGENTWHEEL_TEST_PLAIN = "synthetic-plain";
    const { sourcePath } = await fixture({
      value: "${BAD-NAME}/${OUTER${AGENTWHEEL_TEST_PLAIN}",
    });
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual({
      value: "${BAD-NAME}/${OUTERsynthetic-plain",
    });
  });

  it("replaces marked agents by id as whole entries, preserves others, and is idempotent", async () => {
    const { sourcePath, destPath } = await fixture({
      agents: { list: [{ id: "managed", env: { TOKEN: "${secret:AGENTWHEEL_TEST_SECRET}" } }] },
    }, {
      agents: { list: [
        { id: "unrelated", model: "keep" },
        { id: "managed", model: "stale", extra: true },
      ] },
    });
    const rendered = await renderOpenClawJsonMergeSource(sourcePath);
    expect(rendered).toEqual({ agents: { list: [{ id: "managed", env: { TOKEN: "${AGENTWHEEL_TEST_SECRET}" } }] } });
    await mergeOpenClawJsonFile(sourcePath, destPath);
    const first = await readFile(destPath, "utf8");
    expect(JSON.parse(first).agents.list).toEqual([
      { id: "unrelated", model: "keep" },
      { id: "managed", env: { TOKEN: "${AGENTWHEEL_TEST_SECRET}" } },
    ]);
    await mergeOpenClawJsonFile(sourcePath, destPath);
    expect(await readFile(destPath, "utf8")).toBe(first);
    expect(await renderOpenClawJsonMergeSource(sourcePath)).toEqual(rendered);
  });

  it.each(["${secret:}", "${secret:9BAD}", "${secret:BAD-NAME}", "${secret:UNFINISHED"])(
    "rejects malformed secret opt-in %s without including values",
    async (value) => {
      process.env.AGENTWHEEL_TEST_SECRET = "synthetic-secret-value";
      const { sourcePath } = await fixture({ value });
      await expect(renderOpenClawJsonMergeSource(sourcePath)).rejects.toThrow(
        `Invalid secret environment placeholder in OpenClaw JSON merge artifact ${sourcePath}`,
      );
    },
  );
});
