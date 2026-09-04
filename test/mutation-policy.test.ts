import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { commandGovernance, commandGovernanceMode, isGovernedCommand, requiresCleanMutationPreflight } from "../src/mutation/commands.js";
import { GovernedMutation, mergeMutationPolicies, recoverMutationRuntime, resumeMutation } from "../src/mutation/coordinator.js";
import { declareMutationPath } from "../src/mutation/declarations.js";
import { invokeRevisionProvider } from "../src/mutation/providers.js";
import {
  revisionPathSchema,
  revisionProviderErrorResponseSchema,
  revisionProviderRequestSchema,
  revisionProviderResponseSchema,
  type RevisionProviderRequest,
} from "../src/mutation/protocol.js";
import {
  acquireMutationLock,
  createMutationReceipt,
  listMutationReceipts,
  mutationStateRoot,
  readMutationReceipt,
  updateMutationReceipt,
} from "../src/mutation/receipts.js";
import { workspaceConfigPath, workspaceConfigSchema, writeWorkspaceConfig } from "../src/model/workspace.js";
import { revisionProviderConfigSchema } from "../src/model/mutation.js";
import type { AdapterConfig } from "../src/model/adapter.js";
import type { GraphLock } from "../src/model/graph-lock.js";
import { applyCombinedInstallPlan, createCombinedInstallPlan, type DesiredArtifact } from "../src/install/index.js";
import { writeInstallManifest } from "../src/install/manifest.js";
import { installManifestPath } from "../src/install/paths.js";
import { applyJournalPath } from "../src/install/transaction.js";
import { applyRetireStaleOwnership, planRetireStaleOwnership } from "../src/lifecycle/ownership-retire-stale.js";
import { workspaceOwnerForRoot } from "../src/model/workspace-owner.js";
import { localTransport, type TargetTransport } from "../src/transport/index.js";
import { hashPath, pathExists } from "../src/utils/fs.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalStateRoot = process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
const nodeExecutableSha256 = sha256(readFileSync(process.execPath));
const localSyncwheelSource = [
  process.env.SYNCWHEEL_SOURCE_ROOT,
  resolve(process.cwd(), "..", "syncwheel-revision-provider-work"),
  resolve(process.cwd(), "..", "syncwheel"),
].find((candidate): candidate is string => Boolean(candidate)
  && existsSync(join(candidate!, "scripts", "syncwheel.py"))
  && existsSync(join(candidate!, "scripts", "syncwheel_revision_provider.py")));

afterEach(async () => {
  if (originalStateRoot === undefined) delete process.env.AGENTWHEEL_MUTATION_STATE_ROOT;
  else process.env.AGENTWHEEL_MUTATION_STATE_ROOT = originalStateRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("mutation policy and revision provider v1", () => {
  it("keeps v1-v3 compatible while making mutationPolicy a strict v4-only field", () => {
    for (const schemaVersion of [1, 2, 3] as const) {
      expect(workspaceConfigSchema.parse({ schemaVersion }).schemaVersion).toBe(schemaVersion);
      expect(() => workspaceConfigSchema.parse({ schemaVersion, mutationPolicy: mutationPolicy() })).toThrow();
    }
    const parsed = workspaceConfigSchema.parse({ schemaVersion: 4, mutationPolicy: mutationPolicy() });
    expect(parsed.schemaVersion).toBe(4);
    expect(() => workspaceConfigSchema.parse({
      schemaVersion: 4,
      mutationPolicy: { ...mutationPolicy(), extra: true },
    })).toThrow();
  });

  it("parses canonical golden request/success/error fixtures and rejects product control paths", async () => {
    const fixtureRoot = join(process.cwd(), "test", "fixtures", "revision-provider-v1");
    expect(revisionProviderRequestSchema.parse(
      JSON.parse(await readFile(join(fixtureRoot, "check-request.json"), "utf8")),
    ).action).toBe("check");
    expect(revisionProviderResponseSchema.parse(
      JSON.parse(await readFile(join(fixtureRoot, "check-response.json"), "utf8")),
    ).status).toBe("ready");
    const request = revisionProviderRequestSchema.parse(JSON.parse(await readFile(join(fixtureRoot, "request-finalize.json"), "utf8")));
    expect(request.action).toBe("finalize");
    expect(revisionProviderResponseSchema.parse(
      JSON.parse(await readFile(join(fixtureRoot, "response-finalize.json"), "utf8")),
    ).ok).toBe(true);
    expect(revisionProviderErrorResponseSchema.parse(
      JSON.parse(await readFile(join(fixtureRoot, "response-finalize-error.json"), "utf8")),
    ).ok).toBe(false);
    for (const path of [".git", ".git/config", ".syncwheel/manifest.json", ".syncwheel/ledger/event.json"]) {
      expect(() => revisionPathSchema.parse({ path, beforeSha256: null, afterSha256: "a".repeat(64) })).toThrow();
    }
    expect(() => revisionProviderRequestSchema.parse({ ...request, unexpected: true })).toThrow();
    expect(() => revisionProviderRequestSchema.parse({ ...request, protocolVersion: 2 })).toThrow();
    expect(() => revisionProviderRequestSchema.parse({ ...request, operationId: "contains.dot" })).toThrow();
    const negativeVectors = JSON.parse(
      await readFile(join(fixtureRoot, "negative-request-vectors.json"), "utf8"),
    ) as Array<{ name: string; overrides: Record<string, unknown> }>;
    for (const vector of negativeVectors) {
      expect(
        () => revisionProviderRequestSchema.parse({ ...request, ...vector.overrides }),
        vector.name,
      ).toThrow();
    }
  });

  it("accepts exit 2 only as a strict structured command-provider rejection", async () => {
    const root = await tempRoot("agentwheel-provider-command-");
    const script = join(root, "reject.mjs");
    await writeFile(script, `let input=""; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); process.stdout.write(JSON.stringify({protocolVersion:1,providerId:"command-test",action:request.action,operationId:request.operationId,ok:false,status:"rejected",error:"synthetic rejection"})); process.exitCode=2;\n`);
    await expect(invokeRevisionProvider({
      kind: "command",
      id: "command-test",
      command: [process.execPath, script],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/synthetic rejection/);

    const hanging = join(root, "hang.mjs");
    await writeFile(hanging, "setInterval(() => {}, 1000);\n", "utf8");
    await expect(invokeRevisionProvider({
      kind: "command",
      id: "command-test",
      command: [process.execPath, hanging],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      timeoutMs: 100,
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/100ms execution timeout/i);

    await expect(invokeRevisionProvider({
      kind: "command",
      id: "command-test",
      command: ["node", script],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/absolute normalized path/i);
    await expect(invokeRevisionProvider({
      kind: "command",
      id: "command-test",
      command: [process.execPath, script],
      executableSha256: "0".repeat(64),
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/executable hash mismatch/i);
    expect(() => revisionProviderConfigSchema.parse({
      kind: "command",
      id: "command-test",
      command: [process.execPath, script],
      executableSha256: nodeExecutableSha256,
      protocolVersion: 1,
    })).toThrow(/trustBoundary/i);
    expect(() => revisionProviderConfigSchema.parse({
      kind: "module",
      id: "removed-module-provider",
      module: "/tmp/provider.mjs",
      sha256: "a".repeat(64),
      protocolVersion: 1,
    })).toThrow();
  });

  it("executes immutable verified bytes when the configured executable is rewritten in place", async () => {
    const root = await tempRoot("agentwheel-provider-substitution-");
    const executable = join(root, "provider");
    const providerScript = join(root, "provider.mjs");
    const source = readFileSync(process.execPath);
    await writeFile(providerScript, [
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const request = JSON.parse(input);",
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, providerId: 'pinned-command', action: request.action, operationId: request.operationId, ok: true, status: 'ready' }));",
      "",
    ].join("\n"), "utf8");
    await writeFile(executable, source, { mode: 0o700 });
    const replacement = await readFile("/bin/false");

    await expect(invokeRevisionProvider({
      kind: "command",
      id: "pinned-command",
      command: [executable, providerScript],
      executableSha256: sha256(source),
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, checkRequest(root), {
      workspaceRoot: root,
      afterCommandExecutablePinned: async () => writeFile(executable, replacement, { mode: 0o700 }),
    })).resolves.toMatchObject({ providerId: "pinned-command", status: "ready" });
    expect(sha256(await readFile(executable))).not.toBe(sha256(source));
  });

  it("kills the complete command-provider process group on timeout", async () => {
    const root = await tempRoot("agentwheel-provider-process-group-");
    const script = join(root, "spawn-grandchild.mjs");
    const marker = join(root, "grandchild-survived");
    await writeFile(script, [
      "import { spawn } from 'node:child_process';",
      "const marker = process.argv[2];",
      "const node = process.argv[3];",
      "spawn(node, ['-e', `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 350)`, marker], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"), "utf8");

    await expect(invokeRevisionProvider({
      kind: "command",
      id: "process-group-test",
      command: [process.execPath, script, marker, process.execPath],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      timeoutMs: 100,
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/100ms execution timeout/i);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    await expect(stat(marker)).rejects.toThrow();
  });

  it.skipIf(localSyncwheelSource === undefined)(
    "recovers idempotently through Agentwheel against real Syncwheel after every durable phase",
    async () => {
      const syncwheelSource = await snapshotSyncwheelSource(localSyncwheelSource!);
      const bridgeSource = await readFile(
        join(process.cwd(), "test", "fixtures", "revision-provider-v1", "syncwheel-fault-bridge.py"),
      );
      for (const phase of ["prepared", "product_committed", "stack_owned", "control_committed", "verified"]) {
        const fixtureRoot = await tempRoot(`agentwheel-syncwheel-${phase}-`);
        const repo = await syncwheelProviderRepo(syncwheelSource, fixtureRoot);
        const bridge = join(fixtureRoot, "syncwheel-fault-bridge.py");
        const marker = join(fixtureRoot, `${phase}.faulted`);
        await writeFile(bridge, bridgeSource, { mode: 0o700 });
        const provider = {
          kind: "command" as const,
          id: "syncwheel",
          command: [bridge, syncwheelSource, phase, marker],
          executableSha256: sha256(bridgeSource),
          trustBoundary: "entrypoint" as const,
          timeoutMs: 30_000,
          protocolVersion: 1 as const,
        };
        const expectedHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
        const operationId = `agentwheel-syncwheel-${phase.replaceAll("_", "-")}`;
        const base = {
          protocolVersion: 1 as const,
          operationId,
          repositoryRoot: repo,
          expectedHead,
          commandName: "agentwheel install",
          reason: `Verify black-box recovery after Syncwheel phase ${phase}`,
          noCommit: false,
          paths: [{
            path: "feature.txt",
            beforeSha256: null,
            afterSha256: sha256(Buffer.from("feature\n")),
          }],
        };
        await expect(invokeRevisionProvider(provider, revisionProviderRequestSchema.parse({
          ...base,
          action: "check",
          paths: [],
        }), { workspaceRoot: repo })).resolves.toMatchObject({ status: "ready" });
        await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");
        const preflight = revisionProviderRequestSchema.parse({ ...base, action: "preflight" });
        if (phase === "prepared") {
          await expect(invokeRevisionProvider(provider, preflight, { workspaceRoot: repo }))
            .rejects.toThrow(/injected Agentwheel black-box fault/);
        } else {
          await expect(invokeRevisionProvider(provider, preflight, { workspaceRoot: repo }))
            .resolves.toMatchObject({ status: "prepared" });
          await expect(invokeRevisionProvider(provider, revisionProviderRequestSchema.parse({
            ...base,
            action: "finalize",
          }), { workspaceRoot: repo })).rejects.toThrow(/injected Agentwheel black-box fault/);
        }

        await expect(invokeRevisionProvider(provider, preflight, { workspaceRoot: repo }))
          .resolves.toMatchObject({ status: "prepared" });
        const recover = revisionProviderRequestSchema.parse({ ...base, action: "recover" });
        const recovered = await invokeRevisionProvider(provider, recover, { workspaceRoot: repo });
        expect(recovered).toMatchObject({
          action: "recover",
          status: "verified",
          published: false,
          unmappedIntegrationCommits: [],
        });
        if (recovered.action !== "recover") throw new Error("Expected a terminal recover response.");
        expect(recovered.draftStackId).toBe(`agentwheel-${operationId}`);
        expect(recovered.draftBranch).toBe(`syncwheel/draft/agentwheel-${operationId}`);
        expect(recovered.draftTipSha).toMatch(/^[a-f0-9]{40}$/);
        await expect(invokeRevisionProvider(provider, recover, { workspaceRoot: repo }))
          .resolves.toEqual(recovered);
        expect(await git(repo, ["status", "--porcelain"])).toBe("");
      }
    },
    120_000,
  );

  it("fails closed on provider response correlation and action-specific statuses", async () => {
    const root = await tempRoot("agentwheel-provider-correlation-");
    const script = join(root, "emit.mjs");
    await writeFile(script, "process.stdout.write(process.argv[2]); process.exitCode = Number(process.argv[3]);\n", "utf8");
    const base = {
      protocolVersion: 1,
      providerId: "command-test",
      action: "check",
      operationId: "provider-check-1",
      ok: false,
      status: "rejected",
      error: "synthetic rejection",
    };
    for (const [override, message] of [
      [{ providerId: "wrong-provider" }, /provider id mismatch/i],
      [{ action: "preflight" }, /provider action mismatch/i],
      [{ operationId: "wrong-operation" }, /provider operation mismatch/i],
    ] as const) {
      await expect(invokeRevisionProvider({
        kind: "command",
        id: "command-test",
        command: [process.execPath, script, JSON.stringify({ ...base, ...override }), "2"],
        executableSha256: nodeExecutableSha256,
        trustBoundary: "entrypoint",
        protocolVersion: 1,
      }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(message);
    }

    await expect(invokeRevisionProvider({
      kind: "command",
      id: "command-test",
      command: [process.execPath, script, JSON.stringify({
        ...base,
        ok: true,
        status: "prepared",
        error: undefined,
      }), "0"],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, checkRequest(root), { workspaceRoot: root })).rejects.toThrow(/invalid check status 'prepared'/i);
  });

  it("accepts every durable Syncwheel phase on idempotent preflight replay", async () => {
    const root = await tempRoot("agentwheel-provider-preflight-phases-");
    const script = join(root, "emit.mjs");
    await writeFile(script, "process.stdout.write(process.argv[2]);\n", "utf8");
    const request = revisionProviderRequestSchema.parse({ ...checkRequest(root), action: "preflight" });
    for (const status of ["prepared", "product_committed", "stack_owned", "control_committed", "verified"]) {
      const response = {
        protocolVersion: 1,
        providerId: "syncwheel",
        action: "preflight",
        operationId: request.operationId,
        ok: true,
        status,
      };
      await expect(invokeRevisionProvider({
        kind: "command",
        id: "syncwheel",
        command: [process.execPath, script, JSON.stringify(response)],
        executableSha256: nodeExecutableSha256,
        trustBoundary: "entrypoint",
        protocolVersion: 1,
      }, request, { workspaceRoot: root })).resolves.toMatchObject({ status });
    }
  });

  it("validates terminal provider semantics against the exact request and repository", async () => {
    const repo = await plainRepo();
    const script = join(await tempRoot("agentwheel-provider-semantics-"), "emit.mjs");
    await writeFile(script, "process.stdout.write(process.argv[2]);\n", "utf8");
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const request = revisionProviderRequestSchema.parse({
      protocolVersion: 1,
      action: "finalize",
      operationId: "semantic-check-1",
      repositoryRoot: repo,
      expectedHead: head,
      commandName: "agentwheel install",
      reason: "Validate terminal response semantics",
      noCommit: true,
      paths: [],
    });
    const valid = {
      protocolVersion: 1,
      providerId: "semantic-provider",
      action: "finalize",
      operationId: request.operationId,
      ok: true,
      status: "revisioning-skipped",
      expectedHead: head,
      resultingHead: head,
      productCommitSha: null,
      draftStackId: null,
      draftBranch: null,
      draftTipSha: null,
      controlCommitSha: null,
      manifestDigest: null,
      unmappedIntegrationCommits: [],
      published: false,
    };
    const invoke = (response: Record<string, unknown>) => invokeRevisionProvider({
      kind: "command",
      id: "semantic-provider",
      command: [process.execPath, script, JSON.stringify(response)],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, request, { workspaceRoot: repo });

    await expect(invoke(valid)).resolves.toMatchObject({ status: "revisioning-skipped" });
    await expect(invoke({ ...valid, expectedHead: "1".repeat(40) })).rejects.toThrow(/expectedHead mismatch/i);
    await expect(invoke({ ...valid, status: "verified" })).rejects.toThrow(/noCommit requires/i);
    await expect(invoke({ ...valid, unmappedIntegrationCommits: ["2".repeat(40)] })).rejects.toThrow(/unmapped integration/i);
    await expect(invoke({ ...valid, draftStackId: "partial" })).rejects.toThrow(/incomplete draft ownership/i);
    await expect(invoke({
      ...valid,
      draftStackId: "owned-stack",
      draftBranch: "syncwheel/draft/owned-stack",
      draftTipSha: head,
      controlCommitSha: head,
    })).rejects.toThrow(/without a manifest digest/i);
  });

  it("distinguishes a projected draft tip from the integration control commit", async () => {
    const repo = await plainRepo();
    const script = join(await tempRoot("agentwheel-provider-draft-tip-"), "emit.mjs");
    await writeFile(script, "process.stdout.write(process.argv[2]);\n", "utf8");
    const expectedHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "product commit"]);
    const productCommitSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const productTree = (await git(repo, ["rev-parse", `${productCommitSha}^{tree}`])).trim();
    const draftTipSha = (await git(repo, ["commit-tree", productTree, "-p", expectedHead, "-m", "projected draft"])).trim();
    const draftBranch = "syncwheel/draft/owned-stack";
    await git(repo, ["update-ref", `refs/heads/${draftBranch}`, draftTipSha]);
    await git(repo, ["commit", "--allow-empty", "-m", "integration control"]);
    const controlCommitSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const request = revisionProviderRequestSchema.parse({
      protocolVersion: 1,
      action: "finalize",
      operationId: "draft-tip-check-1",
      repositoryRoot: repo,
      expectedHead,
      commandName: "agentwheel install",
      reason: "Validate independent projected draft and integration ownership",
      noCommit: false,
      paths: [{
        path: "feature.txt",
        beforeSha256: null,
        afterSha256: sha256(Buffer.from("feature\n")),
      }],
    });
    const response = {
      protocolVersion: 1,
      providerId: "semantic-provider",
      action: "finalize",
      operationId: request.operationId,
      ok: true,
      status: "verified",
      expectedHead,
      resultingHead: controlCommitSha,
      productCommitSha,
      draftStackId: "owned-stack",
      draftBranch,
      draftTipSha,
      controlCommitSha,
      manifestDigest: "a".repeat(64),
      unmappedIntegrationCommits: [],
      published: false,
    };
    const invoke = (candidate: Record<string, unknown>) => invokeRevisionProvider({
      kind: "command",
      id: "semantic-provider",
      command: [process.execPath, script, JSON.stringify(candidate)],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    }, request, { workspaceRoot: repo });

    await expect(invoke(response)).resolves.toMatchObject({ draftTipSha, controlCommitSha });
    await expect(invoke({ ...response, draftTipSha: "1".repeat(40) })).rejects.toThrow(/not draft tip/i);
    await expect(invoke({ ...response, draftTipSha: null })).rejects.toThrow(/incomplete draft ownership/i);
  });

  it("fails an anticipated dirty path before handler side effects but preserves unrelated dirt", async () => {
    const { repo, globalRoot } = await governedRepo();
    const configPath = workspaceConfigPath(repo);
    await writeFile(configPath, `${(await readFile(configPath, "utf8")).trim()}\n `, "utf8");
    const marker = join(repo, "handler-ran");
    await expect(GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      reason: "Test dirty intended path refusal",
      anticipatedPaths: [configPath],
    })).rejects.toThrow(/already dirty/i);
    await expect(stat(marker)).rejects.toThrow();

    await git(repo, ["checkout", "--", ".agentwheel/config.json"]);
    await writeFile(join(repo, "notes.txt"), "unrelated dirty\n", "utf8");
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      reason: "Commit only the exact desired-state path",
      anticipatedPaths: [configPath],
    });
    expect(mutation).toBeTruthy();
    await changeWorkspaceConfig(repo);
    const receipt = await mutation!.complete();
    expect(receipt.status).toBe("succeeded");
    expect((await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim()).toBe(".agentwheel/config.json");
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("unrelated dirty\n");
    expect(await git(repo, ["status", "--short"])).toContain("notes.txt");
  });

  it("refuses an install with a dirty dynamically planned graph lock before runtime side effects", async () => {
    const { repo, globalRoot } = await governedRepo();
    const graphLockPath = join(repo, ".agentwheel", "locks", "install.graph-lock.json");
    await mkdir(join(repo, ".agentwheel", "locks"), { recursive: true });
    await writeFile(graphLockPath, "{\"version\":1}\n", "utf8");
    await git(repo, ["add", "-f", ".agentwheel/locks/install.graph-lock.json"]);
    await git(repo, ["commit", "-m", "add graph lock"]);
    await writeFile(graphLockPath, "{\"version\":1,\"dirty\":true}\n", "utf8");

    let runtimeSideEffects = 0;
    await expect((async () => {
      const mutation = await GovernedMutation.begin({
        workspaceRoot: repo,
        globalRoot,
        commandName: "agentwheel install",
        reason: "Refuse a dirty dynamically planned install path",
        requireCleanWorkingTree: requiresCleanMutationPreflight("install"),
      });
      runtimeSideEffects += 1;
      await mutation?.complete();
    })()).rejects.toThrow(/requires a clean working tree.*install\.graph-lock\.json.*Owner unknown.*Inspect the Agent Mesh session graph.*do not remove the safety block/i);
    expect(runtimeSideEffects).toBe(0);
    expect(requiresCleanMutationPreflight("add")).toBe(false);
  });

  it("turns a rejecting Git hook into commit-pending and finalizes idempotently without rerunning the handler", async () => {
    const { repo, globalRoot, stateRoot } = await governedRepo();
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    const before = await git(repo, ["rev-parse", "HEAD"]);
    let handlerRuns = 0;
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      operationId: "hook-retry-1",
      reason: "Exercise retryable hook refusal",
      anticipatedPaths: [workspaceConfigPath(repo)],
    });
    handlerRuns += 1;
    await changeWorkspaceConfig(repo);
    await expect(mutation!.complete()).rejects.toThrow(/commit-pending/i);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before.trim());
    expect((await readMutationReceipt("hook-retry-1")).status).toBe("commit-pending");

    await rm(hook);
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = stateRoot;
    const recovered = await resumeMutation("hook-retry-1", "finalize");
    expect(recovered.status).toBe("succeeded");
    expect(handlerRuns).toBe(1);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).not.toBe(before.trim());
  });

  it("preserves structured terminal provider rejection fields in a commit-pending receipt", async () => {
    const { repo, globalRoot } = await governedRepo();
    const providerRoot = await tempRoot("agentwheel-rejection-receipt-");
    const script = join(providerRoot, "provider.mjs");
    await writeFile(script, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const base = {protocolVersion: 1, providerId: "rejecting-provider", action: request.action, operationId: request.operationId};
if (request.action === "check") process.stdout.write(JSON.stringify({...base, ok: true, status: "ready"}));
else if (request.action === "preflight") process.stdout.write(JSON.stringify({...base, ok: true, status: "prepared"}));
else {
  process.stdout.write(JSON.stringify({...base, ok: false, status: "rejected", error: "synthetic finalize rejection", expectedHead: request.expectedHead, resultingHead: null, productCommitSha: null, draftStackId: "reserved-stack", draftBranch: "syncwheel/draft/reserved-stack", draftTipSha: "4444444444444444444444444444444444444444", controlCommitSha: null, manifestDigest: null, unmappedIntegrationCommits: [], published: false}));
  process.exitCode = 2;
}
`, "utf8");
    const configPath = workspaceConfigPath(repo);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mutationPolicy.revisioning.provider = {
      kind: "command",
      id: "rejecting-provider",
      command: [process.execPath, script],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await git(repo, ["add", ".agentwheel/config.json"]);
    await git(repo, ["commit", "-m", "configure rejecting provider"]);

    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      operationId: "structured-rejection-1",
      reason: "Preserve recovery coordinates from a provider rejection",
      anticipatedPaths: [configPath],
    });
    await changeWorkspaceConfig(repo);
    await expect(mutation!.complete()).rejects.toThrow(/commit-pending/i);
    const receipt = await readMutationReceipt("structured-rejection-1");
    expect(receipt.providerResponse).toMatchObject({
      ok: false,
      action: "finalize",
      expectedHead: expect.stringMatching(/^[a-f0-9]{40}$/),
      resultingHead: null,
      draftStackId: "reserved-stack",
      draftTipSha: "4".repeat(40),
      published: false,
    });
  });

  it("preflights/finalizes noCommit without moving HEAD and refuses failed partial handlers", async () => {
    const { repo, globalRoot } = await governedRepo();
    const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const skipped = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      operationId: "no-commit-1",
      reason: "Apply with audited no-commit override",
      noCommit: true,
      anticipatedPaths: [workspaceConfigPath(repo)],
    });
    await changeWorkspaceConfig(repo);
    expect((await skipped!.complete()).status).toBe("revisioning-skipped");
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);

    await git(repo, ["checkout", "--", ".agentwheel/config.json"]);
    const partial = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      operationId: "partial-1",
      reason: "Simulate handler failure",
      anticipatedPaths: [workspaceConfigPath(repo)],
    });
    await changeWorkspaceConfig(repo);
    await partial!.fail(new Error("synthetic handler failure"));
    expect((await readMutationReceipt("partial-1")).status).toBe("partial");
    await expect(resumeMutation("partial-1", "recover")).rejects.toThrow(/refused|partial/i);
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  });

  it("recovers a receipt-bound journal after an injected post-copy crash and commits only verified declarative state", async () => {
    const { repo, globalRoot } = await governedRepo();
    const sourceRoot = await tempRoot("agentwheel-crash-source-");
    const runtimeRoot = await tempRoot("agentwheel-crash-runtime-");
    const sourcePath = join(sourceRoot, "rule.md");
    await writeFile(sourcePath, "recovered runtime rule\n", "utf8");
    const adapter: AdapterConfig = {
      name: "crash-test",
      targets: { rules: { local: { enabled: true, dest: ".runtime/rules" } } },
    };
    const artifact: DesiredArtifact = {
      type: "rules",
      name: "rule.md",
      sourcePath,
      stagedPath: sourcePath,
      relativePath: "rules/rule.md",
      kind: "file",
      hash: await hashPath(sourcePath),
      channel: "managed",
      meta: {
        logicalSelector: "rules/rule.md",
        dependencyRole: "root",
        owners: ["crash-test"],
      },
    };
    const plan = await createCombinedInstallPlan([artifact], adapter, runtimeRoot);
    const graphLockPath = join(repo, ".agentwheel", "locks", "crash.graph-lock.json");
    const graphLock = emptyGraphLock("crash-test");
    const crashingTransport: TargetTransport = {
      ...localTransport,
      async atomicCopy(source, destination, kind) {
        await localTransport.atomicCopy(source, destination, kind);
        throw new Error("injected post-copy crash");
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel install",
      operationId: "runtime-crash-1",
      reason: "Recover a verified interrupted runtime install",
      anticipatedPaths: [graphLockPath],
    });
    let crash: unknown;
    try {
      await applyCombinedInstallPlan(plan, {
        transport: crashingTransport,
        graphLockDigest: "crash-lock-digest",
        graphLock: { path: graphLockPath, lock: graphLock },
      });
    } catch (error) {
      crash = error;
      await mutation!.fail(error);
    }
    expect(String(crash)).toContain("injected post-copy crash");
    const interrupted = await readMutationReceipt("runtime-crash-1");
    expect(interrupted.status).toBe("partial");
    expect(interrupted.runtimeJournals).toEqual([{
      path: applyJournalPath(runtimeRoot, adapter.name, { installationType: "local" }),
      status: "pending",
      transport: "local",
      transportDescription: "local filesystem",
      journalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(await readFile(join(runtimeRoot, ".runtime", "rules", "rule.md"), "utf8")).toBe("recovered runtime rule\n");

    const recovered = await recoverMutationRuntime("runtime-crash-1");
    expect(recovered.status).toBe("succeeded");
    expect(recovered.runtimeJournals[0]?.status).toBe("resolved");
    expect(await pathExists(applyJournalPath(runtimeRoot, adapter.name, { installationType: "local" }))).toBe(false);
    expect((await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim()).toBe(
      ".agentwheel/locks/crash.graph-lock.json",
    );
  });

  it("recovers local runtime journals when durable journaling is required but Git revisioning is off", async () => {
    const { repo, globalRoot } = await governedRepo();
    const configPath = workspaceConfigPath(repo);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mutationPolicy = {
      reason: "required",
      journal: "required",
      revisioning: { mode: "off" },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await git(repo, ["add", ".agentwheel/config.json"]);
    await git(repo, ["commit", "-m", "journal-only policy"]);
    const expectedHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const fixture = await runtimePlanFixture("journal-only-recovery");
    const graphLockPath = join(repo, ".agentwheel", "locks", "journal-only.graph-lock.json");
    let injected = false;
    const crashingTransport: TargetTransport = {
      ...localTransport,
      async atomicCopy(source, destination, kind) {
        await localTransport.atomicCopy(source, destination, kind);
        if (!injected) {
          injected = true;
          throw new Error("injected journal-only runtime crash");
        }
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel install",
      operationId: "journal-only-recovery",
      reason: "Recover local runtime state without creating a Git revision",
      anticipatedPaths: [graphLockPath],
    });
    try {
      await applyCombinedInstallPlan(fixture.plan, {
        transport: crashingTransport,
        graphLockDigest: "journal-only-digest",
        graphLock: { path: graphLockPath, lock: emptyGraphLock("journal-only") },
      });
      throw new Error("expected injected journal-only crash");
    } catch (error) {
      await mutation!.fail(error);
    }

    const recovered = await recoverMutationRuntime("journal-only-recovery");
    expect(recovered.status).toBe("succeeded");
    expect(recovered.revisionMode).toBe("off");
    expect(recovered.runtimeJournals[0]?.status).toBe("resolved");
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(expectedHead);
    expect(await pathExists(graphLockPath)).toBe(true);
    expect((await git(repo, ["status", "--short"]))).toContain("?? .agentwheel/locks/");
  });

  it("recovers receipt-linked runtime-only stale ownership removal without requiring a Git delta", async () => {
    const { repo, globalRoot } = await governedRepo();
    const beforeHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const runtimeRoot = await tempRoot("agentwheel-retire-runtime-");
    const fromRoot = await tempRoot("agentwheel-retire-source-owner-");
    const fleetRoot = await tempRoot("agentwheel-retire-fleet-owner-");
    const sourceStateKey = "codex.user.legacy";
    const destinationStateKey = "codex.user.fleet-delivery.fixture";
    const runtimePath = join(runtimeRoot, "managed.json");
    await writeFile(runtimePath, "managed\n", "utf8");
    const artifactHash = await hashPath(runtimePath);
    const manifestEntry = (workspaceOwner: string) => ({
      path: "managed.json",
      artifactType: "settings" as const,
      artifactName: "managed.json",
      installName: "managed.json",
      logicalSelector: "settings/managed.json",
      kind: "file" as const,
      hash: artifactHash,
      sourceHash: artifactHash,
      updatedAt: "2026-08-31T00:00:00.000Z",
      channel: "managed" as const,
      dependencyRole: "root" as const,
      owners: ["managed.json"],
      refCount: 1,
      workspaceOwner,
    });
    const manifest = (stateKey: string, entry: ReturnType<typeof manifestEntry>) => ({
      version: 2 as const,
      adapter: "codex",
      installationType: "user",
      stateKey,
      targetRoot: runtimeRoot,
      generatedAt: "2026-08-31T00:00:00.000Z",
      revision: "pending-retire-fixture",
      legacy: false as const,
      entries: [entry],
    });
    await writeInstallManifest(manifest(sourceStateKey, manifestEntry(workspaceOwnerForRoot(fromRoot))));
    await writeInstallManifest(manifest(destinationStateKey, manifestEntry(workspaceOwnerForRoot(fleetRoot, "delivery"))));
    const request = {
      targetRoot: runtimeRoot,
      adapter: "codex",
      installationType: "user",
      sourceStateKey,
      destinationStateKey,
      fromWorkspaceRoot: fromRoot,
      toWorkspaceRoot: fleetRoot,
      toFleetId: "delivery",
    };
    const plan = await planRetireStaleOwnership(request);
    const sourceManifestPath = installManifestPath(runtimeRoot, "codex", { installationType: "user", stateKey: sourceStateKey });
    const destinationManifestPath = installManifestPath(runtimeRoot, "codex", { installationType: "user", stateKey: destinationStateKey });
    const destinationBefore = await readFile(destinationManifestPath);
    let injected = false;
    const crashingTransport: TargetTransport = {
      ...localTransport,
      rm: async (path) => {
        await localTransport.rm(path);
        if (!injected && path === sourceManifestPath) {
          injected = true;
          throw new Error("injected receipt-linked manifest removal crash");
        }
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel ownership retire-stale",
      operationId: "retire-stale-runtime-only",
      reason: "Recover exact stale manifest ownership without a repository delta",
      requireCleanWorkingTree: true,
    });
    try {
      await applyRetireStaleOwnership({
        ...request,
        planDigest: plan.planDigest,
        expectedSourceRevision: plan.source.revision,
        expectedDestinationRevision: plan.destination.revision,
        expectedInventoryRevision: plan.manifestInventoryRevision,
        transport: crashingTransport,
      });
      throw new Error("expected retirement crash");
    } catch (error) {
      await mutation!.fail(error);
    }
    const partial = await readMutationReceipt("retire-stale-runtime-only");
    expect(partial.status).toBe("partial");
    expect(partial.runtimeJournals).toEqual([expect.objectContaining({
      path: applyJournalPath(runtimeRoot, "codex", { installationType: "user", stateKey: sourceStateKey }),
      status: "pending",
      journalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    const recovered = await recoverMutationRuntime("retire-stale-runtime-only");
    expect(recovered.status).toBe("no-repository-delta");
    expect(recovered.runtimeJournals[0]?.status).toBe("resolved");
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(beforeHead);
    await expect(stat(sourceManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(destinationManifestPath)).toEqual(destinationBefore);
    expect(await readFile(runtimePath, "utf8")).toBe("managed\n");
  });

  it("uses receipt revision/digest CAS and rereads recovery state after acquiring the mutation lock", async () => {
    const workspaceRoot = await tempRoot("agentwheel-receipt-cas-");
    const stateRoot = join(await tempRoot("agentwheel-receipt-state-"), "mutations");
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = stateRoot;
    const journalPath = join(workspaceRoot, ".agentwheel", "synthetic.apply-journal.json");
    const created = await createMutationReceipt({
      operationId: "receipt-cas-1",
      commandName: "agentwheel install",
      reason: "Prove receipt compare-and-swap recovery barriers",
      noCommit: false,
      workspaceRoot,
      repositoryRoot: null,
      expectedHead: null,
      expectedManifestDigest: null,
      revisionMode: "off",
      provider: null,
      preexistingPaths: [],
      paths: [],
      runtimeJournals: [{
        path: journalPath,
        status: "reserved",
        transport: "local",
        transportDescription: "local filesystem",
        journalDigest: "a".repeat(64),
      }],
      status: "partial",
    });
    expect(created.revision).toBe(1);
    expect(created.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    const stale = created;
    const second = await updateMutationReceipt(created, { error: "first durable transition" });
    expect(second.revision).toBe(2);
    await expect(updateMutationReceipt(stale, { error: "stale writer" }))
      .rejects.toThrow(/changed concurrently.*expected revision 1/i);

    await expect(recoverMutationRuntime("receipt-cas-1", {
      afterLockAcquired: async () => {
        const underLock = await readMutationReceipt("receipt-cas-1");
        await updateMutationReceipt(underLock, {
          runtimeJournals: underLock.runtimeJournals.map((entry) => ({ ...entry, status: "resolved" as const })),
        });
      },
    })).rejects.toThrow(/no pending linked runtime apply journals/i);
    const afterBarrier = await readMutationReceipt("receipt-cas-1");
    expect(afterBarrier.revision).toBe(3);
    expect(afterBarrier.runtimeJournals[0]?.status).toBe("resolved");

    const receiptPath = join(stateRoot, "receipts", "receipt-cas-1.json");
    const tampered = JSON.parse(await readFile(receiptPath, "utf8"));
    tampered.error = "unaudited tamper";
    await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await expect(readMutationReceipt("receipt-cas-1")).rejects.toThrow(/receipt digest mismatch/i);
  });

  it("recovers both initial journal-link crash windows without adopting unjournaled handler work", async () => {
    for (const crashAfterWrite of [false, true]) {
      const { repo, globalRoot } = await governedRepo();
      const fixture = await runtimePlanFixture(`link-window-${crashAfterWrite ? "after" : "before"}`);
      const graphLockPath = join(repo, ".agentwheel", "locks", `${fixture.adapter.name}.graph-lock.json`);
      let injected = false;
      const crashingTransport: TargetTransport = {
        ...localTransport,
        async writeJsonAtomic(path, data) {
          if (!injected && path.endsWith(".apply-journal.json")) {
            injected = true;
            if (crashAfterWrite) await localTransport.writeJsonAtomic(path, data);
            throw new Error(`injected ${crashAfterWrite ? "after" : "before"} journal publication`);
          }
          await localTransport.writeJsonAtomic(path, data);
        },
      };
      const operationId = `journal-link-${crashAfterWrite ? "after" : "before"}`;
      const mutation = await GovernedMutation.begin({
        workspaceRoot: repo,
        globalRoot,
        commandName: "agentwheel install",
        operationId,
        reason: "Exercise the two-phase runtime journal link",
        anticipatedPaths: [graphLockPath],
      });
      try {
        await applyCombinedInstallPlan(fixture.plan, {
          transport: crashingTransport,
          graphLockDigest: "link-window-digest",
          graphLock: { path: graphLockPath, lock: emptyGraphLock(fixture.adapter.name) },
        });
        throw new Error("expected injected journal publication crash");
      } catch (error) {
        await mutation!.fail(error);
      }
      const interrupted = await readMutationReceipt(operationId);
      expect(interrupted.runtimeJournals[0]).toMatchObject({ status: "reserved", transport: "local" });
      expect(await pathExists(interrupted.runtimeJournals[0]!.path)).toBe(crashAfterWrite);

      if (crashAfterWrite) {
        const recovered = await recoverMutationRuntime(operationId);
        expect(recovered.status).toBe("succeeded");
        expect(recovered.runtimeJournals[0]?.status).toBe("resolved");
      } else {
        await expect(recoverMutationRuntime(operationId)).rejects.toThrow(/never created.*rerun/i);
        expect((await readMutationReceipt(operationId)).runtimeJournals[0]?.status).toBe("resolved");
        expect(await pathExists(join(fixture.runtimeRoot, ".runtime", "rules", "rule.md"))).toBe(false);
      }
    }
  });

  it("finishes a verified runtime transaction after a crash between journal removal and receipt resolution", async () => {
    const { repo, globalRoot } = await governedRepo();
    const fixture = await runtimePlanFixture("journal-remove-window");
    const graphLockPath = join(repo, ".agentwheel", "locks", "journal-remove.graph-lock.json");
    let injected = false;
    const crashingTransport: TargetTransport = {
      ...localTransport,
      async rm(path) {
        if (!injected && path.endsWith(".apply-journal.json")) {
          injected = true;
          await localTransport.rm(path);
          throw new Error("injected after runtime journal removal");
        }
        await localTransport.rm(path);
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel install",
      operationId: "journal-remove-window",
      reason: "Recover the journal removal receipt window",
      anticipatedPaths: [graphLockPath],
    });
    try {
      await applyCombinedInstallPlan(fixture.plan, {
        transport: crashingTransport,
        graphLockDigest: "journal-remove-digest",
        graphLock: { path: graphLockPath, lock: emptyGraphLock("journal-remove") },
      });
      throw new Error("expected injected journal removal crash");
    } catch (error) {
      await mutation!.fail(error);
    }
    const interrupted = await readMutationReceipt("journal-remove-window");
    expect(interrupted.runtimeJournals[0]?.status).toBe("resolving");
    expect(await pathExists(interrupted.runtimeJournals[0]!.path)).toBe(false);

    const recovered = await recoverMutationRuntime("journal-remove-window");
    expect(recovered.status).toBe("succeeded");
    expect(recovered.runtimeJournals[0]?.status).toBe("resolved");
    expect((await git(repo, ["status", "--short"])).trim()).toBe("");
  });

  it("refuses governed remote runtime apply before acquiring or writing a remote lock", async () => {
    const { repo, globalRoot } = await governedRepo();
    const fixture = await runtimePlanFixture("remote-refusal");
    let remoteMutations = 0;
    const remoteTransport: TargetTransport = {
      ...localTransport,
      kind: "ssh",
      description: "ssh://synthetic.invalid",
      async mkdirExclusive(path) {
        remoteMutations += 1;
        await localTransport.mkdirExclusive(path);
      },
      async writeJsonAtomic(path, value) {
        remoteMutations += 1;
        await localTransport.writeJsonAtomic(path, value);
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel install",
      operationId: "remote-refusal-1",
      reason: "Refuse runtime mutation without durable remote recovery",
      requireCleanWorkingTree: true,
    });
    await expect(applyCombinedInstallPlan(fixture.plan, { transport: remoteTransport }))
      .rejects.toThrow(/durable remote journal recovery is not implemented/i);
    expect(remoteMutations).toBe(0);
    await mutation!.fail(new Error("expected remote refusal"));

    const journalOnly = await governedRepo();
    const journalOnlyConfigPath = workspaceConfigPath(journalOnly.repo);
    const journalOnlyConfig = JSON.parse(await readFile(journalOnlyConfigPath, "utf8"));
    journalOnlyConfig.mutationPolicy = {
      reason: "required",
      journal: "required",
      revisioning: { mode: "off" },
    };
    await writeFile(journalOnlyConfigPath, `${JSON.stringify(journalOnlyConfig, null, 2)}\n`, "utf8");
    await git(journalOnly.repo, ["add", ".agentwheel/config.json"]);
    await git(journalOnly.repo, ["commit", "-m", "journal-only policy"]);
    const journalOnlyMutation = await GovernedMutation.begin({
      workspaceRoot: journalOnly.repo,
      globalRoot: journalOnly.globalRoot,
      commandName: "agentwheel install",
      operationId: "remote-refusal-journal-only",
      reason: "Refuse remote runtime mutation even without Git revisioning",
    });
    await expect(applyCombinedInstallPlan(fixture.plan, { transport: remoteTransport }))
      .rejects.toThrow(/durable remote journal recovery is not implemented/i);
    expect(remoteMutations).toBe(0);
    await journalOnlyMutation!.fail(new Error("expected journal-only remote refusal"));
  });

  it("recovers after a declarative write without rerunning a clean-only provider check", async () => {
    const { repo, globalRoot } = await governedRepo();
    const providerRoot = await tempRoot("agentwheel-strict-provider-");
    const providerScript = join(providerRoot, "provider.mjs");
    const providerLog = join(providerRoot, "actions.log");
    await writeFile(providerScript, `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.argv[2], request.action + "\\n");
const base = {protocolVersion: 1, providerId: "strict-command", action: request.action, operationId: request.operationId};
if (request.action === "check") {
  const dirty = execFileSync("git", ["-C", request.repositoryRoot, "status", "--porcelain"], {encoding: "utf8"}).trim();
  if (dirty) {
    process.stdout.write(JSON.stringify({...base, ok: false, status: "dirty", error: "check requires a clean worktree"}));
    process.exitCode = 2;
  } else process.stdout.write(JSON.stringify({...base, ok: true, status: "ready"}));
} else if (request.action === "preflight" || request.action === "release") {
  process.stdout.write(JSON.stringify({...base, ok: true, status: request.action === "preflight" ? "prepared" : "released"}));
} else {
  if (request.paths.length > 0) {
    execFileSync("git", ["-C", request.repositoryRoot, "add", "--", ...request.paths.map((entry) => entry.path)]);
    execFileSync("git", ["-C", request.repositoryRoot, "commit", "-m", "strict recovery provider"]);
  }
  const head = execFileSync("git", ["-C", request.repositoryRoot, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  process.stdout.write(JSON.stringify({...base, ok: true, status: "verified", expectedHead: request.expectedHead, resultingHead: head, productCommitSha: request.paths.length > 0 ? head : null, draftStackId: null, draftBranch: null, draftTipSha: null, controlCommitSha: null, manifestDigest: request.expectedManifestDigest ?? null, unmappedIntegrationCommits: [], published: false}));
}
`, "utf8");
    const configPath = workspaceConfigPath(repo);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mutationPolicy.revisioning.provider = {
      kind: "command",
      id: "strict-command",
      command: [process.execPath, providerScript, providerLog],
      executableSha256: nodeExecutableSha256,
      trustBoundary: "entrypoint",
      protocolVersion: 1,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await git(repo, ["add", ".agentwheel/config.json"]);
    await git(repo, ["commit", "-m", "configure strict provider"]);

    const sourceRoot = await tempRoot("agentwheel-late-crash-source-");
    const runtimeRoot = await tempRoot("agentwheel-late-crash-runtime-");
    const sourcePath = join(sourceRoot, "late.md");
    await writeFile(sourcePath, "late crash rule\n", "utf8");
    const adapter: AdapterConfig = {
      name: "late-crash",
      targets: { rules: { local: { enabled: true, dest: ".runtime/rules" } } },
    };
    const artifact: DesiredArtifact = {
      type: "rules",
      name: "late.md",
      sourcePath,
      stagedPath: sourcePath,
      relativePath: "rules/late.md",
      kind: "file",
      hash: await hashPath(sourcePath),
      channel: "managed",
      meta: { logicalSelector: "rules/late.md", dependencyRole: "root", owners: ["late-crash"] },
    };
    const plan = await createCombinedInstallPlan([artifact], adapter, runtimeRoot);
    const graphLockPath = join(repo, ".agentwheel", "locks", "late-crash.graph-lock.json");
    let injected = false;
    const crashingTransport: TargetTransport = {
      ...localTransport,
      async readFile(path) {
        if (!injected && path.endsWith(".install-manifest.json") && await pathExists(graphLockPath)) {
          injected = true;
          throw new Error("injected crash after declarative write");
        }
        return localTransport.readFile(path);
      },
    };
    const mutation = await GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel install",
      operationId: "late-runtime-crash-1",
      reason: "Recover after verified declarative state was written",
      anticipatedPaths: [graphLockPath],
    });
    try {
      await applyCombinedInstallPlan(plan, {
        transport: crashingTransport,
        graphLockDigest: "late-crash-lock-digest",
        graphLock: { path: graphLockPath, lock: emptyGraphLock("late-crash") },
      });
      throw new Error("expected injected crash");
    } catch (error) {
      await mutation!.fail(error);
    }
    expect(await pathExists(graphLockPath)).toBe(true);
    expect((await readMutationReceipt("late-runtime-crash-1")).runtimeJournals[0]?.status).toBe("pending");

    const recovered = await recoverMutationRuntime("late-runtime-crash-1");
    expect(recovered.status).toBe("succeeded");
    expect((await readFile(providerLog, "utf8")).trim().split("\n")).toEqual([
      "check",
      "release",
      "preflight",
      "recover",
    ]);
    expect((await git(repo, ["status", "--short"])).trim()).toBe("");
  });

  it("refuses tracked Syncwheel control state and multi-repository revisioning before handlers", async () => {
    const first = await governedRepo({ trackedSyncwheel: true });
    await expect(GovernedMutation.begin({
      workspaceRoot: first.repo,
      globalRoot: first.globalRoot,
      commandName: "agentwheel add",
      reason: "Reject builtin Git in a Syncwheel repository",
      anticipatedPaths: [workspaceConfigPath(first.repo)],
    })).rejects.toThrow(/tracked \.syncwheel\/manifest/i);

    const left = await governedRepo();
    const right = await plainRepo();
    await expect(GovernedMutation.begin({
      workspaceRoot: left.repo,
      globalRoot: left.globalRoot,
      commandName: "agentwheel fleet normalize",
      reason: "Reject non-atomic multi-repository mutation",
      anticipatedPaths: [workspaceConfigPath(left.repo)],
      additionalWorkspaceRoots: [right],
    })).rejects.toThrow(/multiple repositories/i);

    await expect(GovernedMutation.begin({
      workspaceRoot: left.repo,
      globalRoot: left.globalRoot,
      commandName: "agentwheel ownership handoff",
      reason: "Refuse runtime-only ownership without declarative state",
      requiresDeclarativeRepositoryDelta: true,
    })).rejects.toThrow(/runtime-only ownership transition.*before writes/i);
  });

  it("treats an owner-missing mutation lock as busy instead of reaping a live mkdir race", async () => {
    const { repo, stateRoot } = await governedRepo();
    const digest = createHash("sha256").update(repo).digest("hex");
    const lockPath = join(stateRoot, "locks", `${digest}.lock`);
    await mkdir(lockPath, { recursive: true });

    await expect(acquireMutationLock(repo, "lock-race-contender"))
      .rejects.toThrow(/another Agentwheel mutation owns.*Owner unknown.*Inspect the Agent Mesh session graph.*do not remove the safety block/i);
    await expect(stat(lockPath)).resolves.toBeTruthy();
    await expect(stat(join(lockPath, "owner.json"))).rejects.toThrow();
    expect(mutationStateRoot()).toBe(stateRoot);
  });

  it("merges global policy without allowing scoped weakening", () => {
    const global = mutationPolicy({ required: true, allowNoCommit: false });
    const scopedOff = {
      reason: "optional" as const,
      journal: "off" as const,
      revisioning: { mode: "off" as const },
    };
    const inherited = mergeMutationPolicies(global, scopedOff)!;
    expect(inherited.reason).toBe("required");
    expect(inherited.journal).toBe("required");
    expect(inherited.revisioning.mode).toBe("commit-after-verify");
    if (inherited.revisioning.mode !== "commit-after-verify") throw new Error("expected commit policy");
    expect(inherited.revisioning.allowNoCommitOverride).toBe(false);

    const scoped = mutationPolicy({ providerId: "scoped", allowNoCommit: true });
    const merged = mergeMutationPolicies(global, scoped)!;
    if (merged.revisioning.mode !== "commit-after-verify") throw new Error("expected commit policy");
    expect(merged.revisioning.provider.id).toBe("scoped");
    expect(merged.revisioning.allowNoCommitOverride).toBe(false);
  });

  it("applies a global-only policy and requires Git identity during precheck", async () => {
    const globalOnly = await governedRepo();
    const localConfig = JSON.parse(await readFile(workspaceConfigPath(globalOnly.repo), "utf8"));
    delete localConfig.mutationPolicy;
    await writeFile(workspaceConfigPath(globalOnly.repo), `${JSON.stringify(localConfig, null, 2)}\n`, "utf8");
    await git(globalOnly.repo, ["add", ".agentwheel/config.json"]);
    await git(globalOnly.repo, ["commit", "-m", "use global mutation policy"]);
    await mkdir(join(globalOnly.globalRoot, ".agentwheel"), { recursive: true });
    await writeFile(workspaceConfigPath(globalOnly.globalRoot), `${JSON.stringify({
      schemaVersion: 4,
      mutationPolicy: mutationPolicy(),
    }, null, 2)}\n`, "utf8");
    await expect(GovernedMutation.begin({
      workspaceRoot: globalOnly.repo,
      globalRoot: globalOnly.globalRoot,
      commandName: "agentwheel add",
      anticipatedPaths: [workspaceConfigPath(globalOnly.repo)],
    })).rejects.toThrow(/reason required/i);
    const inherited = await GovernedMutation.begin({
      workspaceRoot: globalOnly.repo,
      globalRoot: globalOnly.globalRoot,
      commandName: "agentwheel add",
      reason: "Exercise the inherited global mutation policy",
      anticipatedPaths: [workspaceConfigPath(globalOnly.repo)],
    });
    await inherited!.complete();

    const noIdentityRepo = await plainRepo({ configureIdentity: false });
    const noIdentityGlobal = await tempRoot("agentwheel-no-identity-global-");
    const noIdentityState = join(await tempRoot("agentwheel-no-identity-state-"), "mutations");
    process.env.AGENTWHEEL_MUTATION_STATE_ROOT = noIdentityState;
    await mkdir(join(noIdentityRepo, ".agentwheel"), { recursive: true });
    await writeFile(workspaceConfigPath(noIdentityRepo), `${JSON.stringify({
      schemaVersion: 4,
      mutationPolicy: mutationPolicy(),
    }, null, 2)}\n`, "utf8");
    await git(noIdentityRepo, ["add", ".agentwheel/config.json"]);
    await git(noIdentityRepo, ["-c", "user.name=Bootstrap", "-c", "user.email=bootstrap@example.test", "commit", "-m", "policy"]);
    await git(noIdentityRepo, ["config", "user.name", ""]);
    await git(noIdentityRepo, ["config", "user.email", ""]);
    await expect(GovernedMutation.begin({
      workspaceRoot: noIdentityRepo,
      globalRoot: noIdentityGlobal,
      commandName: "agentwheel add",
      reason: "Require configured author and committer identities",
      anticipatedPaths: [workspaceConfigPath(noIdentityRepo)],
    })).rejects.toThrow(/identity/i);
  });

  it("keeps the governed-command classifier explicit and excludes incidental registry refresh", () => {
    for (const [path, mode] of Object.entries(commandGovernance)) {
      expect(commandGovernanceMode(path)).toBe(mode);
      if (mode === "governed-always") expect(isGovernedCommand(path)).toBe(true);
      else if (mode === "governed-unless-dry-run") {
        expect(isGovernedCommand(path, { dryRun: false })).toBe(true);
        expect(isGovernedCommand(path, { dryRun: true })).toBe(false);
      } else if (mode === "governed-apply") {
        expect(isGovernedCommand(path, { apply: true })).toBe(true);
        expect(isGovernedCommand(path)).toBe(false);
      } else if (mode === "governed-apply-or-recover") {
        expect(isGovernedCommand(path, { apply: true })).toBe(true);
        expect(isGovernedCommand(path, { recover: true })).toBe(true);
        expect(isGovernedCommand(path)).toBe(false);
      } else expect(isGovernedCommand(path)).toBe(false);
    }
    expect(commandGovernance["deps tree"]).toBe("incidental-cache");
    expect(commandGovernance["registry update"]).toBe("incidental-cache");
    expect(commandGovernance["mutation recover"]).toBe("receipt-recovery");
    expect(() => isGovernedCommand("unclassified mutation")).toThrow(/no mutation-governance classification/i);
  });

  it("rejects a meaningless noCommit override when no effective policy exists", async () => {
    const repo = await plainRepo();
    const globalRoot = await tempRoot("agentwheel-empty-global-");
    await expect(GovernedMutation.begin({
      workspaceRoot: repo,
      globalRoot,
      commandName: "agentwheel add",
      reason: "No policy exists",
      noCommit: true,
    })).rejects.toThrow(/requires.*commit-after-verify/i);
  });
});

function mutationPolicy(options: { required?: boolean; allowNoCommit?: boolean; providerId?: string } = {}) {
  return {
    reason: options.required === false ? "optional" as const : "required" as const,
    journal: "required" as const,
    revisioning: {
      mode: "commit-after-verify" as const,
      allowNoCommitOverride: options.allowNoCommit ?? true,
      reasonInCommit: "full" as const,
      provider: { kind: "git" as const, id: options.providerId ?? "git", protocolVersion: 1 as const },
    },
  };
}

function checkRequest(root: string): RevisionProviderRequest {
  return revisionProviderRequestSchema.parse({
    protocolVersion: 1,
    action: "check",
    operationId: "provider-check-1",
    repositoryRoot: root,
    expectedHead: "1".repeat(40),
    commandName: "mutation check",
    reason: "Check provider conformance",
    noCommit: false,
    paths: [],
  });
}

async function governedRepo(options: { trackedSyncwheel?: boolean } = {}) {
  const repo = await plainRepo({ configureIdentity: true });
  const globalRoot = await tempRoot("agentwheel-global-");
  const stateRoot = join(await tempRoot("agentwheel-state-parent-"), "mutations");
  process.env.AGENTWHEEL_MUTATION_STATE_ROOT = stateRoot;
  await mkdir(join(repo, ".agentwheel"), { recursive: true });
  await writeFile(workspaceConfigPath(repo), `${JSON.stringify({ schemaVersion: 4, mutationPolicy: mutationPolicy() }, null, 2)}\n`);
  await writeFile(join(repo, "notes.txt"), "clean\n", "utf8");
  if (options.trackedSyncwheel) {
    await mkdir(join(repo, ".syncwheel"), { recursive: true });
    await writeFile(join(repo, ".syncwheel", "manifest.json"), "{}\n", "utf8");
  }
  await git(repo, ["add", "-f", ".agentwheel/config.json", "notes.txt", ...(options.trackedSyncwheel ? [".syncwheel/manifest.json"] : [])]);
  await git(repo, ["commit", "-m", "initial"]);
  return { repo, globalRoot, stateRoot };
}

async function plainRepo(options: { configureIdentity?: boolean } = {}): Promise<string> {
  const repo = await tempRoot("agentwheel-git-");
  await git(repo, ["init", "-b", "main"]);
  if (options.configureIdentity !== false) {
    await git(repo, ["config", "user.name", "Agentwheel Test"]);
    await git(repo, ["config", "user.email", "agentwheel@example.test"]);
  }
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  if (options.configureIdentity === false) {
    await git(repo, ["-c", "user.name=Bootstrap", "-c", "user.email=bootstrap@example.test", "commit", "-m", "initial"]);
  } else {
    await git(repo, ["commit", "-m", "initial"]);
  }
  return repo;
}

async function changeWorkspaceConfig(repo: string): Promise<void> {
  const raw = JSON.parse(await readFile(workspaceConfigPath(repo), "utf8"));
  await writeWorkspaceConfig(repo, { ...raw, bootstrapSkills: raw.bootstrapSkills !== false ? false : true });
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

async function snapshotSyncwheelSource(sourceRoot: string): Promise<string> {
  const snapshot = await tempRoot("agentwheel-syncwheel-source-");
  const scripts = join(snapshot, "scripts");
  await mkdir(scripts, { recursive: true });
  await Promise.all([
    writeFile(join(scripts, "syncwheel.py"), await readFile(join(sourceRoot, "scripts", "syncwheel.py")), { mode: 0o700 }),
    writeFile(
      join(scripts, "syncwheel_revision_provider.py"),
      await readFile(join(sourceRoot, "scripts", "syncwheel_revision_provider.py")),
      { mode: 0o600 },
    ),
    writeFile(join(snapshot, "VERSION"), await readFile(join(sourceRoot, "VERSION")), { mode: 0o600 }),
  ]);
  return snapshot;
}

async function syncwheelProviderRepo(syncwheelSource: string, root: string): Promise<string> {
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", "--bare", "-q", origin]);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Agentwheel Syncwheel Test"]);
  await git(repo, ["config", "user.email", "agentwheel-syncwheel@example.test"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await writeFile(join(repo, "base.txt"), "base\n", "utf8");
  await writeFile(
    join(repo, ".gitignore"),
    ".syncwheel/profile.local.json\n.syncwheel/ledger/\nvar/syncwheel/\n",
    "utf8",
  );
  await mkdir(join(repo, ".syncwheel"), { recursive: true });
  await writeFile(join(repo, ".syncwheel", "manifest.json"), `${JSON.stringify({
    version: 2,
    repository_mode: "delivery",
    syncwheel_tracking: "git-tracked",
    syncwheel_worktree_root: "var/syncwheel",
    defaults: {
      canonical_remote: "origin",
      publication_remote: "origin",
      base_branch: "main",
      base_ref: "origin/main",
      integration_membership: "required",
    },
    integration: {
      branch: "main-integration",
      base: "origin/main",
      strategy: "cherry-pick",
      stacks: [],
    },
    stacks: [],
    coordination: {
      mode: "disabled",
      id: "agentwheel-black-box",
      remote: "origin",
      state_branch: "syncwheel/state/agentwheel-black-box",
      gc: { worktree_grace_days: 7, backup_retention_days: 30, backup_keep: 2 },
    },
    channels: [],
  }, null, 2)}\n`, "utf8");
  await execFileAsync("python3", [
    join(syncwheelSource, "scripts", "syncwheel.py"),
    "hooks",
    "remove",
    "--disable",
    "--reason",
    "isolated Agentwheel black-box fixture",
    "--apply",
  ], {
    cwd: repo,
    env: { ...process.env, SYNCWHEEL_UPDATE_MODE: "off" },
    maxBuffer: 10 * 1024 * 1024,
  });
  await git(repo, ["add", ".gitignore", "base.txt", ".syncwheel/manifest.json"]);
  await git(repo, ["commit", "-q", "-m", "test: initialize Syncwheel provider fixture"]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  await git(repo, ["switch", "-q", "-c", "main-integration", "main"]);
  return repo;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function runtimePlanFixture(label: string) {
  const sourceRoot = await tempRoot(`agentwheel-${label}-source-`);
  const runtimeRoot = await tempRoot(`agentwheel-${label}-runtime-`);
  const sourcePath = join(sourceRoot, "rule.md");
  await writeFile(sourcePath, `${label}\n`, "utf8");
  const adapter: AdapterConfig = {
    name: label,
    targets: { rules: { local: { enabled: true, dest: ".runtime/rules" } } },
  };
  const artifact: DesiredArtifact = {
    type: "rules",
    name: "rule.md",
    sourcePath,
    stagedPath: sourcePath,
    relativePath: "rules/rule.md",
    kind: "file",
    hash: await hashPath(sourcePath),
    channel: "managed",
    meta: { logicalSelector: "rules/rule.md", dependencyRole: "root", owners: [label] },
  };
  return {
    adapter,
    runtimeRoot,
    plan: await createCombinedInstallPlan([artifact], adapter, runtimeRoot),
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyGraphLock(targetFingerprint: string): GraphLock {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    canonical: {
      targetFingerprint,
      roots: [],
      nodes: [],
      edges: [],
      includeEdges: [],
      artifacts: [],
      namespacing: [],
      overrides: [],
      plainNameIncumbents: [],
    },
  };
}
