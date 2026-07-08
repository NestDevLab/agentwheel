import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { isIP, type AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PlanReport } from "./format.js";
import { renderHtml, renderJson } from "./render.js";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_INTERVAL_SECONDS = 60;
const require = createRequire(import.meta.url);

export interface ServeDashboardOptions {
  bind?: string;
  port?: number;
  intervalSeconds?: number;
  once?: boolean;
  buildReport: () => Promise<PlanReport>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface ServeCache {
  json: string;
  version: string;
  baseHtml: string;
  html: string;
  mermaidAvailable: boolean;
}

export async function servePlanDashboard(options: ServeDashboardOptions): Promise<void> {
  const bind = options.bind ?? DEFAULT_BIND;
  const port = options.port ?? DEFAULT_PORT;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const errorLog = options.error ?? console.error;

  if (!isLoopbackBind(bind)) {
    warn(`WARNING: agentwheel serve is bound to ${bind}; this unauthenticated dashboard may expose runtime topology on a non-local interface.`);
  }

  let cache = await buildServeCache(options.buildReport);
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = createServer((request, response) => {
    void handleRequest(request, response, () => cache);
  });

  await listen(server, port, bind);
  const address = server.address();
  log(`Serving agentwheel plan report at ${servedUrl(address, bind, port)}`);

  if (!options.once) {
    timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void buildServeCache(options.buildReport)
        .then((nextCache) => {
          cache = nextCache;
        })
        .catch((error) => {
          const message = errorMessage(error);
          errorLog(`agentwheel serve refresh failed: ${message}`);
          cache = {
            ...cache,
            mermaidAvailable: mermaidAssetAvailable(),
            html: decorateServedHtml(cache.baseHtml, {
              version: cache.version,
              mermaidAvailable: mermaidAssetAvailable(),
              lastError: message,
            }),
          };
        })
        .finally(() => {
          refreshing = false;
        });
    }, intervalSeconds * 1000);
    timer.unref?.();
  }

  await waitForShutdown(server, () => {
    if (timer) clearInterval(timer);
  });
}

export function parseServePort(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}. Expected an integer from 0 to 65535.`);
  }
  return port;
}

export function parseServeIntervalSeconds(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_INTERVAL_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid --interval value: ${value}. Expected a positive number of seconds.`);
  }
  return seconds;
}

export function isLoopbackBind(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

export function resolveMermaidAssetPath(): string | undefined {
  try {
    return require.resolve("mermaid/dist/mermaid.min.js");
  } catch {
    return undefined;
  }
}

async function buildServeCache(buildReport: () => Promise<PlanReport>): Promise<ServeCache> {
  const report = await buildReport();
  const json = `${renderJson(report)}\n`;
  const version = createHash("sha256").update(json).digest("hex");
  const baseHtml = renderHtml(report, { assets: "linked" });
  const mermaidAvailable = mermaidAssetAvailable();
  return {
    json,
    version,
    baseHtml,
    mermaidAvailable,
    html: decorateServedHtml(baseHtml, { version, mermaidAvailable }),
  };
}

function mermaidAssetAvailable(): boolean {
  return resolveMermaidAssetPath() !== undefined;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, cacheForRequest: () => ServeCache): Promise<void> {
  if (request.method !== "GET") {
    writeText(response, 404, "Not found\n");
    return;
  }

  const url = new URL(request.url ?? "/", "http://agentwheel.local");
  const cache = cacheForRequest();
  if (url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(cache.html);
    return;
  }
  if (url.pathname === "/report.json") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(cache.json);
    return;
  }
  if (url.pathname === "/version") {
    writeText(response, 200, `${cache.version}\n`);
    return;
  }
  if (url.pathname === "/mermaid.js") {
    await writeMermaidAsset(response);
    return;
  }
  writeText(response, 404, "Not found\n");
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function writeMermaidAsset(response: ServerResponse): Promise<void> {
  const assetPath = resolveMermaidAssetPath();
  if (!assetPath) {
    writeText(response, 404, "Mermaid is not installed. Install mermaid to render the diagram.\n");
    return;
  }
  response.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "public, max-age=3600",
  });
  await new Promise<void>((resolve) => {
    const stream = createReadStream(assetPath);
    stream.on("error", () => {
      if (!response.headersSent) writeText(response, 404, "Mermaid asset unavailable.\n");
      else response.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(response);
  });
}

function decorateServedHtml(
  html: string,
  options: { version: string; mermaidAvailable: boolean; lastError?: string },
): string {
  const notes = [
    options.mermaidAvailable
      ? ""
      : "<section class=\"panel serve-note\"><strong>Diagram rendering unavailable.</strong> Install <code>mermaid</code> to render the diagram.</section>",
    options.lastError
      ? `<section class="panel serve-error" role="alert"><strong>Last refresh failed.</strong> ${escapeHtml(options.lastError)}</section>`
      : "",
  ].filter(Boolean).join("\n");
  const withNotes = notes ? injectBefore(html, "</main>", `${notes}\n`) : html;
  return injectBefore(withNotes, "</body>", `${livenessScript(options.version)}\n`);
}

function livenessScript(version: string): string {
  return `<script>(()=>{const current=${JSON.stringify(version)};async function check(){try{const response=await fetch("/version",{cache:"no-store"});if(!response.ok)return;const next=(await response.text()).trim();if(next&&next!==current)location.reload();}catch{}}setInterval(check,5000);})();</script>`;
}

function injectBefore(value: string, marker: string, insertion: string): string {
  const index = value.lastIndexOf(marker);
  if (index === -1) return `${value}\n${insertion}`;
  return `${value.slice(0, index)}${insertion}${value.slice(index)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function listen(server: ReturnType<typeof createServer>, port: number, bind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bind);
  });
}

function waitForShutdown(server: ReturnType<typeof createServer>, beforeClose: () => void): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      beforeClose();
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    server.once("close", () => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      beforeClose();
      resolve();
    });
  });
}

function servedUrl(address: AddressInfo | string | null, bind: string, requestedPort: number): string {
  if (typeof address === "object" && address) {
    return `http://${formatUrlHost(address.address || bind)}:${address.port}/`;
  }
  return `http://${formatUrlHost(bind)}:${requestedPort}/`;
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
