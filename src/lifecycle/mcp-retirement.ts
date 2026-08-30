import type { AdapterConfig } from "../model/adapter.js";
import type { InstallManifest } from "../model/manifest.js";
import { createCombinedInstallPlan } from "../install/plan.js";
import type { DesiredArtifact } from "../install/desired.js";
import type { InstallPlan } from "../install/plan.js";
import { localTransport } from "../transport/index.js";
import type { TargetTransport } from "../transport/index.js";

export interface ExactMcpRetirementOptions {
  installationType: string;
  stateKey: string;
  workspaceOwner: string;
  expectedFromWorkspaceOwner?: string;
  graphLockDigest?: string;
}

/**
 * Build a one-shot, fail-closed removal plan for one exact MCP contribution.
 * This deliberately does not change the normal desired-state install contract.
 */
export async function createExactMcpRetirementPlan(
  desiredArtifacts: DesiredArtifact[],
  adapter: AdapterConfig,
  targetRoot: string,
  manifest: InstallManifest | undefined,
  transport: TargetTransport = localTransport,
  options: ExactMcpRetirementOptions,
): Promise<InstallPlan> {
  if (desiredArtifacts.length !== 1 || desiredArtifacts[0]?.type !== "mcp") {
    throw new Error(`Exact MCP retirement requires exactly one MCP artifact; found ${desiredArtifacts.length}.`);
  }
  if (manifest && manifest.version !== 2) {
    throw new Error("Exact MCP retirement requires an Agentwheel v2 install manifest when managed state exists.");
  }
  if (manifest && manifest.entries.length !== 1) {
    throw new Error(`Exact MCP retirement requires exactly one manifest entry; found ${manifest.entries.length}.`);
  }
  if (options.expectedFromWorkspaceOwner && !manifest) {
    throw new Error(`Expected managed MCP ownership from ${options.expectedFromWorkspaceOwner}, but no manifest exists.`);
  }
  if (options.expectedFromWorkspaceOwner === options.workspaceOwner) {
    throw new Error("Exact MCP retirement ownership handoff requires different old and new workspace owners.");
  }

  const adoption = await createCombinedInstallPlan(
    desiredArtifacts,
    adapter,
    targetRoot,
    undefined,
    transport,
    {
      baseRevision: manifest?.revision ?? null,
      graphLockDigest: options.graphLockDigest,
      workspaceOwner: options.workspaceOwner,
      installationType: options.installationType,
      stateKey: options.stateKey,
      forceConflict: true,
    },
  );
  if (adoption.operations.length !== 1) {
    throw new Error(`Exact MCP retirement expected one rendered operation; found ${adoption.operations.length}.`);
  }
  const operation = adoption.operations[0]!;
  if (adoption.hasBlockingChanges || operation.action !== "skip" || !operation.mergeStrategy || !operation.mergeRemoval) {
    return adoption;
  }
  if (operation.mergeStrategy !== "json-deep" && operation.mergeStrategy !== "codex-toml-mcp") {
    throw new Error(`Exact MCP retirement does not support merge strategy ${operation.mergeStrategy}.`);
  }
  const removalKeys = Object.keys(operation.mergeRemoval);
  const servers = operation.mergeRemoval.mcpServers;
  if (removalKeys.length !== 1 || removalKeys[0] !== "mcpServers"
    || !servers || typeof servers !== "object" || Array.isArray(servers)
    || Object.keys(servers).length === 0) {
    throw new Error("Exact MCP retirement requires one or more MCP servers and no non-MCP configuration.");
  }

  const entry = manifest?.entries[0];
  if (entry) {
    const mismatches: string[] = [];
    if (entry.artifactType !== operation.artifactType) mismatches.push(`artifact type ${entry.artifactType}`);
    if (entry.artifactName !== operation.artifactName) mismatches.push(`artifact name ${entry.artifactName}`);
    if (entry.path !== operation.relativeDestPath) mismatches.push(`path ${entry.path}`);
    if (entry.sourceHash !== operation.desiredHash) mismatches.push("source hash");
    if (entry.mergeStrategy !== operation.mergeStrategy) mismatches.push(`merge strategy ${entry.mergeStrategy ?? "missing"}`);
    if (entry.mergeCreatedDestination === true) mismatches.push("manifest claims ownership of the whole destination");
    const expectedOwner = options.expectedFromWorkspaceOwner ?? options.workspaceOwner;
    if (entry.workspaceOwner !== expectedOwner) mismatches.push(`owner ${entry.workspaceOwner}`);
    if (mismatches.length > 0) {
      throw new Error(`Exact MCP retirement manifest precondition failed: ${mismatches.join(", ")}.`);
    }
  }

  return {
    ...adoption,
    baseRevision: manifest?.revision ?? null,
    operations: [{
      ...operation,
      action: "remove",
      exactMergeRemoval: true,
      manifestHash: entry?.hash,
      workspaceOwner: options.workspaceOwner,
      reason: entry
        ? `retire exact MCP contribution after explicit ownership handoff from ${entry.workspaceOwner}`
        : `retire exact unmanaged MCP contribution under ${options.workspaceOwner}`,
    }],
  };
}
