export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ThreadInfo {
  id: string;
  preview?: string;
  createdAt?: number;
  modelProvider?: string;
}

export type ApprovalPolicy = "on-request" | "never";

export interface ModelOption {
  value: string;
  label: string;
  model?: string;
  upgrade?: string | null;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  isDefault?: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ThreadSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  mode: ModeKind;
}

export type MessageRole = "user" | "assistant" | "tool" | "approval";
export type MessageKind =
  | "reasoning"
  | "command"
  | "file"
  | "mcp"
  | "web"
  | "review"
  | "image"
  | "terminal"
  | "wait"
  | "approval-request"
  | "user-input-request"
  | "plan"
  | "collab"
  | "compaction";

export interface FileChangeEntry {
  path: string;
  diff?: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface MessageMetadata {
  filePath?: string;
  exitCode?: number;
  linesAdded?: number;
  linesRemoved?: number;
  fileChanges?: FileChangeEntry[];
  imagePath?: string;
  imageUrl?: string;
  imageMimeType?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageBytes?: number;
}

export interface TurnImageInput {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  dataUrl: string;
}

export interface ApprovalRequest {
  id: string;
  rpcId: number; // The JSON-RPC request ID to respond to
  type: "command" | "file" | "mcp" | "other";
  description: string;
  command?: string;
  filePath?: string;
  toolName?: string;
  reason?: string;
  status: "pending" | "approved" | "declined" | "cancelled";
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: UserInputOption[];
}

export interface UserInputRequest {
  rpcId: number;
  questions: UserInputQuestion[];
  status: "pending" | "answered";
}

export interface Message {
  id: string;
  role: MessageRole;
  kind?: MessageKind;
  text: string;
  threadId: string;
  language?: string;
  metadata?: MessageMetadata;
  approval?: ApprovalRequest;
  userInputRequest?: UserInputRequest;
  planStatus?: "pending" | "approved";
}

// JSON-RPC style message envelope
export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

// Turn status
export type TurnStatus = "InProgress" | "Completed" | "Interrupted" | "Failed";

// Plan step
export type PlanStepStatus = "Pending" | "InProgress" | "Completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

// Planning questions
export type PlanningQuestionType = "choice" | "multi" | "text" | "scale" | "confirm";

export interface PlanningQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PlanningQuestion {
  id: string;
  type: PlanningQuestionType;
  question: string;
  options?: PlanningQuestionOption[];
  min?: number;
  max?: number;
  labels?: [string, string];
  placeholder?: string;
}

export interface PlanningAnswer {
  questionId: string;
  value: string | string[] | number | boolean;
}

export type PlanningPhase = "design" | "review" | "final";

export type ModeKind = "plan" | "code";

export interface CollaborationMode {
  mode: ModeKind;
  settings: {
    model: string;
    reasoning_effort?: ReasoningEffort;
    developer_instructions?: string;
  };
}

export interface CollaborationModeMask {
  name: string;
  mode?: ModeKind;
  model?: string;
  reasoning_effort?: ReasoningEffort | null;
  developer_instructions?: string | null;
}

export interface GitInspectResult {
  isGitRepo: boolean;
  repoRoot?: string;
  currentBranch?: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitWorktreeListResult {
  repoRoot: string;
  mainPath: string;
  worktrees: GitWorktree[];
}

export interface GitWorktreeCreateParams {
  repoRoot: string;
  baseRef?: string;
  branchName?: string;
  path?: string;
  rootDir?: string;
}

export interface GitWorktreeCreateResult {
  repoRoot: string;
  path: string;
  branch: string;
  head: string;
}

export interface AnchorFileReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface OrbitArtifactLink {
  label: string;
  href: string;
}

export interface OrbitArtifact {
  id: string;
  threadId: string;
  type: string;
  title: string;
  summary?: string;
  createdAt: string;
  status?: string;
  links?: OrbitArtifactLink[];
  metadata?: Record<string, unknown>;
}

export interface OrbitArtifactsListResult {
  artifacts: OrbitArtifact[];
}

export interface OrbitMultiDispatchPayload {
  channel: string;
  threadId?: string;
  releaseId?: string;
  event?: string;
  data: Record<string, unknown>;
}

export type ReleaseCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface ReleaseCheck {
  id: string;
  label: string;
  status: ReleaseCheckStatus;
  detail?: string;
}

export interface ReleaseInspectResult {
  ready: boolean;
  repoPath?: string;
  branch?: string | null;
  checks: ReleaseCheck[];
  notes: string[];
}

export interface ReleaseStartParams {
  repoPath?: string;
  targetRef?: string;
  tag?: string;
  dryRun?: boolean;
  anchorId?: string;
}

export interface ReleaseStartResult {
  releaseId: string;
  status: string;
  message?: string;
}

export interface ReleaseLogEntry {
  id: string;
  ts: string;
  level: string;
  message: string;
}

export interface ReleaseAsset {
  id: string;
  label: string;
  href?: string;
  path?: string;
  kind?: string;
}

export interface ReleaseStatusResult {
  releaseId: string;
  status: string;
  phase?: string;
  logs: ReleaseLogEntry[];
  assets: ReleaseAsset[];
  links: ReleaseAsset[];
  error?: string;
  updatedAt?: string;
  completedAt?: string;
}
