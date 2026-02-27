export type JsonObject = Record<string, unknown>;
export type RpcId = number | string;

export interface ReleaseCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string[];
  cwd: string;
  durationMs: number;
}

export interface ReleaseCommandRunner {
  run(command: string[], cwd: string): Promise<ReleaseCommandResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface WorkflowSummary {
  id: string;
  path: string;
  name: string | null;
}

export interface ReleaseInspectResult {
  isGitRepo: boolean;
  repoRoot?: string;
  repoName?: string;
  currentBranch?: string | null;
  currentHeadSha?: string;
  latestTags?: string[];
  workflows?: WorkflowSummary[];
  defaultWorkflow?: string | null;
}

export type ReleaseJobState = "queued" | "running" | "succeeded" | "failed";
export type ReleaseStepState = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface ReleaseJobLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  stepId: string | null;
  message: string;
}

export interface ReleaseJobStep {
  id: string;
  name: string;
  state: ReleaseStepState;
  startedAt: string | null;
  finishedAt: string | null;
  logs: string[];
  error: string | null;
}

export interface ReleaseJobError {
  stepId: string | null;
  message: string;
}

export interface ReleaseJob {
  id: string;
  state: ReleaseJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  repoRoot: string;
  tag: string;
  workflow: string | null;
  branch: string | null;
  steps: ReleaseJobStep[];
  logs: ReleaseJobLogEntry[];
  error: ReleaseJobError | null;
}

export interface ReleaseStartParams {
  repoRoot: string;
  tag: string;
  workflow: string | null;
  runCiLocal: boolean;
  ciCommand: string;
  pushBranch: boolean;
  branch: string | null;
  remote: string;
  waitForWorkflow: boolean;
  waitForRelease: boolean;
  requiredAssets: string[];
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface ReleaseCommandPlanInput {
  repoRoot: string;
  tag: string;
  branch: string;
  remote: string;
  runCiLocal: boolean;
  ciCommand: string;
  platform?: NodeJS.Platform;
}

export interface PlannedCommand {
  stepId: string;
  command: string[];
}

export interface ParsedWorkflowRun {
  databaseId: number | null;
  status: string | null;
  conclusion: string | null;
  headSha: string | null;
  workflowName: string | null;
  createdAt: string | null;
  url: string | null;
  displayTitle: string | null;
}

export interface ParsedReleaseAsset {
  name: string;
}

export interface ParsedReleaseView {
  tagName: string | null;
  isDraft: boolean;
  publishedAt: string | null;
  url: string | null;
  assets: ParsedReleaseAsset[];
}
