import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isLoopbackBind } from "../src/cli/serve.js";
import { ensureCliBuild } from "./helpers/ensure-cli-build.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const servers: ServeProcess[] = [];
const cli = join(process.cwd(), "dist", "index.js");
let cliHome: string;

beforeAll(async () => {
  cliHome = await mkdtemp(join(tmpdir(), "agentwheel-serve-home-"));
  await ensureCliBuild(cli);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

afterAll(async () => {
  if (cliHome) await rm(cliHome, { recursive: true, force: true });
});

describe("serve dashboard", () => {
  it("serves the report routes on loopback with clean deterministic content", async () => {
    const workspace = await tempRoot();
    const source = await skillPackageFixture("serve-route-skill");
    const planArgs = [source, "--adapter", "codex", "--installation-type", "local", "--target-root", workspace, "--only-source", "--no-deps"];
    const before = await listRelativeFiles(workspace);
    const server = await startServe([...planArgs, "--port", "0", "--once"]);

    expect(server.stdout()).toContain("http://127.0.0.1:");

    const html = await request(server.port, "/");
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("<table>");
    expect(html.body).toContain('<pre class="mermaid">');
    expect(html.body).toContain('fetch("/version"');
    expect(html.body).toContain('<script src="mermaid.js"></script>');
    expectNoExternalResourceRefs(html.body);

    const report = await request(server.port, "/report.json");
    const plan = await runCli(["plan", ...planArgs, "--format", "json"]);
    expect(report.statusCode).toBe(200);
    expect(report.headers["content-type"]).toContain("application/json");
    expect(report.body).toBe(plan.stdout);

    const firstVersion = await request(server.port, "/version");
    const secondVersion = await request(server.port, "/version");
    expect(firstVersion.statusCode).toBe(200);
    expect(firstVersion.body).toBe(secondVersion.body);
    expect(firstVersion.body.trim()).toMatch(/^[a-f0-9]{64}$/);

    const mermaid = await request(server.port, "/mermaid.js");
    expect([200, 404]).toContain(mermaid.statusCode);
    if (mermaid.statusCode === 200) {
      expect(mermaid.headers["content-type"]).toContain("application/javascript");
      expect(mermaid.body).toContain("mermaid");
    } else {
      expect(mermaid.body).toContain("Install mermaid");
    }

    const missing = await request(server.port, "/missing");
    expect(missing.statusCode).toBe(404);
    expect(await listRelativeFiles(workspace)).toEqual(before);
  });

  it("updates /version after a background re-render sees source changes", async () => {
    const workspace = await tempRoot();
    const source = await skillPackageFixture("serve-refresh-skill", "initial");
    const server = await startServe([
      source,
      "--adapter",
      "codex",
      "--installation-type",
      "local",
      "--target-root",
      workspace,
      "--only-source",
      "--no-deps",
      "--port",
      "0",
      "--interval",
      "0.2",
    ]);

    const firstVersion = (await request(server.port, "/version")).body.trim();
    await writeFile(join(source, "skills", "serve-refresh-skill", "SKILL.md"), skillBody("serve-refresh-skill", "changed"), "utf8");

    await waitFor(async () => {
      const nextVersion = (await request(server.port, "/version")).body.trim();
      return nextVersion !== firstVersion;
    });
  });

  it("treats only loopback binds as local by default", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("192.0.2.10")).toBe(false);
  });
});

async function runCli(args: string[]) {
  try {
    return await execFileAsync("node", [cli, "--no-update-check", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: cliHome },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw error as { stdout: string; stderr: string; code: number };
  }
}

async function startServe(args: string[]): Promise<ServeProcess> {
  const child = spawn("node", [cli, "--no-update-check", "serve", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: cliHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`serve did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10000);
    const onStdout = () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`serve exited before binding: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
    onStdout();
  });

  const server = {
    port,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => stopServer(child),
  };
  servers.push(server);
  return server;
}

function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function request(port: number, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: "127.0.0.1", port, path }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
        });
      });
    });
    request.on("error", reject);
  });
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition was not met before timeout");
}

async function tempRoot(prefix = "agentwheel-serve-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function skillPackageFixture(name: string, content = "fixture"): Promise<string> {
  const root = await tempRoot(`agentwheel-${name}-`);
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(join(root, "skills", name, "SKILL.md"), skillBody(name, content), "utf8");
  await writeOpenPack(root, name, [{ type: "skills", path: "skills" }]);
  return root;
}

function skillBody(name: string, content: string): string {
  return `---\nname: ${name}\ndescription: Fixture skill for ${name}.\n---\n\n# ${name}\n\n${content}\n`;
}

async function writeOpenPack(root: string, name: string, provides: unknown[]): Promise<void> {
  await writeFile(join(root, "openpack.json"), `${JSON.stringify({
    schemaVersion: 2,
    name,
    version: "1.0.0",
    provides,
  }, null, 2)}\n`, "utf8");
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectRelativeFiles(root, root, files);
  return files.sort((a, b) => a.localeCompare(b));
}

async function collectRelativeFiles(root: string, current: string, files: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectRelativeFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
}

function expectNoExternalResourceRefs(value: string): void {
  expect(value).not.toMatch(/\b(?:src|href)=["']https?:\/\//i);
  expect(value).not.toMatch(/url\(\s*["']?https?:\/\//i);
}

interface ServeProcess {
  port: number;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<void>;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
