import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMarkdownIncludes } from "../compose/markdown.js";
import { artifactTypeSchema } from "./artifact.js";
import { findPackageManifestPath, readPackageManifest, type PackageManifest } from "./package.js";
import { LocalSourceDriver } from "../source/local.js";

export interface PackageValidationFinding {
  level: "error" | "warning";
  message: string;
  path?: string;
}

export interface PackageValidationResult {
  ok: boolean;
  manifestPath?: string;
  findings: PackageValidationFinding[];
}

export async function validatePackage(root: string): Promise<PackageValidationResult> {
  const packageRoot = resolve(root);
  const findings: PackageValidationFinding[] = [];
  const manifestPath = await findPackageManifestPath(packageRoot);
  if (!manifestPath) {
    return { ok: false, findings: [{ level: "error", message: "No openpack.json, openpack.jsonc, agentwheel.json, or agentwheel.jsonc found", path: packageRoot }] };
  }

  let manifest: PackageManifest | undefined;
  try {
    manifest = await readPackageManifest(packageRoot);
  } catch (error) {
    return { ok: false, manifestPath, findings: [{ level: "error", message: error instanceof Error ? error.message : String(error), path: manifestPath }] };
  }
  if (!manifest) {
    return { ok: false, manifestPath, findings: [{ level: "error", message: "Package manifest not found", path: packageRoot }] };
  }

  validateDeclaredSelectors(manifest, findings, manifestPath);

  try {
    const driver = new LocalSourceDriver();
    const artifacts = await driver.list({
      driver: "local",
      source: packageRoot,
      resolvedPath: packageRoot,
      packageName: manifest.name,
      packageVersion: manifest.version,
      mode: "pinned",
    });
    await validateMarkdownIncludes(artifacts, packageRoot, { allowCrossPackage: true });
  } catch (error) {
    findings.push({ level: "error", message: error instanceof Error ? error.message : String(error), path: packageRoot });
  }

  if (manifest.schemaVersion === 2 && manifest.compose) {
    for (const entry of manifest.compose) {
      await validateManifestComposeInclude(packageRoot, entry.include, entry.optional === true, findings, manifestPath, Object.keys(manifest.requires ?? {}));
    }
  }

  return { ok: !findings.some((finding) => finding.level === "error"), manifestPath, findings };
}

function validateDeclaredSelectors(manifest: PackageManifest, findings: PackageValidationFinding[], manifestPath: string): void {
  if (manifest.schemaVersion === 2) {
    for (const [alias, dependency] of Object.entries(manifest.requires ?? {})) {
      if (!alias.trim()) {
        findings.push({ level: "error", message: "Dependency alias must be non-empty", path: manifestPath });
      }
      for (const selector of dependency.select ?? []) {
        validateSelector(selector, `requires.${alias}.select`, findings, manifestPath, { localOnly: true });
      }
    }
  }

  for (const [provideIndex, provide] of manifest.provides.entries()) {
    if (!("items" in provide) || !provide.items) continue;
    for (const [itemName, item] of Object.entries(provide.items)) {
      for (const requirement of item.requires ?? []) {
        const selector = typeof requirement === "string" ? requirement : requirement.selector;
        validateSelector(selector, `provides[${provideIndex}].items.${itemName}.requires`, findings, manifestPath, { aliases: manifest.schemaVersion === 2 ? Object.keys(manifest.requires ?? {}) : [] });
      }
      for (const entry of item.compose ?? []) {
        validateSelector(entry.include, `provides[${provideIndex}].items.${itemName}.compose.include`, findings, manifestPath, {
          aliases: manifest.schemaVersion === 2 ? Object.keys(manifest.requires ?? {}) : [],
          fragmentsOnly: true,
        });
      }
    }
  }
}

async function validateManifestComposeInclude(
  packageRoot: string,
  selector: string,
  optional: boolean,
  findings: PackageValidationFinding[],
  manifestPath: string,
  aliases: string[] = [],
): Promise<void> {
  try {
    validateSelector(selector, "compose.include", findings, manifestPath, { fragmentsOnly: true, aliases });
    if (isCrossPackageSelector(selector)) return;
    const full = resolve(packageRoot, selector);
    if (full !== packageRoot && !full.startsWith(`${packageRoot}/`)) {
      findings.push({ level: "error", message: `Compose include escapes package root: ${selector}`, path: manifestPath });
      return;
    }
    if (!optional) await stat(full);
  } catch (error) {
    if (!optional) {
      findings.push({ level: "error", message: error instanceof Error ? error.message : String(error), path: manifestPath });
    }
  }
}

function validateSelector(
  value: string,
  context: string,
  findings: PackageValidationFinding[],
  manifestPath: string,
  options: { localOnly?: boolean; fragmentsOnly?: boolean; aliases?: string[] } = {},
): void {
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  if (colon >= 0 && (slash < 0 || colon < slash)) {
    if (options.localOnly) {
      findings.push({ level: "error", message: `${context}: cross-package selector is not allowed here: ${value}`, path: manifestPath });
      return;
    }
    const alias = value.slice(0, colon);
    if (!alias || alias.includes("/")) {
      findings.push({ level: "error", message: `${context}: invalid selector alias: ${value}`, path: manifestPath });
      return;
    }
    if (options.aliases && !options.aliases.includes(alias)) {
      findings.push({ level: "error", message: `${context}: dependency alias not declared: ${alias}`, path: manifestPath });
      return;
    }
  }

  const selector = colon >= 0 && colon < slash ? value.slice(colon + 1) : value;
  const selectorSlash = selector.indexOf("/");
  if (selectorSlash <= 0 || selectorSlash === selector.length - 1) {
    findings.push({ level: "error", message: `${context}: invalid selector ${value}; expected type/name or alias:type/name`, path: manifestPath });
    return;
  }

  const type = selector.slice(0, selectorSlash);
  const parsedType = artifactTypeSchema.safeParse(type);
  if (!parsedType.success) {
    findings.push({ level: "error", message: `${context}: invalid selector type ${type}`, path: manifestPath });
    return;
  }
  if (options.fragmentsOnly && parsedType.data !== "fragments") {
    findings.push({ level: "error", message: `${context}: compose includes may inline only fragments: ${value}`, path: manifestPath });
  }
}

function isCrossPackageSelector(value: string): boolean {
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  return colon >= 0 && (slash < 0 || colon < slash);
}
