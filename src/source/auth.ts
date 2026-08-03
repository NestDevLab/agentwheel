import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GitAuthProfile {
  provider: "gh";
  account: string;
  repositories: string[];
}

interface GitAuthConfig {
  profiles: Record<string, GitAuthProfile>;
}

const AUTH_CONFIG_ENV = "AGENTWHEEL_AUTH_CONFIG";

export async function gitAuthArguments(url: string): Promise<string[]> {
  const profile = await matchingGitAuthProfile(url);
  if (!profile) return [];

  if (profile.provider !== "gh") {
    throw new Error(`Unsupported Agentwheel Git auth provider: ${profile.provider}`);
  }

  const account = shellQuote(profile.account);
  const helper = `!f() { echo username=x-access-token; echo password=\"$(gh auth token --user ${account})\"; }; f`;
  return ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
}

export async function matchingGitAuthProfile(url: string): Promise<GitAuthProfile | undefined> {
  const config = await readGitAuthConfig();
  if (!config) return undefined;

  const repository = repositoryKey(url);
  return Object.values(config.profiles).find((profile) =>
    profile.repositories.some((pattern) => matchesRepository(pattern, repository)),
  );
}

async function readGitAuthConfig(): Promise<GitAuthConfig | undefined> {
  const path = process.env[AUTH_CONFIG_ENV] ?? join(homedir(), ".agentwheel", "auth.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseGitAuthConfig(parsed, path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid Agentwheel auth config JSON: ${path}`);
    throw error;
  }
}

function parseGitAuthConfig(value: unknown, path: string): GitAuthConfig {
  if (!isRecord(value) || !isRecord(value.profiles)) {
    throw new Error(`Invalid Agentwheel auth config: expected profiles in ${path}`);
  }

  const profiles: Record<string, GitAuthProfile> = {};
  for (const [name, candidate] of Object.entries(value.profiles)) {
    if (!isRecord(candidate) || candidate.provider !== "gh" || typeof candidate.account !== "string" || !Array.isArray(candidate.repositories)) {
      throw new Error(`Invalid Agentwheel auth profile '${name}' in ${path}`);
    }
    const repositories = candidate.repositories.filter((repository): repository is string => typeof repository === "string" && repository.length > 0);
    if (repositories.length !== candidate.repositories.length) {
      throw new Error(`Invalid repository matcher in Agentwheel auth profile '${name}' in ${path}`);
    }
    profiles[name] = { provider: "gh", account: candidate.account, repositories };
  }
  return { profiles };
}

function repositoryKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}/${parsed.pathname.replace(/^\//, "").replace(/\.git$/, "")}`.toLowerCase();
}

function matchesRepository(pattern: string, repository: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(repository);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
