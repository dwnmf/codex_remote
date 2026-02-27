import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  buildReleaseCommandPlan,
  canTransitionJobState,
  deepCloneJob,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_LOGS,
  DEFAULT_MAX_STEP_LOGS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  ensureAbsolutePath,
  getOptionalBoolean,
  getOptionalPositiveInteger,
  getOptionalString,
  getOptionalStringArray,
  getParamString,
  newStep,
  normalizeAbsolutePath,
  normalizeCommandForLogs,
  nowIso,
  parseReleaseView,
  parseWorkflowRuns,
  selectWorkflowRun,
  toErrorMessage,
  trimAndBound,
} from "./release-command";
import type {
  JsonObject,
  ParsedReleaseView,
  ParsedWorkflowRun,
  ReleaseCommandResult,
  ReleaseCommandRunner,
  ReleaseInspectResult,
  ReleaseJob,
  ReleaseJobLogEntry,
  ReleaseJobState,
  ReleaseJobStep,
  ReleaseStartParams,
  RpcId,
  WorkflowSummary,
} from "./release-types";

interface ReleaseCockpitOptions {
  runner: ReleaseCommandRunner;
  maxHistory: number;
  maxLogs: number;
  maxStepLogs: number;
}

interface StartResolvedContext {
  repoRoot: string;
  branch: string | null;
  headSha: string;
  params: ReleaseStartParams;
}

class StepExecutionError extends Error {
  readonly stepId: string;

  constructor(stepId: string, message: string) {
    super(message);
    this.name = "StepExecutionError";
    this.stepId = stepId;
  }
}

export class ReleaseCockpit {
  private readonly runner: ReleaseCommandRunner;
  private readonly maxHistory: number;
  private readonly maxLogs: number;
  private readonly maxStepLogs: number;
  private readonly jobs = new Map<string, ReleaseJob>();
  private readonly order: string[] = [];

  constructor(options: Partial<ReleaseCockpitOptions> = {}) {
    if (!options.runner) {
      throw new Error("ReleaseCockpit requires a command runner");
    }
    this.runner = options.runner;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
    this.maxStepLogs = options.maxStepLogs ?? DEFAULT_MAX_STEP_LOGS;
  }

  async handleInspectRpc(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
    try {
      const inspect = await this.inspect(params);
      return { id, result: inspect };
    } catch (err) {
      return { id, error: { code: -1, message: toErrorMessage(err) } };
    }
  }

  async handleStartRpc(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
    try {
      const started = await this.start(params);
      return { id, result: started };
    } catch (err) {
      return { id, error: { code: -1, message: toErrorMessage(err) } };
    }
  }

  async handleStatusRpc(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
    try {
      const status = this.status(params);
      return { id, result: status };
    } catch (err) {
      return { id, error: { code: -1, message: toErrorMessage(err) } };
    }
  }

  async inspect(params: JsonObject | null): Promise<ReleaseInspectResult> {
    const sourcePath = getOptionalString(params, "repoRoot") ?? getOptionalString(params, "path");
    if (!sourcePath) {
      throw new Error("repoRoot or path is required");
    }
    const path = ensureAbsolutePath(sourcePath, "repoRoot");
    const repoRoot = await this.resolveRepoRoot(path);
    if (!repoRoot) {
      return { isGitRepo: false };
    }

    const [branchRes, headRes, tagsRes, workflows] = await Promise.all([
      this.runner.run(["git", "-C", repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot),
      this.runner.run(["git", "-C", repoRoot, "rev-parse", "HEAD"], repoRoot),
      this.runner.run(["git", "-C", repoRoot, "tag", "--sort=-creatordate"], repoRoot),
      this.readWorkflows(repoRoot),
    ]);

    const latestTags = tagsRes.ok
      ? tagsRes.stdout
          .split(/\r?\n/)
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 15)
      : [];

    const defaultWorkflow =
      workflows.find((entry) => entry.id.toLowerCase().includes("release"))?.id ??
      workflows.find((entry) => (entry.name ?? "").toLowerCase().includes("release"))?.id ??
      workflows[0]?.id ??
      null;

    return {
      isGitRepo: true,
      repoRoot,
      repoName: basename(repoRoot),
      currentBranch: branchRes.ok ? branchRes.stdout.split(/\r?\n/)[0] ?? null : null,
      currentHeadSha: headRes.ok ? headRes.stdout.split(/\r?\n/)[0] : "",
      latestTags,
      workflows,
      defaultWorkflow,
    };
  }

  async start(params: JsonObject | null): Promise<JsonObject> {
    const startParams = this.parseStartParams(params);
    const context = await this.resolveStartContext(startParams);
    const job = this.createJob(context);
    this.persistJob(job);

    void this.runJob(job.id, context).catch((err) => {
      this.failJob(job.id, null, toErrorMessage(err));
    });

    return { jobId: job.id, job: deepCloneJob(job) };
  }

  status(params: JsonObject | null): JsonObject {
    const jobId = getOptionalString(params, "jobId");
    const selected = jobId ? this.jobs.get(jobId) : this.getLatestJob();
    if (!selected) {
      return {
        found: false,
        latestJobId: this.getLatestJob()?.id ?? null,
        jobs: this.order.slice(-10).reverse().map((id) => this.toJobSummary(this.jobs.get(id)!)),
      };
    }
    return {
      found: true,
      job: deepCloneJob(selected),
      latestJobId: this.getLatestJob()?.id ?? null,
      jobs: this.order.slice(-10).reverse().map((id) => this.toJobSummary(this.jobs.get(id)!)),
    };
  }

  async waitForJob(jobId: string): Promise<ReleaseJob | null> {
    while (true) {
      const job = this.jobs.get(jobId);
      if (!job) return null;
      if (job.state === "succeeded" || job.state === "failed") {
        return deepCloneJob(job);
      }
      await this.runner.sleep(5);
    }
  }

  private parseStartParams(params: JsonObject | null): ReleaseStartParams {
    const repoRoot = ensureAbsolutePath(getParamString(params, "repoRoot"), "repoRoot");
    const tag = getParamString(params, "tag");
    const workflow = getOptionalString(params, "workflow");
    const runCiLocal = getOptionalBoolean(params, "runCiLocal", false);
    const ciCommand = getOptionalString(params, "ciCommand") ?? "bun run ci:local";
    const pushBranch = getOptionalBoolean(params, "pushBranch", true);
    const branch = getOptionalString(params, "branch");
    const remote = getOptionalString(params, "remote") ?? "origin";
    const waitForWorkflow = getOptionalBoolean(params, "waitForWorkflow", true);
    const waitForRelease = getOptionalBoolean(params, "waitForRelease", true);
    const requiredAssets = getOptionalStringArray(params, "requiredAssets");
    const pollIntervalMs = getOptionalPositiveInteger(params, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = getOptionalPositiveInteger(params, "timeoutMs", DEFAULT_TIMEOUT_MS);

    return {
      repoRoot,
      tag,
      workflow,
      runCiLocal,
      ciCommand,
      pushBranch,
      branch,
      remote,
      waitForWorkflow,
      waitForRelease,
      requiredAssets,
      pollIntervalMs: Math.max(250, pollIntervalMs),
      timeoutMs: Math.max(1_000, timeoutMs),
    };
  }

  private async resolveStartContext(params: ReleaseStartParams): Promise<StartResolvedContext> {
    const repoRoot = await this.resolveRepoRoot(params.repoRoot);
    if (!repoRoot) {
      throw new Error("repoRoot is not a git repository");
    }

    const headRes = await this.runner.run(["git", "-C", repoRoot, "rev-parse", "HEAD"], repoRoot);
    if (!headRes.ok || !headRes.stdout) {
      throw new Error(headRes.stderr || "Unable to resolve git HEAD");
    }
    const headSha = headRes.stdout.split(/\r?\n/)[0] ?? "";
    const branch = params.branch ?? (await this.readCurrentBranch(repoRoot));

    if (params.pushBranch && !branch) {
      throw new Error("Cannot push branch from detached HEAD; provide branch explicitly");
    }

    return { repoRoot, branch, headSha, params };
  }

  private createJob(context: StartResolvedContext): ReleaseJob {
    const ts = nowIso(this.runner);
    const shouldWatchWorkflow = Boolean(context.params.workflow && context.params.waitForWorkflow);
    const shouldWaitForRelease = context.params.waitForRelease;
    return {
      id: `rel_${this.runner.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      state: "queued",
      createdAt: ts,
      startedAt: null,
      finishedAt: null,
      updatedAt: ts,
      repoRoot: context.repoRoot,
      tag: context.params.tag,
      workflow: context.params.workflow,
      branch: context.branch,
      steps: [
        newStep("ci_local", "Run local CI", context.params.runCiLocal ? "pending" : "skipped"),
        newStep("push_branch", "Push branch", context.params.pushBranch ? "pending" : "skipped"),
        newStep("create_tag", "Create git tag"),
        newStep("push_tag", "Push git tag"),
        newStep("watch_workflow", "Watch release workflow", shouldWatchWorkflow ? "pending" : "skipped"),
        newStep("confirm_release", "Confirm published release/assets", shouldWaitForRelease ? "pending" : "skipped"),
      ],
      logs: [],
      error: null,
    };
  }

  private persistJob(job: ReleaseJob): void {
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    while (this.order.length > this.maxHistory) {
      const removed = this.order.shift();
      if (!removed) break;
      this.jobs.delete(removed);
    }
  }

  private setJobState(job: ReleaseJob, state: ReleaseJobState): void {
    if (!canTransitionJobState(job.state, state)) {
      throw new Error(`Invalid job transition ${job.state} -> ${state}`);
    }
    job.state = state;
    const ts = nowIso(this.runner);
    job.updatedAt = ts;
    if (state === "running") {
      job.startedAt = job.startedAt ?? ts;
    }
    if (state === "succeeded" || state === "failed") {
      job.finishedAt = ts;
    }
  }

  private getStep(job: ReleaseJob, stepId: string): ReleaseJobStep {
    const step = job.steps.find((entry) => entry.id === stepId);
    if (!step) {
      throw new Error(`Unknown step ${stepId}`);
    }
    return step;
  }

  private addLog(job: ReleaseJob, level: "info" | "warn" | "error", stepId: string | null, message: string): void {
    const entry: ReleaseJobLogEntry = {
      ts: nowIso(this.runner),
      level,
      stepId,
      message: trimAndBound(message),
    };
    job.logs.push(entry);
    while (job.logs.length > this.maxLogs) job.logs.shift();
    if (stepId) {
      const step = this.getStep(job, stepId);
      step.logs.push(entry.message);
      while (step.logs.length > this.maxStepLogs) step.logs.shift();
    }
    job.updatedAt = entry.ts;
  }

  private startStep(job: ReleaseJob, stepId: string): void {
    const step = this.getStep(job, stepId);
    if (step.state !== "pending") throw new Error(`Step ${stepId} is ${step.state}, expected pending`);
    step.state = "running";
    step.startedAt = nowIso(this.runner);
    this.addLog(job, "info", stepId, `${step.name} started`);
  }

  private completeStep(job: ReleaseJob, stepId: string): void {
    const step = this.getStep(job, stepId);
    if (step.state !== "running") throw new Error(`Step ${stepId} is ${step.state}, expected running`);
    step.state = "succeeded";
    step.finishedAt = nowIso(this.runner);
    this.addLog(job, "info", stepId, `${step.name} completed`);
  }

  private skipStep(job: ReleaseJob, stepId: string, reason: string): void {
    const step = this.getStep(job, stepId);
    if (step.state !== "skipped" && step.state !== "pending") return;
    step.state = "skipped";
    step.finishedAt = nowIso(this.runner);
    this.addLog(job, "info", stepId, reason);
  }

  private failStep(job: ReleaseJob, stepId: string, message: string): void {
    const step = this.getStep(job, stepId);
    step.state = "failed";
    step.finishedAt = nowIso(this.runner);
    step.error = message;
    this.addLog(job, "error", stepId, message);
  }

  private failJob(jobId: string, stepId: string | null, message: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (stepId) {
      try {
        this.failStep(job, stepId, message);
      } catch {
        this.addLog(job, "error", null, message);
      }
    } else {
      this.addLog(job, "error", null, message);
    }
    job.error = { stepId, message };
    if (job.state !== "failed") this.setJobState(job, "failed");
  }

  private async runJob(jobId: string, context: StartResolvedContext): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.setJobState(job, "running");
    try {
      const plan = buildReleaseCommandPlan({
        repoRoot: context.repoRoot,
        tag: context.params.tag,
        branch: context.branch ?? "",
        remote: context.params.remote,
        runCiLocal: context.params.runCiLocal,
        ciCommand: context.params.ciCommand,
      });

      if (context.params.runCiLocal) {
        const ciCmd = plan.find((entry) => entry.stepId === "ci_local");
        if (!ciCmd) throw new Error("Missing ci_local command plan");
        await this.runCommandStep(job, "ci_local", ciCmd.command, context.repoRoot);
      } else this.skipStep(job, "ci_local", "Local CI step disabled");

      if (context.params.pushBranch) {
        const pushBranch = plan.find((entry) => entry.stepId === "push_branch");
        if (!pushBranch) throw new Error("Missing push_branch command plan");
        await this.runPushBranchStep(job, pushBranch.command, context.repoRoot, context.params.remote, context.branch);
      } else this.skipStep(job, "push_branch", "Branch push disabled");

      const createTag = plan.find((entry) => entry.stepId === "create_tag");
      if (!createTag) throw new Error("Missing create_tag command plan");
      await this.runCommandStep(job, "create_tag", createTag.command, context.repoRoot);

      const pushTag = plan.find((entry) => entry.stepId === "push_tag");
      if (!pushTag) throw new Error("Missing push_tag command plan");
      await this.runCommandStep(job, "push_tag", pushTag.command, context.repoRoot);

      if (context.params.workflow && context.params.waitForWorkflow) {
        await this.watchWorkflowStep(job, context);
      } else this.skipStep(job, "watch_workflow", "Workflow watch disabled or workflow not provided");

      if (context.params.waitForRelease) {
        await this.confirmReleaseStep(job, context);
      } else this.skipStep(job, "confirm_release", "Release confirmation disabled");

      this.setJobState(job, "succeeded");
    } catch (err) {
      if (job.error) return;
      if (err instanceof StepExecutionError) {
        this.failJob(job.id, err.stepId, err.message);
        return;
      }
      this.failJob(job.id, null, toErrorMessage(err));
    }
  }

  private async runPushBranchStep(
    job: ReleaseJob,
    primaryCommand: string[],
    cwd: string,
    remote: string,
    branch: string | null,
  ): Promise<void> {
    if (!branch) throw new Error("Missing branch for push");
    this.startStep(job, "push_branch");
    this.addLog(job, "info", "push_branch", `Running: ${normalizeCommandForLogs(primaryCommand)}`);
    const primary = await this.runner.run(primaryCommand, cwd);
    if (primary.ok) {
      this.logCommandResult(job, "push_branch", primary);
      this.completeStep(job, "push_branch");
      return;
    }

    const fallback = ["git", "-C", cwd, "push", remote, branch];
    this.addLog(job, "warn", "push_branch", "Primary push failed, retrying without --set-upstream");
    const fallbackRes = await this.runner.run(fallback, cwd);
    this.logCommandResult(job, "push_branch", fallbackRes);
    if (!fallbackRes.ok) {
      const message = fallbackRes.stderr || fallbackRes.stdout || "Failed to push branch";
      throw new StepExecutionError("push_branch", message);
    }
    this.completeStep(job, "push_branch");
  }

  private logCommandResult(job: ReleaseJob, stepId: string, result: ReleaseCommandResult): void {
    const status = result.ok ? "ok" : "failed";
    this.addLog(job, result.ok ? "info" : "error", stepId, `Command ${status} (${result.code}) in ${result.durationMs}ms`);
    if (result.stdout) this.addLog(job, "info", stepId, `stdout: ${trimAndBound(result.stdout)}`);
    if (result.stderr) this.addLog(job, result.ok ? "warn" : "error", stepId, `stderr: ${trimAndBound(result.stderr)}`);
  }

  private async runCommandStep(job: ReleaseJob, stepId: string, command: string[], cwd: string): Promise<void> {
    this.startStep(job, stepId);
    this.addLog(job, "info", stepId, `Running: ${normalizeCommandForLogs(command)}`);
    const result = await this.runner.run(command, cwd);
    this.logCommandResult(job, stepId, result);
    if (!result.ok) {
      const message = result.stderr || result.stdout || `${stepId} failed`;
      throw new StepExecutionError(stepId, message);
    }
    this.completeStep(job, stepId);
  }

  private async watchWorkflowStep(job: ReleaseJob, context: StartResolvedContext): Promise<void> {
    this.startStep(job, "watch_workflow");
    const deadline = this.runner.now() + context.params.timeoutMs;
    let trackedRunId: number | null = null;
    while (this.runner.now() < deadline) {
      const result = await this.runner.run(
        [
          "gh",
          "run",
          "list",
          "--workflow",
          context.params.workflow!,
          "--json",
          "databaseId,status,conclusion,headSha,workflowName,createdAt,url,displayTitle",
          "--limit",
          "20",
        ],
        context.repoRoot,
      );
      if (!result.ok) {
        const message = result.stderr || result.stdout || "Failed to list workflow runs";
        throw new StepExecutionError("watch_workflow", message);
      }

      let runs: ParsedWorkflowRun[];
      try {
        runs = parseWorkflowRuns(result.stdout);
      } catch (err) {
        throw new StepExecutionError("watch_workflow", `Invalid workflow payload: ${toErrorMessage(err)}`);
      }
      const selected = selectWorkflowRun(runs, { headSha: context.headSha, tag: context.params.tag, trackedRunId });
      if (!selected) {
        this.addLog(job, "info", "watch_workflow", "No matching workflow run yet");
        await this.runner.sleep(context.params.pollIntervalMs);
        continue;
      }

      if (trackedRunId == null && selected.databaseId != null) {
        trackedRunId = selected.databaseId;
        this.addLog(job, "info", "watch_workflow", `Tracking workflow run ${String(selected.databaseId)}`);
      } else {
        this.addLog(job, "info", "watch_workflow", `Workflow status ${selected.status ?? "unknown"} / ${selected.conclusion ?? "n/a"}`);
      }

      if (selected.status === "completed") {
        if (selected.conclusion === "success") {
          this.completeStep(job, "watch_workflow");
          return;
        }
        const message = `Workflow run failed: conclusion=${selected.conclusion ?? "unknown"}`;
        this.failStep(job, "watch_workflow", message);
        throw new Error(message);
      }

      await this.runner.sleep(context.params.pollIntervalMs);
    }

    throw new StepExecutionError("watch_workflow", "Timed out waiting for release workflow completion");
  }

  private async confirmReleaseStep(job: ReleaseJob, context: StartResolvedContext): Promise<void> {
    this.startStep(job, "confirm_release");
    const deadline = this.runner.now() + context.params.timeoutMs;
    const neededAssets = new Set(context.params.requiredAssets.map((entry) => entry.toLowerCase()));
    while (this.runner.now() < deadline) {
      const result = await this.runner.run(
        ["gh", "release", "view", context.params.tag, "--json", "tagName,isDraft,publishedAt,url,assets"],
        context.repoRoot,
      );
      if (!result.ok) {
        const transient = `${result.stderr} ${result.stdout}`.toLowerCase();
        if (transient.includes("not found") || transient.includes("no release")) {
          this.addLog(job, "info", "confirm_release", "Release not published yet");
          await this.runner.sleep(context.params.pollIntervalMs);
          continue;
        }
        const message = result.stderr || result.stdout || "Failed to query GitHub release";
        throw new StepExecutionError("confirm_release", message);
      }

      let release: ParsedReleaseView;
      try {
        release = parseReleaseView(result.stdout);
      } catch (err) {
        throw new StepExecutionError("confirm_release", `Invalid release payload: ${toErrorMessage(err)}`);
      }
      if (release.tagName && release.tagName !== context.params.tag) {
        this.addLog(job, "warn", "confirm_release", `Release tag mismatch: ${release.tagName}`);
        await this.runner.sleep(context.params.pollIntervalMs);
        continue;
      }
      if (release.isDraft || !release.publishedAt) {
        this.addLog(job, "info", "confirm_release", "Release exists but is not yet published");
        await this.runner.sleep(context.params.pollIntervalMs);
        continue;
      }
      if (neededAssets.size > 0) {
        const existing = new Set(release.assets.map((asset) => asset.name.toLowerCase()));
        const missing = [...neededAssets].filter((asset) => !existing.has(asset));
        if (missing.length > 0) {
          this.addLog(job, "info", "confirm_release", `Waiting for assets: ${missing.join(", ")}`);
          await this.runner.sleep(context.params.pollIntervalMs);
          continue;
        }
      }
      this.addLog(job, "info", "confirm_release", `Published release confirmed: ${release.url ?? context.params.tag}`);
      this.completeStep(job, "confirm_release");
      return;
    }

    throw new StepExecutionError("confirm_release", "Timed out waiting for GitHub release publication");
  }

  private async readCurrentBranch(repoRoot: string): Promise<string | null> {
    const result = await this.runner.run(["git", "-C", repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot);
    if (!result.ok || !result.stdout) return null;
    return result.stdout.split(/\r?\n/)[0] ?? null;
  }

  private async resolveRepoRoot(path: string): Promise<string | null> {
    const result = await this.runner.run(["git", "-C", path, "rev-parse", "--show-toplevel"], path);
    if (!result.ok || !result.stdout) return null;
    return normalizeAbsolutePath(result.stdout.split(/\r?\n/)[0] ?? result.stdout);
  }

  private async readWorkflows(repoRoot: string): Promise<WorkflowSummary[]> {
    const workflowsDir = join(repoRoot, ".github", "workflows");
    try {
      const entries = await readdir(workflowsDir, { withFileTypes: true });
      const workflowFiles = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort();
      const workflows: WorkflowSummary[] = [];
      for (const fileName of workflowFiles) {
        const fullPath = join(workflowsDir, fileName);
        let displayName: string | null = null;
        try {
          const content = await readFile(fullPath, "utf8");
          const match = content.match(/^\s*name\s*:\s*(.+)$/m);
          displayName = match ? match[1]!.trim().replace(/^['"]|['"]$/g, "") : null;
        } catch {
          displayName = null;
        }
        workflows.push({ id: fileName, path: fullPath, name: displayName });
      }
      return workflows;
    } catch {
      return [];
    }
  }

  private toJobSummary(job: ReleaseJob): JsonObject {
    return {
      id: job.id,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      repoRoot: job.repoRoot,
      tag: job.tag,
      workflow: job.workflow,
      branch: job.branch,
    };
  }

  private getLatestJob(): ReleaseJob | null {
    const lastId = this.order[this.order.length - 1];
    return lastId ? this.jobs.get(lastId) ?? null : null;
  }
}
