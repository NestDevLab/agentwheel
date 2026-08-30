import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { revisionProviderConfigSchema, type RevisionProviderConfigInput } from "../model/mutation.js";
import {
  revisionProviderRequestSchema,
  revisionProviderErrorResponseSchema,
  revisionProviderResponseSchema,
  revisionRequestDigest,
  type RevisionProviderErrorResponse,
  type RevisionProviderRequest,
  type RevisionProviderResponse,
} from "./protocol.js";
import { assertGitPreflight, currentHead, discoverGitRepository, snapshotRepository, verifyRevisionPaths, type RepositorySnapshot } from "./repository.js";
import { runProcess } from "./process.js";

export interface InvokeProviderOptions {
  workspaceRoot: string;
  /** Test seam used to prove immutable-snapshot execution after configured-path mutation. */
  afterCommandExecutablePinned?: (executable: string) => void | Promise<void>;
}

export class RevisionProviderRejectedError extends Error {
  constructor(public readonly response: RevisionProviderErrorResponse) {
    super(`Revision provider '${response.providerId}' rejected ${response.action}: ${response.error}`);
    this.name = "RevisionProviderRejectedError";
  }
}

export function revisionProviderRejection(error: unknown): RevisionProviderErrorResponse | undefined {
  return error instanceof RevisionProviderRejectedError ? error.response : undefined;
}

export async function invokeRevisionProvider(
  configInput: RevisionProviderConfigInput,
  input: RevisionProviderRequest,
  options: InvokeProviderOptions,
): Promise<RevisionProviderResponse> {
  const config = revisionProviderConfigSchema.parse(configInput);
  const request = revisionProviderRequestSchema.parse(input);
  const raw = config.kind === "git"
    ? await invokeGitProvider(config.id, request)
    : await invokeCommandProvider(
        config.command,
        config.executableSha256,
        config.timeoutMs,
        request,
        options.afterCommandExecutablePinned,
      );
  const failure = revisionProviderErrorResponseSchema.safeParse(raw);
  if (failure.success) {
    assertProviderCorrelation(config.id, request, failure.data);
    throw new RevisionProviderRejectedError(failure.data);
  }
  const response = revisionProviderResponseSchema.parse(raw);
  assertProviderCorrelation(config.id, request, response);
  assertProviderStatus(response);
  await assertProviderSemantics(request, response);
  return response;
}

function assertProviderCorrelation(
  providerId: string,
  request: RevisionProviderRequest,
  response: RevisionProviderResponse | RevisionProviderErrorResponse,
): void {
  if (response.providerId !== providerId) {
    throw new Error(`Revision provider id mismatch: expected ${providerId}, found ${response.providerId}.`);
  }
  if (response.action !== request.action) {
    throw new Error(`Revision provider action mismatch: expected ${request.action}, found ${response.action}.`);
  }
  if (response.operationId !== request.operationId) {
    throw new Error(`Revision provider operation mismatch: expected ${request.operationId}, found ${response.operationId}.`);
  }
}

function assertProviderStatus(response: RevisionProviderResponse): void {
  const allowed: Record<RevisionProviderResponse["action"], readonly string[]> = {
    check: ["ready"],
    preflight: ["prepared", "product_committed", "stack_owned", "control_committed", "verified"],
    release: ["released"],
    finalize: ["verified", "already-verified", "revisioning-skipped", "no-repository-delta"],
    recover: ["verified", "already-verified", "revisioning-skipped", "no-repository-delta"],
  };
  if (!allowed[response.action].includes(response.status)) {
    throw new Error(`Revision provider returned invalid ${response.action} status '${response.status}'.`);
  }
}

async function invokeCommandProvider(
  command: string[],
  executableSha256: string,
  timeoutMs: number,
  request: RevisionProviderRequest,
  afterExecutablePinned?: (executable: string) => void | Promise<void>,
): Promise<unknown> {
  const [executable, ...args] = command;
  const descriptorPath = immutableDescriptorExecutablePath();
  const executableBytes = await readVerifiedExecutable(executable, executableSha256);
  const executableHandle = await openImmutableExecutableSnapshot(executableBytes);
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    await afterExecutablePinned?.(executable);
    result = await runProcess(descriptorPath, args, {
      cwd: request.repositoryRoot,
      input: `${JSON.stringify(request)}\n`,
      allowExitCodes: [0, 2],
      maxOutputBytes: 65_536,
      includeFailureOutput: false,
      timeoutMs,
      inheritedFileDescriptor: executableHandle.fd,
      killProcessGroup: true,
    });
  } finally {
    await executableHandle.close();
  }
  const output = result.stdout.toString("utf8").trim();
  if (!output) throw new Error(`Revision provider command '${executable}' returned no JSON response.`);
  let parsed: { ok?: unknown };
  try {
    parsed = JSON.parse(output) as { ok?: unknown };
  } catch {
    throw new Error(`Revision provider command '${executable}' returned invalid JSON.`);
  }
  if (result.exitCode === 2 && parsed.ok !== false) {
    throw new Error(`Revision provider command '${executable}' exited 2 without a protocol rejection.`);
  }
  if (result.exitCode === 0 && parsed.ok === false) {
    throw new Error(`Revision provider command '${executable}' returned a rejection with exit 0.`);
  }
  return parsed;
}

async function readVerifiedExecutable(executable: string, expectedSha256: string): Promise<Buffer> {
  const handle = await open(executable, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Revision provider executable must be a regular file: ${executable}.`);
    const bytes = await handle.readFile();
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Revision provider executable hash mismatch for ${executable}: expected ${expectedSha256}, found ${actualSha256}.`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function openImmutableExecutableSnapshot(bytes: Buffer): Promise<Awaited<ReturnType<typeof open>>> {
  if (process.platform !== "linux") {
    throw new Error(
      `Command revision providers require an unlinked immutable executable snapshot, which is unsupported on ${process.platform}.`,
    );
  }
  const root = await mkdtemp(join(tmpdir(), "agentwheel-revision-command-"));
  const path = join(root, "entrypoint");
  let snapshot: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await chmod(root, 0o700);
    const writer = await open(path, "wx", 0o500);
    try {
      await writer.writeFile(bytes);
      await writer.sync();
    } finally {
      await writer.close();
    }
    snapshot = await open(path, "r");
    await rm(path);
    await rmdir(root);
    return snapshot;
  } catch (error) {
    await snapshot?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function immutableDescriptorExecutablePath(): string {
  if (process.platform === "linux") return "/proc/self/fd/3";
  throw new Error(
    `Command revision providers require an unlinked immutable executable snapshot, which is unsupported on ${process.platform}.`,
  );
}

async function assertProviderSemantics(
  request: RevisionProviderRequest,
  response: RevisionProviderResponse,
): Promise<void> {
  if (response.action !== "finalize" && response.action !== "recover") return;
  if (response.expectedHead !== request.expectedHead) {
    throw new Error(`Revision provider expectedHead mismatch: expected ${request.expectedHead}, found ${response.expectedHead}.`);
  }
  if (response.unmappedIntegrationCommits.length > 0) {
    throw new Error(`Revision provider cannot report terminal success with unmapped integration commits: ${response.unmappedIntegrationCommits.join(", ")}.`);
  }

  const ownership = [response.draftStackId, response.draftBranch, response.draftTipSha, response.controlCommitSha];
  const ownsDraft = ownership.some((value) => value !== null);
  if (ownsDraft && ownership.some((value) => value === null)) {
    throw new Error("Revision provider returned incomplete draft ownership fields.");
  }
  if (ownsDraft && response.manifestDigest === null) {
    throw new Error("Revision provider returned draft ownership without a manifest digest.");
  }

  if (request.noCommit) {
    if (response.status !== "revisioning-skipped") {
      throw new Error(`noCommit requires revisioning-skipped, found ${response.status}.`);
    }
    if (response.productCommitSha || ownsDraft || response.resultingHead !== request.expectedHead) {
      throw new Error("A noCommit response may not create product/control commits or draft ownership.");
    }
  } else if (request.paths.length === 0) {
    if (response.status !== "no-repository-delta") {
      throw new Error(`An empty path set requires no-repository-delta, found ${response.status}.`);
    }
    if (response.productCommitSha || ownsDraft || response.resultingHead !== request.expectedHead) {
      throw new Error("A no-repository-delta response may not create product/control commits or draft ownership.");
    }
  } else {
    if (!new Set(["verified", "already-verified"]).has(response.status) || !response.productCommitSha) {
      throw new Error("A non-empty committed mutation requires a verified product commit.");
    }
    await verifyOperationCommit(
      request as Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
      response.productCommitSha,
    );
    const terminalCommit = response.controlCommitSha ?? response.productCommitSha;
    if (response.resultingHead !== terminalCommit) {
      throw new Error(`Revision provider resultingHead ${response.resultingHead} does not match terminal commit ${terminalCommit}.`);
    }
    if (response.controlCommitSha) {
      const parent = (await runProcess("git", ["-C", request.repositoryRoot, "rev-parse", `${response.controlCommitSha}^`]))
        .stdout.toString("utf8").trim();
      if (parent !== response.productCommitSha) {
        throw new Error(`Revision provider control commit ${response.controlCommitSha} does not descend directly from the product commit.`);
      }
    }
    if (response.draftBranch) {
      await runProcess("git", ["-C", request.repositoryRoot, "check-ref-format", "--branch", response.draftBranch]);
      const branchHead = (await runProcess(
        "git",
        ["-C", request.repositoryRoot, "rev-parse", "--verify", `refs/heads/${response.draftBranch}`],
      )).stdout.toString("utf8").trim();
      if (branchHead !== response.draftTipSha) {
        throw new Error(
          `Revision provider draft branch ${response.draftBranch} points to ${branchHead}, not draft tip ${response.draftTipSha}.`,
        );
      }
    }
  }

  const head = await currentHead(request.repositoryRoot);
  if (head !== response.resultingHead) {
    throw new Error(`Revision provider resultingHead ${response.resultingHead} does not match repository HEAD ${head}.`);
  }
}

async function invokeGitProvider(providerId: string, request: RevisionProviderRequest): Promise<RevisionProviderResponse> {
  const repository = await discoverGitRepository(request.repositoryRoot);
  if (!repository || repository.root !== resolve(request.repositoryRoot)) {
    throw new Error(`Git revision provider requires the repository root itself: ${request.repositoryRoot}.`);
  }

  if (request.action === "check" || request.action === "preflight") {
    if (repository.head !== request.expectedHead) {
      if (request.action === "check") {
        throw new Error(`Git HEAD lease mismatch: expected ${request.expectedHead}, found ${repository.head}.`);
      }
      const planDigest = providerPlanDigest(request);
      const existing = await findOperationCommit(request.repositoryRoot, request.operationId, planDigest);
      if (!existing) throw new Error(`Git HEAD lease mismatch: expected ${request.expectedHead}, found ${repository.head}.`);
      await verifyOperationCommit(asTerminalRequest(request, "recover"), existing);
      return revisionProviderResponseSchema.parse(baseResponse(providerId, request, "prepared"));
    }
    await assertGitPreflight(repository);
    await assertGitProviderCompatible(request.repositoryRoot);
    await assertGitIdentity(request.repositoryRoot);
    return revisionProviderResponseSchema.parse(baseResponse(providerId, request, request.action === "check" ? "ready" : "prepared"));
  }
  if (request.action === "release") return revisionProviderResponseSchema.parse(baseResponse(providerId, request, "released"));
  return finalizeGit(providerId, request);
}

async function finalizeGit(
  providerId: string,
  request: Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
): Promise<RevisionProviderResponse> {
  const planDigest = providerPlanDigest(request);
  const existing = await findOperationCommit(request.repositoryRoot, request.operationId, planDigest);
  if (existing) {
    await verifyOperationCommit(request, existing);
    await realignIndexAfterRecoveredCommit(request.repositoryRoot, request.expectedHead, existing);
    return terminalResponse(providerId, request, "already-verified", existing, await currentHead(request.repositoryRoot));
  }

  const repository = await discoverGitRepository(request.repositoryRoot);
  if (!repository) throw new Error(`No Git repository at ${request.repositoryRoot}.`);
  if (repository.head !== request.expectedHead) {
    throw new Error(`Git HEAD lease mismatch: expected ${request.expectedHead}, found ${repository.head}.`);
  }
  await assertGitPreflight(repository);
  await assertGitProviderCompatible(request.repositoryRoot);
  await assertGitIdentity(request.repositoryRoot);
  await verifyRevisionPaths(request.repositoryRoot, request.expectedHead, request.paths);
  if (request.noCommit || request.paths.length === 0) {
    return terminalResponse(providerId, request, request.noCommit ? "revisioning-skipped" : "no-repository-delta", null, repository.head);
  }

  const indexLease = await captureIndexLease(request.repositoryRoot);
  await assertIndexTree(request.repositoryRoot, request.expectedHead);
  const hookBaseline = await snapshotRepository(request.repositoryRoot);
  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-git-index-"));
  const indexPath = join(tempRoot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  let commitSha: string;
  try {
    await runProcess("git", ["-C", request.repositoryRoot, "read-tree", request.expectedHead], { env });
    await runProcess("git", ["-C", request.repositoryRoot, "add", "--", ...request.paths.map((entry) => entry.path)], { env });
    const staged = splitNull((await runProcess("git", ["-C", request.repositoryRoot, "diff", "--cached", "--name-only", "-z"], { env })).stdout);
    assertExactSet(staged, request.paths.map((entry) => entry.path), "temporary Git index");
    await verifyTemporaryIndexPaths(request, env);
    await runProcess("git", ["-C", request.repositoryRoot, "diff", "--cached", "--check"], { env });
    const tree = (await runProcess("git", ["-C", request.repositoryRoot, "write-tree"], { env })).stdout.toString("utf8").trim();
    const messagePath = join(tempRoot, "COMMIT_EDITMSG");
    await writeFile(messagePath, commitMessage(request, planDigest), { encoding: "utf8", mode: 0o600 });
    await runCommitHooks(request, env, messagePath);
    assertRepositorySnapshotEqual(hookBaseline, await snapshotRepository(request.repositoryRoot), "Git commit hooks");
    const stagedAfterHooks = splitNull((await runProcess("git", ["-C", request.repositoryRoot, "diff", "--cached", "--name-only", "-z"], { env })).stdout);
    assertExactSet(stagedAfterHooks, request.paths.map((entry) => entry.path), "temporary Git index after hooks");
    await verifyTemporaryIndexPaths(request, env);
    const message = await readFile(messagePath, "utf8");
    assertCommitMessageContract(message, request, planDigest);
    commitSha = (await runProcess("git", ["-C", request.repositoryRoot, "commit-tree", tree, "-p", request.expectedHead], {
      env,
      input: message,
    })).stdout.toString("utf8").trim();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const branchRef = (await runProcess("git", ["-C", request.repositoryRoot, "symbolic-ref", "HEAD"])).stdout.toString("utf8").trim();
  await runProcess("git", [
    "-C",
    request.repositoryRoot,
    "update-ref",
    "-m",
    `agentwheel ${request.operationId}`,
    branchRef,
    commitSha,
    request.expectedHead,
  ]);
  await replaceIndexCas(request.repositoryRoot, indexLease, commitSha);
  await verifyOperationCommit(request, commitSha);
  return terminalResponse(providerId, request, "verified", commitSha, commitSha);
}

async function runCommitHooks(
  request: Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
  env: NodeJS.ProcessEnv,
  messagePath: string,
): Promise<void> {
  for (const [name, args] of [
    ["pre-commit", []],
    ["prepare-commit-msg", [messagePath, "message"]],
    ["commit-msg", [messagePath]],
  ] as const) {
    const rawPath = (await runProcess("git", ["-C", request.repositoryRoot, "rev-parse", "--git-path", `hooks/${name}`]))
      .stdout.toString("utf8").trim();
    const hookPath = isAbsolute(rawPath) ? rawPath : resolve(request.repositoryRoot, rawPath);
    let executable = false;
    try {
      executable = ((await stat(hookPath)).mode & 0o111) !== 0;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!executable) continue;
    try {
      await runProcess(hookPath, [...args], {
        cwd: request.repositoryRoot,
        env: {
          ...env,
          AGENTWHEEL_OPERATION_ID: request.operationId,
          AGENTWHEEL_COMMAND_NAME: request.commandName,
        },
        maxOutputBytes: 65_536,
        includeFailureOutput: false,
      });
    } catch {
      throw new Error(`Git ${name} hook rejected Agentwheel mutation ${request.operationId}.`);
    }
  }
}

function assertCommitMessageContract(
  message: string,
  request: RevisionProviderRequest,
  planDigest: string,
): void {
  if (!message.includes(request.reason.trim())) {
    throw new Error("Git commit hooks removed or changed the full Agentwheel mutation reason.");
  }
  for (const trailer of [
    `Agentwheel-Operation: ${request.operationId}`,
    `Agentwheel-Plan: ${planDigest}`,
  ]) {
    if (!message.split(/\r?\n/u).includes(trailer)) {
      throw new Error(`Git commit hooks removed required trailer: ${trailer}.`);
    }
  }
}

function assertRepositorySnapshotEqual(before: RepositorySnapshot, after: RepositorySnapshot, label: string): void {
  const entries = (snapshot: RepositorySnapshot) => [...snapshot.changed.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(entries(before)) !== JSON.stringify(entries(after))) {
    throw new Error(`${label} changed repository working state outside the governed commit contract.`);
  }
}

async function findOperationCommit(repositoryRoot: string, operationId: string, planDigest: string): Promise<string | undefined> {
  const output = (await runProcess("git", ["-C", repositoryRoot, "log", "--format=%H%x1f%B%x1e", "--max-count=500", "HEAD"]))
    .stdout.toString("utf8");
  for (const record of output.split("\x1e")) {
    const separator = record.indexOf("\x1f");
    if (separator < 0) continue;
    const sha = record.slice(0, separator).trim();
    const message = record.slice(separator + 1);
    if (message.split(/\r?\n/u).includes(`Agentwheel-Operation: ${operationId}`)
      && message.split(/\r?\n/u).includes(`Agentwheel-Plan: ${planDigest}`)) return sha;
  }
  return undefined;
}

async function verifyOperationCommit(
  request: Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
  commitSha: string,
): Promise<void> {
  const parent = (await runProcess("git", ["-C", request.repositoryRoot, "rev-parse", `${commitSha}^`])).stdout.toString("utf8").trim();
  if (parent !== request.expectedHead) throw new Error(`Recovered operation commit ${commitSha} has unexpected parent ${parent}.`);
  const committedPaths = splitNull((await runProcess("git", [
    "-C",
    request.repositoryRoot,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    commitSha,
  ])).stdout);
  assertExactSet(committedPaths, request.paths.map((entry) => entry.path), `operation commit ${commitSha}`);
  for (const entry of request.paths) {
    const after = await hashGitObject(request.repositoryRoot, `${commitSha}:${entry.path}`);
    if (after !== entry.afterSha256) {
      throw new Error(`Operation commit ${commitSha} content mismatch for ${entry.path}.`);
    }
  }
}

async function realignIndexAfterRecoveredCommit(repositoryRoot: string, expectedHead: string, commitSha: string): Promise<void> {
  if (await currentHead(repositoryRoot) !== commitSha) return;
  const staged = await runProcess("git", ["-C", repositoryRoot, "diff", "--cached", "--quiet"], { allowExitCodes: [0, 1] });
  if (staged.exitCode === 0) return;
  await assertIndexTree(repositoryRoot, expectedHead);
  await replaceIndexCas(repositoryRoot, await captureIndexLease(repositoryRoot), commitSha);
}

interface IndexLease {
  path: string;
  sha256: string | null;
  mode: number;
}

async function captureIndexLease(repositoryRoot: string): Promise<IndexLease> {
  const rawPath = (await runProcess("git", ["-C", repositoryRoot, "rev-parse", "--git-path", "index"]))
    .stdout.toString("utf8").trim();
  const path = isAbsolute(rawPath) ? rawPath : resolve(repositoryRoot, rawPath);
  try {
    const [content, info] = await Promise.all([readFile(path), stat(path)]);
    return { path, sha256: sha256(content), mode: info.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return { path, sha256: null, mode: 0o600 };
    throw error;
  }
}

async function replaceIndexCas(repositoryRoot: string, lease: IndexLease, commitSha: string): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentwheel-index-replacement-"));
  const replacementPath = join(tempRoot, "index");
  const lockPath = `${lease.path}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await runProcess("git", ["-C", repositoryRoot, "read-tree", commitSha], {
      env: { ...process.env, GIT_INDEX_FILE: replacementPath },
    });
    const replacement = await readFile(replacementPath);
    handle = await open(lockPath, "wx", lease.mode);
    const current = await readOptionalFile(lease.path);
    const currentSha256 = current ? sha256(current) : null;
    if (currentSha256 !== lease.sha256) {
      throw new Error("Git index changed concurrently; the operation commit was preserved but index alignment was refused.");
    }
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(lockPath, lease.mode);
    await rename(lockPath, lease.path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertIndexTree(repositoryRoot: string, expectedHead: string): Promise<void> {
  const indexTree = (await runProcess("git", ["-C", repositoryRoot, "write-tree"])).stdout.toString("utf8").trim();
  const expectedTree = (await runProcess("git", ["-C", repositoryRoot, "rev-parse", `${expectedHead}^{tree}`])).stdout.toString("utf8").trim();
  if (indexTree !== expectedTree) {
    throw new Error("Revisioning requires the real Git index to match the expected HEAD tree exactly.");
  }
}

async function verifyTemporaryIndexPaths(
  request: Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const entry of request.paths) {
    const result = await runProcess("git", ["-C", request.repositoryRoot, "show", `:${entry.path}`], {
      env,
      allowExitCodes: [0, 128],
    });
    const actual = result.exitCode === 0 ? sha256(result.stdout) : null;
    if (actual !== entry.afterSha256) throw new Error(`Temporary Git index content mismatch for ${entry.path}.`);
  }
}

async function hashGitObject(repositoryRoot: string, spec: string): Promise<string | null> {
  const result = await runProcess("git", ["-C", repositoryRoot, "show", spec], { allowExitCodes: [0, 128] });
  return result.exitCode === 0 ? sha256(result.stdout) : null;
}

async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function assertGitProviderCompatible(repositoryRoot: string): Promise<void> {
  const trackedSyncwheelManifest = await runProcess("git", [
    "-C",
    repositoryRoot,
    "ls-files",
    "--error-unmatch",
    ".syncwheel/manifest.json",
  ], { allowExitCodes: [0, 1] });
  if (trackedSyncwheelManifest.exitCode === 0) {
    throw new Error("The builtin Git revision provider refuses a tracked .syncwheel/manifest.json; configure an external coordination provider.");
  }
}

async function assertGitIdentity(repositoryRoot: string): Promise<void> {
  for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const result = await runProcess("git", ["-C", repositoryRoot, "var", identity], { allowExitCodes: [0, 128] });
    if (result.exitCode !== 0 || !result.stdout.toString("utf8").trim()) {
      throw new Error(`Git revisioning requires a configured ${identity === "GIT_AUTHOR_IDENT" ? "author" : "committer"} identity.`);
    }
  }
}

function terminalResponse(
  providerId: string,
  request: Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>,
  status: string,
  productCommitSha: string | null,
  resultingHead: string,
): RevisionProviderResponse {
  return revisionProviderResponseSchema.parse({
    ...baseResponse(providerId, request, status),
    expectedHead: request.expectedHead,
    resultingHead,
    productCommitSha,
    draftStackId: null,
    draftBranch: null,
    draftTipSha: null,
    controlCommitSha: null,
    manifestDigest: request.expectedManifestDigest ?? null,
    unmappedIntegrationCommits: [],
    published: false,
  });
}

function baseResponse(providerId: string, request: RevisionProviderRequest, status: string) {
  return {
    protocolVersion: request.protocolVersion,
    providerId,
    action: request.action,
    operationId: request.operationId,
    ok: true as const,
    status,
  };
}

function providerPlanDigest(request: RevisionProviderRequest): string {
  return revisionRequestDigest(revisionProviderRequestSchema.parse({ ...request, action: "finalize" }));
}

function asTerminalRequest(
  request: RevisionProviderRequest,
  action: "finalize" | "recover",
): Extract<RevisionProviderRequest, { action: "finalize" | "recover" }> {
  return revisionProviderRequestSchema.parse({ ...request, action }) as Extract<RevisionProviderRequest, { action: "finalize" | "recover" }>;
}

function commitMessage(request: RevisionProviderRequest, planDigest: string): string {
  const subjectCommand = request.commandName.replace(/\s+/gu, " ").trim().slice(0, 120);
  return [
    `chore(agentwheel): ${subjectCommand}`,
    "",
    request.reason.trim(),
    "",
    `Agentwheel-Operation: ${request.operationId}`,
    `Agentwheel-Plan: ${planDigest}`,
    "",
  ].join("\n");
}

function assertExactSet(actualInput: string[], expectedInput: string[], label: string): void {
  const actual = [...new Set(actualInput)].sort((a, b) => a.localeCompare(b));
  const expected = [...new Set(expectedInput)].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Exact path mismatch in ${label}: expected [${expected.join(", ")}], found [${actual.join(", ")}].`);
  }
}

function splitNull(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean);
}
