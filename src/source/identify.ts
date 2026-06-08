import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathExists } from "../utils/fs.js";

export type SourceDriverName = "local" | "git" | "skillkit" | "vercel-skills";

export function inferSourceDriverName(source: string): SourceDriverName {
  if (source.startsWith("skillkit:")) return "skillkit";
  if (source.startsWith("vercel:")) return "vercel-skills";
  return source.startsWith("github:") || source.startsWith("git:") ? "git" : "local";
}

export async function isExplicitSource(source: string): Promise<boolean> {
  if (source.startsWith("github:") || source.startsWith("git:") || source.startsWith("skillkit:") || source.startsWith("vercel:")) {
    return true;
  }
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/") || source.startsWith("~/")) {
    return true;
  }
  return pathExists(resolveLocalPath(source));
}

function resolveLocalPath(source: string): string {
  if (source === "~") return homedir();
  if (source.startsWith("~/")) return resolve(homedir(), source.slice(2));
  return resolve(source);
}
