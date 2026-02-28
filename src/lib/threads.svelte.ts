import type { ApprovalPolicy, CollaborationMode, CollaborationModeMask, ModeKind, ReasoningEffort, SandboxMode, ThreadInfo, RpcMessage, ThreadSettings } from "./types";
import { socket } from "./socket.svelte";
import { messages } from "./messages.svelte";
import { models } from "./models.svelte";
import { anchors } from "./anchors.svelte";
import { auth } from "./auth.svelte";
import { navigate } from "../router";

const STORE_KEY = "__codex_remote_threads_store__";
const SETTINGS_STORAGE_KEY = "codex_remote_thread_settings";
const PROJECTS_STORAGE_KEY = "codex_remote_thread_projects";

const DEFAULT_SETTINGS: ThreadSettings = {
  model: "",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  mode: "code",
};

interface PendingStart {
  cwd: string | null;
  input: string | null;
  model: string | null;
  collaborationMode: CollaborationMode | null;
  suppressNavigation: boolean;
  onThreadStarted: ((threadId: string) => void) | null;
  onThreadStartFailed: ((error: Error) => void) | null;
}

class ThreadsStore {
  list = $state<ThreadInfo[]>([]);
  currentId = $state<string | null>(null);
  loading = $state(false);

  #settings = $state<Map<string, ThreadSettings>>(new Map());
  #projectByThread = $state<Map<string, string>>(new Map());
  #nextId = 1;
  #pendingRequests = new Map<number, string>();
  #pendingStarts = new Map<number, PendingStart>();
  #collaborationPresets: CollaborationModeMask[] = [];

  constructor() {
    this.#loadSettings();
    this.#loadProjectPaths();
  }

  getSettings(threadId: string | null): ThreadSettings {
    if (!threadId) return { ...DEFAULT_SETTINGS };
    const settings = this.#settings.get(threadId);
    return settings ? { ...settings } : { ...DEFAULT_SETTINGS };
  }

  updateSettings(threadId: string, update: Partial<ThreadSettings>) {
    const current = this.#settings.get(threadId) ?? DEFAULT_SETTINGS;
    const next: ThreadSettings = { ...current, ...update };
    if (
      current.model === next.model &&
      current.reasoningEffort === next.reasoningEffort &&
      current.sandbox === next.sandbox &&
      current.mode === next.mode
    ) {
      return;
    }
    this.#settings = new Map(this.#settings).set(threadId, next);
    this.#saveSettings();
  }

  getProjectPath(threadId: string | null): string {
    if (!threadId) return "";
    return this.#projectByThread.get(threadId) ?? "";
  }

  setProjectPath(threadId: string, path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    const current = this.#projectByThread.get(threadId);
    if (current === normalized) return;
    this.#projectByThread = new Map(this.#projectByThread).set(threadId, normalized);
    this.#saveProjectPaths();
  }

  fetch() {
    const id = this.#nextId++;
    this.loading = true;
    this.#pendingRequests.set(id, "list");
    const anchorId = this.#resolveAnchorIdForRequest(false);
    socket.send({
      method: "thread/list",
      id,
      params: { cursor: null, limit: 25, ...(anchorId ? { anchorId } : {}) },
    });
  }

  open(threadId: string) {
    const anchorId = this.#resolveAnchorIdForRequest(false);
    const id = this.#nextId++;
    this.loading = true;
    this.currentId = threadId;
    messages.clearThread(threadId);
    socket.subscribeThread(threadId);
    this.#pendingRequests.set(id, "resume");
    socket.send({
      method: "thread/resume",
      id,
      params: { threadId, ...(anchorId ? { anchorId } : {}) },
    });
  }

  start(
    cwd: string,
    input?: string,
    options?: {
      approvalPolicy?: ApprovalPolicy | string;
      sandbox?: SandboxMode | string;
      suppressNavigation?: boolean;
      onThreadStarted?: (threadId: string) => void;
      onThreadStartFailed?: (error: Error) => void;
      collaborationMode?: CollaborationMode;
    }
  ) {
    this.#startThread(cwd, input, options);
  }

  fetchCollaborationPresets() {
    const id = this.#nextId++;
    this.#pendingRequests.set(id, "collaborationPresets");
    const anchorId = this.#resolveAnchorIdForRequest(false);
    socket.send({
      method: "collaborationMode/list",
      id,
      params: anchorId ? { anchorId } : {},
    });
  }

  resolveCollaborationMode(
    mode: ModeKind,
    model: string,
    reasoningEffort?: ReasoningEffort,
  ): CollaborationMode {
    const preset = this.#collaborationPresets.find((p) => p.mode === mode);
    return {
      mode,
      settings: {
        model,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(preset?.developer_instructions
          ? { developer_instructions: preset.developer_instructions }
          : {}),
      },
    };
  }

  archive(threadId: string) {
    const anchorId = this.#resolveAnchorIdForRequest(false);
    const id = this.#nextId++;
    this.#pendingRequests.set(id, "archive");
    socket.unsubscribeThread(threadId);
    socket.send({
      method: "thread/archive",
      id,
      params: { threadId, ...(anchorId ? { anchorId } : {}) },
    });
    this.list = this.list.filter((t) => t.id !== threadId);
    if (this.currentId === threadId) {
      this.currentId = null;
    }
    if (this.#settings.has(threadId)) {
      const next = new Map(this.#settings);
      next.delete(threadId);
      this.#settings = next;
      this.#saveSettings();
    }
    if (this.#projectByThread.has(threadId)) {
      const next = new Map(this.#projectByThread);
      next.delete(threadId);
      this.#projectByThread = next;
      this.#saveProjectPaths();
    }
  }

  handleMessage(msg: RpcMessage) {
    if (msg.method === "thread/started") {
      const params = msg.params as { thread: ThreadInfo };
      if (params?.thread) {
        socket.subscribeThread(params.thread.id);
        this.#addThread(params.thread);
      }
      return;
    }

    if (msg.id != null && this.#pendingRequests.has(msg.id as number)) {
      const type = this.#pendingRequests.get(msg.id as number);
      this.#pendingRequests.delete(msg.id as number);

      if (type === "list" && msg.result) {
        const result = msg.result as { data: ThreadInfo[] };
        this.list = result.data || [];
        this.loading = false;
      }
      if (type === "list" && msg.error) {
        this.loading = false;
      }

      if (type === "resume") {
        this.loading = false;
      }

      if (type === "collaborationPresets" && msg.result) {
        const result = msg.result as { data: CollaborationModeMask[] };
        this.#collaborationPresets = result.data || [];
      }

      if (type === "start" && msg.error) {
        const pending = this.#pendingStarts.get(msg.id as number) ?? null;
        this.#pendingStarts.delete(msg.id as number);
        this.#handleStartFailure(msg.error, pending);
      }

      if (type === "start" && msg.result) {
        const pending = this.#pendingStarts.get(msg.id as number) ?? null;
        this.#pendingStarts.delete(msg.id as number);
        const result = msg.result as {
          thread?: ThreadInfo;
          model?: string;
          reasoningEffort?: ReasoningEffort;
          sandbox?: { type?: string } | string;
        };
        const thread = result.thread;
        if (thread?.id) {
          const sandbox = this.#normalizeSandbox(result.sandbox);
          this.updateSettings(thread.id, {
            model: result.model ?? pending?.model ?? "",
            reasoningEffort: result.reasoningEffort ?? DEFAULT_SETTINGS.reasoningEffort,
            ...(sandbox ? { sandbox } : {}),
          });

          socket.subscribeThread(thread.id);
          this.#handleStartedThread(thread, pending);
        }
      }
    }
  }

  #addThread(thread: ThreadInfo) {
    if (this.list.some((t) => t.id === thread.id)) return;
    this.list = [thread, ...this.list];
  }

  #handleStartedThread(thread: ThreadInfo, pending: PendingStart | null) {
    this.#addThread(thread);

    if (pending?.cwd?.trim()) {
      this.setProjectPath(thread.id, pending.cwd.trim());
    }

    if (pending?.onThreadStarted) {
      pending.onThreadStarted(thread.id);
    }

    if (!pending?.suppressNavigation) {
      this.currentId = thread.id;
      navigate("/thread/:id", { params: { id: thread.id } });
    }

    if (pending?.input) {
      const anchorId = this.#resolveAnchorIdForRequest(false);
      socket.send({
        method: "turn/start",
        id: this.#nextId++,
        params: {
          threadId: thread.id,
          input: [{ type: "text", text: pending.input }],
          ...(anchorId ? { anchorId } : {}),
          ...(pending.collaborationMode
            ? { collaborationMode: pending.collaborationMode }
            : {}),
        },
      });
    }
  }

  #normalizeSandbox(input: unknown): SandboxMode | null {
    if (!input) return null;
    if (typeof input === "string") {
      if (input === "read-only" || input === "workspace-write" || input === "danger-full-access") {
        return input;
      }
      const lower = input.toLowerCase();
      if (lower.includes("readonly")) return "read-only";
      if (lower.includes("workspace")) return "workspace-write";
      if (lower.includes("danger") || lower.includes("full")) return "danger-full-access";
      return null;
    }
    if (typeof input === "object") {
      const type = (input as { type?: string }).type;
      if (!type) return null;
      if (type === "readOnly") return "read-only";
      if (type === "workspaceWrite") return "workspace-write";
      if (type === "dangerFullAccess") return "danger-full-access";
      return this.#normalizeSandbox(type);
    }
    return null;
  }

  #startThread(
    cwd: string,
    input: string | undefined,
    options?: {
      approvalPolicy?: ApprovalPolicy | string;
      sandbox?: SandboxMode | string;
      suppressNavigation?: boolean;
      onThreadStarted?: (threadId: string) => void;
      onThreadStartFailed?: (error: Error) => void;
      collaborationMode?: CollaborationMode;
    }
  ) {
    const anchorId = this.#resolveAnchorIdForRequest(true);
    if (!anchorId && !auth.isLocalMode) {
      const message = this.#getAnchorErrorMessage();
      const pending: PendingStart = {
        cwd: cwd.trim() || null,
        input: input?.trim() ? input.trim() : null,
        model: this.#resolveStartModel(options?.collaborationMode),
        collaborationMode: options?.collaborationMode ?? null,
        suppressNavigation: options?.suppressNavigation ?? false,
        onThreadStarted: options?.onThreadStarted ?? null,
        onThreadStartFailed: options?.onThreadStartFailed ?? null,
      };
      this.#handleStartFailure({ message }, pending);
      throw new Error(message);
    }

    const requestedModel = this.#resolveStartModel(options?.collaborationMode);
    const id = this.#nextId++;
    const pending: PendingStart = {
      cwd: cwd.trim() || null,
      input: input?.trim() ? input.trim() : null,
      model: requestedModel,
      collaborationMode: options?.collaborationMode ?? null,
      suppressNavigation: options?.suppressNavigation ?? false,
      onThreadStarted: options?.onThreadStarted ?? null,
      onThreadStartFailed: options?.onThreadStartFailed ?? null,
    };
    this.#pendingRequests.set(id, "start");
    this.#pendingStarts.set(id, pending);
    const sendResult = socket.send({
      method: "thread/start",
      id,
      params: {
        cwd,
        ...(anchorId ? { anchorId } : {}),
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options?.sandbox ? { sandbox: options.sandbox } : {}),
      },
    });
    if (!sendResult.success) {
      this.#pendingRequests.delete(id);
      this.#pendingStarts.delete(id);
      const message = sendResult.error ?? "Failed to start thread";
      this.#handleStartFailure({ message }, pending);
      throw new Error(message);
    }
  }

  #resolveStartModel(collaborationMode?: CollaborationMode): string | null {
    const collabModel = collaborationMode?.settings?.model?.trim();
    if (collabModel) return collabModel;
    return models.defaultModel?.value ?? null;
  }

  #handleStartFailure(error: unknown, pending: PendingStart | null) {
    const message = this.#getErrorMessage(error);
    if (pending?.onThreadStartFailed) {
      pending.onThreadStartFailed(new Error(message));
    }
  }

  #resolveAnchorIdForRequest(requireOnline: boolean): string | null {
    if (auth.isLocalMode) return null;
    if (!anchors.selectedId) return null;
    if (!requireOnline) return anchors.selectedId;
    return anchors.selected?.id ?? null;
  }

  #getAnchorErrorMessage(): string {
    if (auth.isLocalMode) return "Failed to start thread";
    if (anchors.list.length === 0) return "No devices are connected.";
    if (!anchors.selectedId) return "Select a device in Settings before creating a session.";
    if (!anchors.selected) return "Selected device is offline. Choose another device in Settings.";
    return "Failed to start thread";
  }

  #getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    return "Failed to start thread";
  }

  #loadSettings() {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!saved) return;
      const data = JSON.parse(saved) as Record<string, ThreadSettings>;
      const next = new Map<string, ThreadSettings>();
      for (const [threadId, settings] of Object.entries(data)) {
        if (!threadId) continue;
        next.set(threadId, { ...DEFAULT_SETTINGS, ...settings });
      }
      this.#settings = next;
    } catch {
      // ignore
    }
  }

  #saveSettings() {
    try {
      const data: Record<string, ThreadSettings> = {};
      for (const [threadId, settings] of this.#settings) {
        data[threadId] = settings;
      }
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  #loadProjectPaths() {
    try {
      const saved = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!saved) return;
      const data = JSON.parse(saved) as Record<string, string>;
      const next = new Map<string, string>();
      for (const [threadId, path] of Object.entries(data)) {
        const normalizedThreadId = threadId.trim();
        const normalizedPath = typeof path === "string" ? path.trim() : "";
        if (!normalizedThreadId || !normalizedPath) continue;
        next.set(normalizedThreadId, normalizedPath);
      }
      this.#projectByThread = next;
    } catch {
      // ignore
    }
  }

  #saveProjectPaths() {
    try {
      const data: Record<string, string> = {};
      for (const [threadId, path] of this.#projectByThread) {
        data[threadId] = path;
      }
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }
}

function getStore(): ThreadsStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    const store = new ThreadsStore();
    global[STORE_KEY] = store;
    socket.onMessage((msg) => store.handleMessage(msg));
  }
  return global[STORE_KEY] as ThreadsStore;
}

export const threads = getStore();
