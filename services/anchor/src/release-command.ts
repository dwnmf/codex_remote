import { isAbsolute, resolve } from "node:path";
import type {
  JsonObject,
  ParsedReleaseView,
  ParsedWorkflowRun,
  PlannedCommand,
  ReleaseCommandPlanInput,
  ReleaseCommandResult,
  ReleaseCommandRunner,
  ReleaseJob,
  ReleaseJobState,
  ReleaseJobStep,
  ReleaseStepState,
} from "./release-types";

export const DEFAULT_POLL_INTERVAL_MS = 4_000;
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_HISTORY = 30;
export const DEFAULT_MAX_LOGS = 300;
export const DEFAULT_MAX_STEP_LOGS = 60;

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeAbsolutePath(path: string): string {
  return resolve(path.trim());
}

export function ensureAbsolutePath(path: string, field: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return normalizeAbsolutePath(trimmed);
}

export function getParamString(params: JsonObject | null, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function getOptionalString(params: JsonObject | null, key: string): string | null {
  const value = params?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getOptionalBoolean(params: JsonObject | null, key: string, fallback: boolean): boolean {
  const value = params?.[key];
  return typeof value === "boolean" ? value : fallback;
}

export function getOptionalPositiveInteger(params: JsonObject | null, key: string, fallback: number): number {
  const value = params?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function getOptionalStringArray(params: JsonObject | null, key: string): string[] {
  const value = params?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function readProcessStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return new Response(stream).text();
}

export function nowIso(runner: ReleaseCommandRunner): string {
  return new Date(runner.now()).toISOString();
}

export function trimAndBound(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 1_000) return trimmed;
  return `${trimmed.slice(0, 1_000)}...`;
}

export function normalizeCommandForLogs(command: string[]): string {
  return command.map((entry) => (entry.includes(" ") ? JSON.stringify(entry) : entry)).join(" ");
}

export function newStep(id: string, name: string, state: ReleaseStepState = "pending"): ReleaseJobStep {
  return {
    id,
    name,
    state,
    startedAt: null,
    finishedAt: null,
    logs: [],
    error: null,
  };
}

export function deepCloneJob(job: ReleaseJob): ReleaseJob {
  return {
    ...job,
    steps: job.steps.map((step) => ({ ...step, logs: [...step.logs] })),
    logs: job.logs.map((entry) => ({ ...entry })),
    error: job.error ? { ...job.error } : null,
  };
}

export function canTransitionJobState(from: ReleaseJobState, to: ReleaseJobState): boolean {
  if (from === to) return true;
  if (from === "queued") return to === "running" || to === "failed";
  if (from === "running") return to === "succeeded" || to === "failed";
  return false;
}

export function parseWorkflowRuns(output: string): ParsedWorkflowRun[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected gh run list JSON array");
  }

  return parsed.map((entry) => {
    const row = typeof entry === "object" && entry !== null ? (entry as JsonObject) : {};
    const id = row.databaseId;
    return {
      databaseId: typeof id === "number" ? id : null,
      status: typeof row.status === "string" ? row.status : null,
      conclusion: typeof row.conclusion === "string" ? row.conclusion : null,
      headSha: typeof row.headSha === "string" ? row.headSha : null,
      workflowName: typeof row.workflowName === "string" ? row.workflowName : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      url: typeof row.url === "string" ? row.url : null,
      displayTitle: typeof row.displayTitle === "string" ? row.displayTitle : null,
    };
  });
}

export function parseReleaseView(output: string): ParsedReleaseView {
  const parsed = JSON.parse(output) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected gh release view JSON object");
  }
  const row = parsed as JsonObject;
  const assetsRaw = Array.isArray(row.assets) ? row.assets : [];
  const assets = assetsRaw
    .map((asset) => (asset && typeof asset === "object" ? (asset as JsonObject) : null))
    .filter((asset): asset is JsonObject => asset !== null)
    .map((asset) => ({ name: typeof asset.name === "string" ? asset.name : "" }))
    .filter((asset) => asset.name.length > 0);
  return {
    tagName: typeof row.tagName === "string" ? row.tagName : null,
    isDraft: Boolean(row.isDraft),
    publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : null,
    url: typeof row.url === "string" ? row.url : null,
    assets,
  };
}

export function buildReleaseCommandPlan(input: ReleaseCommandPlanInput): PlannedCommand[] {
  const commands: PlannedCommand[] = [];
  const platform = input.platform ?? process.platform;
  if (input.runCiLocal) {
    const shellCommand =
      platform === "win32"
        ? ["powershell", "-NoProfile", "-Command", input.ciCommand]
        : ["bash", "-lc", input.ciCommand];
    commands.push({ stepId: "ci_local", command: shellCommand });
  }
  commands.push({ stepId: "push_branch", command: ["git", "-C", input.repoRoot, "push", "--set-upstream", input.remote, input.branch] });
  commands.push({ stepId: "create_tag", command: ["git", "-C", input.repoRoot, "tag", input.tag] });
  commands.push({ stepId: "push_tag", command: ["git", "-C", input.repoRoot, "push", input.remote, input.tag] });
  return commands;
}

export function selectWorkflowRun(
  runs: ParsedWorkflowRun[],
  opts: { headSha: string; tag: string; trackedRunId: number | null },
): ParsedWorkflowRun | null {
  if (opts.trackedRunId != null) {
    return runs.find((run) => run.databaseId === opts.trackedRunId) ?? null;
  }

  const recent = [...runs].sort((a, b) => {
    const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTs - aTs;
  });
  return (
    recent.find((run) => {
      if (run.headSha && run.headSha === opts.headSha) return true;
      const title = run.displayTitle?.toLowerCase() ?? "";
      return title.includes(opts.tag.toLowerCase());
    }) ?? null
  );
}

export function createDefaultReleaseCommandRunner(): ReleaseCommandRunner {
  return {
    async run(command: string[], cwd: string): Promise<ReleaseCommandResult> {
      const started = Date.now();
      try {
        const proc = Bun.spawn({
          cmd: command,
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          readProcessStream(proc.stdout),
          readProcessStream(proc.stderr),
          proc.exited,
        ]);
        return {
          ok: code === 0,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          command,
          cwd,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          code: -1,
          stdout: "",
          stderr: toErrorMessage(err),
          command,
          cwd,
          durationMs: Date.now() - started,
        };
      }
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    },
    now(): number {
      return Date.now();
    },
  };
}
