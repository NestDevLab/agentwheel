#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const skillName = "agentwheel-smoke";
const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = dirname(dirname(scriptPath));
const cwd = process.cwd();
const home = os.homedir();

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}

const config = findConfigs(cwd, home);
const harness = detectHarness(skillRoot, cwd, home);
const envHint = detectHarnessFromEnv();
const agentwheel = inspectAgentwheel(parsed.statusArgs, envHint, harness, config);
const manifests = findStateFiles(harness.runtimeRoot ?? projectRootFromConfig(config.projectConfig) ?? cwd);
const assessment = assess({ harness, agentwheel, manifests, config });
const report = {
  overall: assessment.overall,
  checks: assessment.checks,
  harness,
  agentwheel,
  config,
  manifests,
  recommendedNextCommand: recommendedNextCommand(assessment, agentwheel.status.args),
};

if (parsed.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatMarkdown(report));
}

process.exit(report.overall === "FAIL" ? 1 : 0);

function parseArgs(args) {
  const statusArgs = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (["--all", "--all-detected", "--user", "--local"].includes(arg)) {
      statusArgs.push(arg);
      continue;
    }
    if (["--agent", "--profile", "--target-root", "--adapter", "--installation-type", "--fleet"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return { error: `${arg} requires a value.` };
      statusArgs.push(arg, value);
      index += 1;
      continue;
    }
    return { error: `Unsupported smoke option: ${arg}` };
  }
  return { json, statusArgs };
}

function inspectAgentwheel(statusArgs, hint, harness, config) {
  const which = run("command", ["-v", "agentwheel"], { shell: true });
  const version = which.ok ? run("agentwheel", ["--version"]) : { ok: false, code: null, stdout: "", stderr: "agentwheel not found" };
  let effectiveStatusArgs = hasWorkspaceScope(statusArgs)
    ? statusArgs
    : config.project?.fleetId
      ? ["--fleet", config.project.fleetId, ...statusArgs]
      : config.projectConfig
        ? statusArgs
        : [...defaultWorkspaceScope(harness), ...statusArgs];
  let status = which.ok ? run("agentwheel", ["status", ...effectiveStatusArgs]) : { ok: false, code: null, stdout: "", stderr: "agentwheel not found" };
  if (!status.ok && effectiveStatusArgs.length === 0 && /Multiple runtime directories detected/i.test(status.stderr) && hint?.adapter) {
    effectiveStatusArgs = ["--adapter", hint.adapter, "--installation-type", hint.installationType ?? "local"];
    status = run("agentwheel", ["status", ...effectiveStatusArgs]);
  }
  return {
    cliAvailable: which.ok,
    cliPath: firstLine(which.stdout),
    version: firstLine(version.stdout),
    status: {
      args: effectiveStatusArgs,
      ok: status.ok,
      code: status.code,
      stdout: status.stdout.trim(),
      stderr: status.stderr.trim(),
      summary: summarizeStatus(status.stdout, status.stderr),
    },
  };
}

function hasWorkspaceScope(args) {
  return args.some((arg) => ["--user", "--local", "--fleet", "--target-root"].includes(arg));
}

function defaultWorkspaceScope(harness) {
  if (harness?.installationType === "user") return ["--user"];
  if (harness?.installationType === "local") return ["--local"];
  return [];
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      env: { ...process.env, AGENTWHEEL_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: options.shell ?? false,
    });
    return { ok: true, code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === "number" ? error.status : null,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function findConfigs(start, homeDir) {
  const globalConfig = join(homeDir, ".agentwheel", "config.json");
  const foundConfig = findUp(start, ".agentwheel/config.json");
  const projectConfig = foundConfig && resolve(foundConfig) !== resolve(globalConfig) ? foundConfig : null;
  return {
    projectConfig,
    globalConfig: existsSync(globalConfig) ? globalConfig : null,
    project: projectConfig ? summarizeConfig(projectConfig) : null,
    global: existsSync(globalConfig) ? summarizeConfig(globalConfig) : null,
  };
}

function detectHarnessFromEnv() {
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_CI) return { adapter: "codex", installationType: "local" };
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return { adapter: "claude", installationType: "local" };
  if (process.env.GITHUB_COPILOT_CLI || process.env.COPILOT_AGENT) return { adapter: "copilot", installationType: "local" };
  return null;
}

function summarizeConfig(path) {
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return {
      fleetId: typeof json.fleetId === "string" ? json.fleetId : null,
      packages: Array.isArray(json.packages) ? json.packages.map((entry) => entry.name ?? entry.source ?? "unnamed") : [],
      agents: json.agents && typeof json.agents === "object" ? Object.keys(json.agents) : [],
      profiles: json.profiles && typeof json.profiles === "object" ? Object.keys(json.profiles) : [],
    };
  } catch (error) {
    return { error: error.message };
  }
}

function detectHarness(path, currentDir, homeDir) {
  const normalized = resolve(path);
  const homeRelative = relative(homeDir, normalized);
  const localPatterns = [
    { marker: [".agents", "skills", skillName], adapter: "codex", installationType: "local", expected: ".agents/skills/<name>" },
    { marker: [".claude", "skills", skillName], adapter: "claude", installationType: "local", expected: ".claude/skills/<name>" },
    { marker: [".github", "skills", skillName], adapter: "copilot", installationType: "local", expected: ".github/skills/<name>" },
    { marker: ["skills", skillName], adapter: "openclaw", installationType: "local", expected: "skills/<name>" },
  ];
  const userPatterns = [
    { root: join(homeDir, ".agents", "skills", skillName), adapter: "codex", installationType: "user", expected: "~/.agents/skills/<name>" },
    { root: join(homeDir, ".claude", "skills", skillName), adapter: "claude", installationType: "user", expected: "~/.claude/skills/<name>" },
    { root: join(homeDir, ".copilot", "skills", skillName), adapter: "copilot", installationType: "user", expected: "~/.copilot/skills/<name>" },
    { root: join(homeDir, ".openclaw", "skills", skillName), adapter: "openclaw", installationType: "user", expected: "~/.openclaw/skills/<name>" },
    { root: join(homeDir, ".hermes", "skills", skillName), adapter: "hermes", installationType: "user", expected: "~/.hermes/skills/<name>" },
  ];
  const wrongCodex = containsSegments(normalized, [".codex", "skills", skillName]);
  if (wrongCodex) {
    return {
      adapter: "codex",
      installationType: "unknown",
      confidence: "high",
      runtimeRoot: null,
      skillPath: normalized,
      expectedSkillPath: ".agents/skills/<name> or ~/.agents/skills/<name>",
      compatibility: "FAIL",
      note: ".codex/skills is not an Agentwheel-managed Codex skill target.",
    };
  }
  for (const pattern of userPatterns) {
    if (normalized === pattern.root || normalized.startsWith(`${pattern.root}${sep}`)) {
      return {
        adapter: pattern.adapter,
        installationType: pattern.installationType,
        confidence: "high",
        runtimeRoot: homeDir,
        skillPath: normalized,
        expectedSkillPath: pattern.expected,
        compatibility: "PASS",
        note: `Skill path is under ${pattern.expected}.`,
      };
    }
  }
  for (const pattern of localPatterns) {
    const root = rootBeforeMarker(normalized, pattern.marker);
    if (!root) continue;
    const packageSource = pattern.adapter === "openclaw" && isAgentwheelSourcePackage(root);
    return {
      adapter: packageSource ? "unknown" : pattern.adapter,
      installationType: packageSource ? "source" : pattern.installationType,
      confidence: packageSource ? "medium" : "high",
      runtimeRoot: root,
      skillPath: normalized,
      expectedSkillPath: pattern.expected,
      compatibility: packageSource ? "WARN" : "PASS",
      note: packageSource
        ? "Skill is running from the Agentwheel source package; this is useful for authoring but does not prove fleet deployment."
        : `Skill path is under ${pattern.expected}.`,
    };
  }
  return {
    adapter: "unknown",
    installationType: "unknown",
    confidence: "low",
    runtimeRoot: findUp(currentDir, ".agentwheel") ? dirname(findUp(currentDir, ".agentwheel")) : null,
    skillPath: normalized,
    expectedSkillPath: null,
    compatibility: "WARN",
    note: `Could not map ${homeRelative.startsWith("..") ? normalized : `~/${homeRelative}`} to a documented Agentwheel skill target.`,
  };
}

function isAgentwheelSourcePackage(root) {
  const openpackPath = join(root, "openpack.json");
  if (!existsSync(openpackPath)) return false;
  try {
    const json = JSON.parse(readFileSync(openpackPath, "utf8"));
    return json.name === "NestDevLab/agentwheel";
  } catch {
    return false;
  }
}

function findStateFiles(root) {
  const stateDir = join(root, ".agentwheel");
  if (!existsSync(stateDir)) return { root, installManifests: [], sourceLocks: [] };
  const files = readdirSync(stateDir).sort();
  return {
    root,
    installManifests: files.filter((file) => file.endsWith(".install-manifest.json")),
    sourceLocks: files.filter((file) => file.endsWith(".source-lock.json")),
  };
}

function assess({ harness, agentwheel, manifests, config }) {
  const checks = [];
  pushCheck(checks, harness.compatibility, "harness-path", harness.note);
  pushCheck(checks, agentwheel.cliAvailable ? "PASS" : "FAIL", "agentwheel-cli", agentwheel.cliAvailable ? `Found ${agentwheel.cliPath}` : "agentwheel is not available on PATH.");
  pushCheck(checks, agentwheel.status.ok ? "PASS" : "FAIL", "agentwheel-status", agentwheel.status.ok ? "agentwheel status completed." : statusFailure(agentwheel.status));
  pushCheck(checks, config.projectConfig || config.globalConfig ? "PASS" : "WARN", "agentwheel-config", config.projectConfig || config.globalConfig ? "Agentwheel config found." : "No project or global Agentwheel config found.");
  const statusHasManifest = /Install manifest:\s*(?!missing\b).+/i.test(agentwheel.status.stdout);
  pushCheck(
    checks,
    manifests.installManifests.length > 0 || statusHasManifest ? "PASS" : "WARN",
    "install-manifest",
    manifests.installManifests.length > 0
      ? `${manifests.installManifests.length} install manifest file(s) found.`
      : statusHasManifest
        ? "agentwheel status reports an install manifest."
        : "No install manifest files found under the target .agentwheel directory.",
  );
  if (statusHasBlockingDriftOrConflict(agentwheel.status.stdout + agentwheel.status.stderr)) {
    pushCheck(checks, "FAIL", "drift-conflict", "agentwheel status reports drift or conflict.");
  }
  if (statusHasPendingInstallWork(agentwheel.status.stdout)) {
    pushCheck(checks, "WARN", "pending-work", "agentwheel status reports pending install work.");
  }
  if (/Install manifest:\s*missing/i.test(agentwheel.status.stdout)) {
    pushCheck(checks, "WARN", "manifest-missing", "agentwheel status reports a missing install manifest.");
  }
  const overall = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "WARN") ? "WARN" : "PASS";
  return { overall, checks };
}

function projectRootFromConfig(configPath) {
  return configPath ? dirname(dirname(configPath)) : null;
}

function statusHasBlockingDriftOrConflict(text) {
  return /^Pending install work:.*(?:\bdrift=[1-9]\d*|\bconflict=[1-9]\d*|\bblocking=[1-9]\d*)/im.test(text)
    || /^\s*(?:DRIFT|CONFLICT)\s+/im.test(text);
}

function statusHasPendingInstallWork(text) {
  const line = String(text ?? "").split(/\r?\n/).find((entry) => /^Pending install work:/i.test(entry));
  if (!line) return false;
  const value = line.replace(/^Pending install work:/i, "").trim();
  return value.length > 0 && !/^none$/i.test(value);
}

function recommendedNextCommand(assessment, statusArgs) {
  const target = statusArgs.length > 0 ? ` ${statusArgs.join(" ")}` : "";
  if (assessment.checks.some((check) => check.id === "agentwheel-cli" && check.status === "FAIL")) return "Install or expose the agentwheel CLI, then rerun the smoke test.";
  if (assessment.checks.some((check) => check.id === "drift-conflict")) return `agentwheel status${target}`;
  if (assessment.checks.some((check) => check.id === "pending-work" || check.id === "manifest-missing")) return `agentwheel plan${target}`;
  return `agentwheel status${target}`;
}

function formatMarkdown(report) {
  const lines = [
    "# Agentwheel Smoke Report",
    "",
    `Overall: ${report.overall}`,
    "",
    "## Harness",
    `- Detected adapter: ${report.harness.adapter}`,
    `- Installation type: ${report.harness.installationType}`,
    `- Confidence: ${report.harness.confidence}`,
    `- Runtime root: ${report.harness.runtimeRoot ?? "unknown"}`,
    `- Skill path: ${report.harness.skillPath}`,
    `- Expected skill path: ${report.harness.expectedSkillPath ?? "unknown"}`,
    `- Compatibility: ${report.harness.compatibility}`,
    `- Note: ${report.harness.note}`,
    "",
    "## Agentwheel",
    `- CLI available: ${yesNo(report.agentwheel.cliAvailable)}`,
    `- CLI path: ${report.agentwheel.cliPath || "not found"}`,
    `- Version: ${report.agentwheel.version || "unknown"}`,
    `- Status command: ${report.agentwheel.status.ok ? "PASS" : "FAIL"}`,
    `- Status args: ${report.agentwheel.status.args.length > 0 ? report.agentwheel.status.args.join(" ") : "none"}`,
    `- Status summary: ${report.agentwheel.status.summary}`,
    "",
    "## Config",
    `- Project config: ${report.config.projectConfig ?? "not found"}`,
    `- Global config: ${report.config.globalConfig ?? "not found"}`,
    `- Project packages: ${listOrNone(report.config.project?.packages)}`,
    `- Project agents: ${listOrNone(report.config.project?.agents)}`,
    `- Project profiles: ${listOrNone(report.config.project?.profiles)}`,
    "",
    "## Managed State",
    `- State root checked: ${report.manifests.root}`,
    `- Install manifests: ${listOrNone(report.manifests.installManifests)}`,
    `- Source locks: ${listOrNone(report.manifests.sourceLocks)}`,
    "",
    "## Checks",
    ...report.checks.map((check) => `- ${check.status} ${check.id}: ${check.message}`),
    "",
    "## Recommended Next Command",
    `- ${report.recommendedNextCommand}`,
  ];
  if (report.agentwheel.status.stdout) {
    lines.push("", "## agentwheel status stdout", "```text", report.agentwheel.status.stdout, "```");
  }
  if (report.agentwheel.status.stderr) {
    lines.push("", "## agentwheel status stderr", "```text", report.agentwheel.status.stderr, "```");
  }
  return lines.join("\n");
}

function summarizeStatus(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim();
  if (!text) return "no status output";
  const interesting = text.split(/\r?\n/).filter((line) =>
    /Status for|Install manifest|Graph lock|Pending install work|No agents configured|No packages configured|drift|conflict/i.test(line),
  );
  return interesting.length > 0 ? interesting.join(" | ") : firstLine(text);
}

function statusFailure(status) {
  return status.stderr || status.stdout || "agentwheel status failed.";
}

function pushCheck(checks, status, id, message) {
  checks.push({ status, id, message });
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function listOrNone(values) {
  return values && values.length > 0 ? values.join(", ") : "none";
}

function findUp(start, relativePath) {
  let cursor = resolve(start);
  while (true) {
    const candidate = join(cursor, relativePath);
    if (existsSync(candidate)) return candidate;
    const next = dirname(cursor);
    if (next === cursor) return null;
    cursor = next;
  }
}

function rootBeforeMarker(path, marker) {
  const parts = resolve(path).split(sep).filter(Boolean);
  for (let index = 0; index <= parts.length - marker.length; index += 1) {
    if (marker.every((part, offset) => parts[index + offset] === part)) {
      const rootParts = parts.slice(0, index);
      return `${sep}${rootParts.join(sep)}`;
    }
  }
  return null;
}

function containsSegments(path, marker) {
  return Boolean(rootBeforeMarker(path, marker));
}
