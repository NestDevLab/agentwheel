import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { WorkspaceProfileMember } from "../model/workspace.js";
import {
  statusReportSchema,
  worstStatusHealth,
  type StatusHealth,
  type StatusMember,
  type StatusReport,
} from "../status/report.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

const execFileAsync = promisify(execFile);
const memberCacheSchema = z.object({
  schemaVersion: z.literal(1),
  checkedAt: z.string().datetime(),
  report: statusReportSchema,
});

export interface CollectMembersOptions {
  cliVersion: string;
  workspaceRoot: string;
  profileName: string;
  profileTtlSeconds: number;
  members: WorkspaceProfileMember[];
  refresh?: boolean;
  offline?: boolean;
  chain?: string[];
  cliEntry?: string;
}

export interface MemberCommandResult {
  stdout: string;
  stderr: string;
}

export async function collectCompositeMembers(options: CollectMembersOptions): Promise<StatusMember[]> {
  const chain = [...(options.chain ?? []), compositeKey(options.workspaceRoot, options.profileName)];
  const results: StatusMember[] = [];
  for (const member of options.members) {
    results.push(await collectMember(member, options, chain));
  }
  return results;
}

async function collectMember(
  member: WorkspaceProfileMember,
  options: CollectMembersOptions,
  chain: string[],
): Promise<StatusMember> {
  const cachePath = memberCachePath(options.workspaceRoot, options.profileName, member.id);
  const cached = await readMemberCache(cachePath);
  const ttlSeconds = member.refreshTtlSeconds ?? options.profileTtlSeconds;
  const ageMs = cached ? Date.now() - new Date(cached.checkedAt).getTime() : Number.POSITIVE_INFINITY;
  const fresh = ageMs <= ttlSeconds * 1000;

  if (options.offline || (cached && fresh && !options.refresh)) {
    if (!cached) {
      return memberFailure(member, "STALE", "No cached member status is available offline.");
    }
    return memberFromReport(member, cached.report, {
      checkedAt: cached.checkedAt,
      stale: options.offline || !fresh,
      health: options.offline || !fresh
        ? worstStatusHealth([cached.report.health, "STALE"])
        : cached.report.health,
    });
  }

  try {
    const report = await invokeMemberStatus(member, options.workspaceRoot, chain, {
      refresh: options.refresh || !fresh,
      offline: false,
    }, options.cliEntry);
    const checkedAt = new Date().toISOString();
    await writeJsonAtomic(cachePath, { schemaVersion: 1, checkedAt, report });
    const versionHealth: StatusHealth = report.agentwheelVersion === options.cliVersion ? "PASS" : "WARN";
    return memberFromReport(member, report, {
      checkedAt,
      stale: false,
      health: worstStatusHealth([report.health, versionHealth]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const incompatible = /Incompatible member status protocol|Unknown option.*--json|Unknown command.*status/i.test(message);
    if (cached) {
      return memberFromReport(member, cached.report, {
        checkedAt: cached.checkedAt,
        stale: true,
        health: incompatible ? "INCOMPATIBLE" : "DEGRADED",
        error: message,
      });
    }
    return memberFailure(member, incompatible ? "INCOMPATIBLE" : "FAIL", message);
  }
}

async function invokeMemberStatus(
  member: WorkspaceProfileMember,
  parentWorkspace: string,
  chain: string[],
  options: { refresh: boolean; offline: boolean },
  cliEntry = process.argv[1]!,
): Promise<StatusReport> {
  const args = ["--no-update-check", "status", "--profile", member.profile, "--json"];
  if (options.refresh) args.push("--refresh");
  if (options.offline) args.push("--offline");
  const env = { ...process.env, AGENTWHEEL_COMPOSITE_CHAIN: JSON.stringify(chain) };
  let stdout = "";
  let stderr = "";

  try {
    if (member.transport === "local") {
      const workspace = resolve(parentWorkspace, member.workspace);
      const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
        cwd: workspace,
        env,
        maxBuffer: 20 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      const sshArgs = sshArguments(member);
      const remoteArgs = [
        `cd ${shellQuote(member.workspace)}`,
        "&&",
        `AGENTWHEEL_COMPOSITE_CHAIN=${shellQuote(JSON.stringify(chain))}`,
        "agentwheel",
        ...args.map(shellQuote),
      ];
      const result = await execFileAsync("ssh", [...sshArgs, remoteArgs.join(" ")], {
        env,
        maxBuffer: 20 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    }
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      stdout = "stdout" in error ? String(error.stdout ?? "") : "";
      stderr = "stderr" in error ? String(error.stderr ?? "") : "";
    }
    if (!stdout.trim()) throw error;
  }

  try {
    return statusReportSchema.parse(JSON.parse(stdout));
  } catch (error) {
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Incompatible member status protocol for ${member.id}: ${detail}`);
  }
}

export async function runMemberAgentwheel(
  member: WorkspaceProfileMember,
  parentWorkspace: string,
  args: string[],
  chain: string[],
): Promise<MemberCommandResult> {
  const env = { ...process.env, AGENTWHEEL_COMPOSITE_CHAIN: JSON.stringify(chain) };
  try {
    if (member.transport === "local") {
      const result = await execFileAsync(
        process.execPath,
        [process.argv[1]!, "--no-update-check", ...args],
        {
          cwd: resolve(parentWorkspace, member.workspace),
          env,
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      return { stdout: result.stdout, stderr: result.stderr };
    }
    const remoteArgs = [
      `cd ${shellQuote(member.workspace)}`,
      "&&",
      `AGENTWHEEL_COMPOSITE_CHAIN=${shellQuote(JSON.stringify(chain))}`,
      "agentwheel",
      "--no-update-check",
      ...args.map(shellQuote),
    ];
    const result = await execFileAsync("ssh", [...sshArguments(member), remoteArgs.join(" ")], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = commandErrorDetail(error);
    if (/lock|busy|timed out waiting/i.test(detail)) {
      throw new Error(`BUSY ${member.id}: ${detail}`);
    }
    throw new Error(`Member ${member.id} command failed: ${detail}`);
  }
}

function sshArguments(member: WorkspaceProfileMember): string[] {
  const destination = member.user ? `${member.user}@${member.host}` : member.host!;
  return [
    ...(member.port ? ["-p", String(member.port)] : []),
    ...(member.identityFile ? ["-i", member.identityFile] : []),
    "--",
    destination,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function commandErrorDetail(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? String(error.stderr).trim() : "";
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function memberFromReport(
  member: WorkspaceProfileMember,
  report: StatusReport,
  state: { checkedAt: string; stale: boolean; health: StatusHealth; error?: string },
): StatusMember {
  return {
    id: member.id,
    transport: member.transport,
    workspace: member.workspace,
    profile: member.profile,
    health: state.health,
    agentwheelVersion: report.agentwheelVersion,
    checkedAt: state.checkedAt,
    stale: state.stale,
    ...(state.error ? { error: state.error } : {}),
    report,
  };
}

function memberFailure(member: WorkspaceProfileMember, health: StatusHealth, error: string): StatusMember {
  return {
    id: member.id,
    transport: member.transport,
    workspace: member.workspace,
    profile: member.profile,
    health,
    agentwheelVersion: null,
    checkedAt: null,
    stale: true,
    error,
  };
}

function memberCachePath(workspaceRoot: string, profileName: string, memberId: string): string {
  return join(workspaceRoot, ".agentwheel", "cache", "member-status", profileName, `${memberId}.json`);
}

async function readMemberCache(path: string) {
  if (!(await pathExists(path))) return undefined;
  try {
    return memberCacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function parseCompositeChain(): string[] {
  const value = process.env.AGENTWHEEL_COMPOSITE_CHAIN;
  if (!value) return [];
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid AGENTWHEEL_COMPOSITE_CHAIN protocol value.");
  }
}

export function assertNoCompositeCycle(workspaceRoot: string, profileName: string, chain: string[]): void {
  const key = compositeKey(workspaceRoot, profileName);
  if (chain.includes(key)) {
    throw new Error(`Composite profile cycle detected: ${[...chain, key].join(" -> ")}`);
  }
}

export function compositeKey(workspaceRoot: string, profileName: string): string {
  return `${resolve(workspaceRoot)}#${profileName}`;
}
