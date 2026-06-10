import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCliVersion } from "../src/cli/version.js";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
  return pkg.version;
}

describe("cli version", () => {
  it("matches the version declared in package.json", async () => {
    expect(resolveCliVersion()).toBe(await packageVersion());
  });

  it("resolves a concrete version rather than the fallback", () => {
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(resolveCliVersion()).not.toBe("0.0.0");
  });
});
