import type {
  ConnectionStatus,
  GitInspectResult,
  GitWorktreeCreateParams,
  GitWorktreeCreateResult,
  GitWorktreeListResult,
  OrbitArtifactsListResult,
  OrbitMultiDispatchPayload,
  ReleaseInspectResult,
  ReleaseStartParams,
  ReleaseStartResult,
  ReleaseStatusResult,
  RpcMessage,
} from "./types";
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;
const RECONNECT_DELAY = 2_000;
const RPC_TIMEOUT = 30_000;
const CLIENT_ID_KEY = "__codex_remote_client_id__";
const LOCAL_MODE_TOKEN = "local-mode";

function getClientId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fallback = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : fallback;
    window.sessionStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

function normalizeToken(token?: string | null): string | null {
  const value = token?.trim();
  if (!value || value === LOCAL_MODE_TOKEN) return null;
  return value;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

export interface ListDirsResult {
  dirs: string[];
  parent: string;
  current: string;
  roots?: string[];
}

export interface GitWorktreeRemoveResult {
  removed: boolean;
}

export interface GitWorktreePruneResult {
  prunedCount: number;
}

export interface CodexConfigReadResult {
  path: string;
  exists: boolean;
  content: string;
  candidates: string[];
  platform: string;
}

export interface CodexConfigWriteResult {
  saved: boolean;
  path: string;
  bytes: number;
}

export interface AnchorImageReadResult {
  path: string;
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

interface PendingRpcEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

class SocketStore {
  status = $state<ConnectionStatus>("disconnected");
  error = $state<string | null>(null);

  #socket: WebSocket | null = null;
  #url = "";
  #token: string | null = null;
  #messageHandlers = new Set<(msg: RpcMessage) => void>();
  #connectHandlers = new Set<() => void>();
  #protocolHandlers = new Set<(msg: Record<string, unknown>) => void>();
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #intentionalDisconnect = false;
  #subscribedThreads = new Set<string>();
  #rpcIdCounter = 0;
  #pendingRpc = new Map<number | string, PendingRpcEntry>();

  get url() {
    return this.#url;
  }

  get isHealthy() {
    return this.status === "connected" && this.#socket?.readyState === WebSocket.OPEN;
  }

  setAuthToken(token?: string | null) {
    this.#token = normalizeToken(token);
  }

  connect(url: string, token?: string | null) {
    this.#intentionalDisconnect = false;
    if (token !== undefined) {
      this.setAuthToken(token);
    }
    this.#connect(url);
  }

  #connect(url: string) {
    if (this.#socket) {
      this.#cleanup();
    }
    this.#clearReconnectTimeout();

    const trimmed = url.trim();
    if (!trimmed) {
      this.status = "error";
      this.error = "No server URL configured. Set one in Settings.";
      return;
    }

    this.#url = trimmed;
    this.status = "connecting";
    this.error = null;

    try {
      const wsUrl = new URL(trimmed);
      const urlToken = normalizeToken(wsUrl.searchParams.get("token"));
      const token = urlToken ?? this.#token;
      if (token) {
        wsUrl.searchParams.set("token", token);
      }
      const clientId = getClientId();
      if (clientId) {
        wsUrl.searchParams.set("clientId", clientId);
      }
      this.#socket = new WebSocket(wsUrl);
    } catch {
      this.status = "error";
      this.error = `Invalid URL: ${trimmed}`;
      return;
    }

    this.#socket.onopen = () => {
      this.status = "connected";
      this.error = null;
      this.#startHeartbeat();
      this.#resubscribeThreads();
      for (const handler of this.#connectHandlers) {
        handler();
      }
    };

    this.#socket.onclose = (event) => {
      this.#stopHeartbeat();
      this.#socket = null;

      if (this.#intentionalDisconnect) {
        this.status = "disconnected";
        return;
      }

      this.status = "reconnecting";
      this.error = event.reason || "Connection lost";
      this.#scheduleReconnect();
    };

    this.#socket.onerror = () => {
      if (this.status === "connecting") {
        this.error = "Failed to connect";
      }
    };

    this.#socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === "pong") {
          this.#clearHeartbeatTimeout();
          return;
        }

        const rpcKey = this.#extractRpcResponseKey(msg);
        if (rpcKey != null) {
          const pending = this.#consumePendingRpc(rpcKey);
          if (pending) {
            if (msg.error) {
              const errObj = msg.error as Record<string, unknown>;
              const errorMessage =
                typeof errObj.message === "string" && errObj.message.trim()
                  ? errObj.message
                  : "RPC error";
              pending.reject(new Error(errorMessage));
            } else {
              pending.resolve(msg.result !== undefined ? msg.result : msg);
            }
            return;
          }
        }

        // Handle orbit protocol messages
        if (typeof msg.type === "string" && msg.type.startsWith("orbit.")) {
          for (const handler of this.#protocolHandlers) {
            handler(msg);
          }
          return;
        }

        for (const handler of this.#messageHandlers) {
          handler(msg as RpcMessage);
        }
      } catch {
        console.error("Failed to parse message:", event.data);
      }
    };
  }

  disconnect() {
    this.#intentionalDisconnect = true;
    this.#subscribedThreads.clear();
    this.#cleanup();
    this.status = "disconnected";
    this.error = null;
  }

  send(message: RpcMessage): SendResult {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: "Not connected" };
    }

    try {
      this.#socket.send(JSON.stringify(message));
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Send failed" };
    }
  }

  onMessage(handler: (msg: RpcMessage) => void) {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onConnect(handler: () => void) {
    this.#connectHandlers.add(handler);
    if (this.status === "connected") handler();
    return () => this.#connectHandlers.delete(handler);
  }

  onProtocol(handler: (msg: Record<string, unknown>) => void) {
    this.#protocolHandlers.add(handler);
    return () => this.#protocolHandlers.delete(handler);
  }

  requestAnchors(): SendResult {
    return this.#sendRaw({ type: "orbit.list-anchors" });
  }

  artifactsList(threadId: string, anchorId?: string): Promise<OrbitArtifactsListResult> {
    return this.#requestOrbitControl<OrbitArtifactsListResult>(
      "orbit.artifacts.list",
      {
        threadId,
        ...(anchorId?.trim() ? { anchorId: anchorId.trim() } : {}),
      },
      "orbit-artifacts-list",
    );
  }

  multiDispatch(payload: OrbitMultiDispatchPayload): Promise<Record<string, unknown>> {
    return this.#requestOrbitControl<Record<string, unknown>>(
      "orbit.multi-dispatch",
      payload as unknown as Record<string, unknown>,
      "orbit-multi-dispatch",
    );
  }

  listDirs(path?: string, startPath?: string): Promise<ListDirsResult> {
    return this.#requestRpc<ListDirsResult>(
      "anchor.listDirs",
      { path: path ?? "", startPath: startPath ?? "" },
      "dir",
    );
  }

  gitInspect(path: string): Promise<GitInspectResult> {
    return this.#requestRpc<GitInspectResult>(
      "anchor.git.inspect",
      { path },
      "git-inspect",
    );
  }

  gitWorktreeList(repoRoot: string): Promise<GitWorktreeListResult> {
    return this.#requestRpc<GitWorktreeListResult>(
      "anchor.git.worktree.list",
      { repoRoot },
      "git-worktree-list",
    );
  }

  gitWorktreeCreate(params: GitWorktreeCreateParams): Promise<GitWorktreeCreateResult> {
    return this.#requestRpc<GitWorktreeCreateResult>(
      "anchor.git.worktree.create",
      params as unknown as Record<string, unknown>,
      "git-worktree-create",
    );
  }

  gitWorktreeRemove(repoRoot: string, path: string, force = false): Promise<GitWorktreeRemoveResult> {
    return this.#requestRpc<GitWorktreeRemoveResult>(
      "anchor.git.worktree.remove",
      { repoRoot, path, force },
      "git-worktree-remove",
    );
  }

  gitWorktreePrune(repoRoot: string): Promise<GitWorktreePruneResult> {
    return this.#requestRpc<GitWorktreePruneResult>(
      "anchor.git.worktree.prune",
      { repoRoot },
      "git-worktree-prune",
    );
  }

  reconnect() {
    if (this.status === "connected" || this.status === "connecting") return;
    this.#intentionalDisconnect = false;
    this.#clearReconnectTimeout();
    this.#connect(this.#url);
  }

  releaseInspect(params?: { repoPath?: string; targetRef?: string; tag?: string; anchorId?: string }): Promise<ReleaseInspectResult> {
    return this.#requestRpc<ReleaseInspectResult>(
      "anchor.release.inspect",
      {
        ...(params?.repoPath?.trim() ? { repoPath: params.repoPath.trim() } : {}),
        ...(params?.targetRef?.trim() ? { targetRef: params.targetRef.trim() } : {}),
        ...(params?.tag?.trim() ? { tag: params.tag.trim() } : {}),
        ...(params?.anchorId?.trim() ? { anchorId: params.anchorId.trim() } : {}),
      },
      "release-inspect",
    );
  }

  releaseStart(params: ReleaseStartParams): Promise<ReleaseStartResult> {
    return this.#requestRpc<ReleaseStartResult>(
      "anchor.release.start",
      {
        ...(params.repoPath?.trim() ? { repoPath: params.repoPath.trim() } : {}),
        ...(params.targetRef?.trim() ? { targetRef: params.targetRef.trim() } : {}),
        ...(params.tag?.trim() ? { tag: params.tag.trim() } : {}),
        ...(typeof params.dryRun === "boolean" ? { dryRun: params.dryRun } : {}),
        ...(params.anchorId?.trim() ? { anchorId: params.anchorId.trim() } : {}),
      },
      "release-start",
    );
  }

  releaseStatus(releaseId: string, anchorId?: string): Promise<ReleaseStatusResult> {
    return this.#requestRpc<ReleaseStatusResult>(
      "anchor.release.status",
      {
        releaseId,
        ...(anchorId?.trim() ? { anchorId: anchorId.trim() } : {}),
      },
      "release-status",
    );
  }

  readCodexConfig(path?: string, anchorId?: string): Promise<CodexConfigReadResult> {
    return this.#requestRpc<CodexConfigReadResult>(
      "anchor.config.read",
      {
        ...(path?.trim() ? { path: path.trim() } : {}),
        ...(anchorId?.trim() ? { anchorId: anchorId.trim() } : {}),
      },
      "codex-config-read",
    );
  }

  writeCodexConfig(content: string, path?: string, anchorId?: string): Promise<CodexConfigWriteResult> {
    return this.#requestRpc<CodexConfigWriteResult>(
      "anchor.config.write",
      {
        content,
        ...(path?.trim() ? { path: path.trim() } : {}),
        ...(anchorId?.trim() ? { anchorId: anchorId.trim() } : {}),
      },
      "codex-config-write",
    );
  }

  readImageAsset(path: string, anchorId?: string): Promise<AnchorImageReadResult> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return Promise.reject(new Error("path is required"));
    }

    return this.#requestRpc<AnchorImageReadResult>(
      "anchor.image.read",
      {
        path: normalizedPath,
        ...(anchorId?.trim() ? { anchorId: anchorId.trim() } : {}),
      },
      "anchor-image-read",
    );
  }

  subscribeThread(threadId: string): SendResult {
    this.#subscribedThreads.add(threadId);
    return this.#sendRaw({ type: "orbit.subscribe", threadId });
  }

  unsubscribeThread(threadId: string): SendResult {
    this.#subscribedThreads.delete(threadId);
    return this.#sendRaw({ type: "orbit.unsubscribe", threadId });
  }

  #requestRpc<T>(method: string, params: Record<string, unknown>, idPrefix: string): Promise<T> {
    const id = `${idPrefix}-${++this.#rpcIdCounter}`;
    return new Promise((resolve, reject) => {
      this.#registerPendingRpc(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const result = this.send({ id, method, params });
      if (!result.success) {
        this.#consumePendingRpc(id);
        reject(new Error(result.error ?? "Not connected"));
      }
    });
  }

  #requestOrbitControl<T>(type: string, payload: Record<string, unknown>, idPrefix: string): Promise<T> {
    const id = `${idPrefix}-${++this.#rpcIdCounter}`;
    return new Promise((resolve, reject) => {
      this.#registerPendingRpc(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const result = this.#sendRaw({
        type,
        id,
        ...payload,
      });
      if (!result.success) {
        this.#consumePendingRpc(id);
        reject(new Error(result.error ?? "Not connected"));
      }
    });
  }

  #registerPendingRpc(id: number | string, handlers: { resolve: (v: unknown) => void; reject: (e: Error) => void }) {
    const timeout = setTimeout(() => {
      const pending = this.#consumePendingRpc(id);
      if (!pending) return;
      pending.reject(new Error("RPC timeout"));
    }, RPC_TIMEOUT);

    this.#pendingRpc.set(id, {
      resolve: handlers.resolve,
      reject: handlers.reject,
      timeout,
    });
  }

  #consumePendingRpc(id: number | string): PendingRpcEntry | null {
    const pending = this.#pendingRpc.get(id) ?? null;
    if (!pending) return null;
    this.#pendingRpc.delete(id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    return pending;
  }

  #extractRpcResponseKey(message: Record<string, unknown>): string | number | null {
    const id = message.id;
    if (typeof id === "string" && id.trim()) return id;
    if (typeof id === "number" && Number.isFinite(id)) return id;

    const requestId = message.requestId ?? message.request_id;
    if (typeof requestId === "string" && requestId.trim()) return requestId;
    if (typeof requestId === "number" && Number.isFinite(requestId)) return requestId;
    return null;
  }

  #sendRaw(message: Record<string, unknown>): SendResult {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: "Not connected" };
    }

    try {
      this.#socket.send(JSON.stringify(message));
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Send failed" };
    }
  }

  #resubscribeThreads() {
    for (const threadId of this.#subscribedThreads) {
      this.#sendRaw({ type: "orbit.subscribe", threadId });
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatInterval = setInterval(() => {
      if (this.#socket?.readyState === WebSocket.OPEN) {
        try {
          this.#socket.send(JSON.stringify({ type: "ping" }));
          this.#heartbeatTimeout = setTimeout(() => {
            console.warn("Heartbeat timeout");
            this.#socket?.close();
          }, HEARTBEAT_TIMEOUT);
        } catch {
          this.#socket?.close();
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  #stopHeartbeat() {
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
    this.#clearHeartbeatTimeout();
  }

  #clearHeartbeatTimeout() {
    if (this.#heartbeatTimeout) {
      clearTimeout(this.#heartbeatTimeout);
      this.#heartbeatTimeout = null;
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimeout) return;
    this.#reconnectTimeout = setTimeout(() => {
      this.#reconnectTimeout = null;
      if (!this.#intentionalDisconnect) {
        this.#connect(this.#url);
      }
    }, RECONNECT_DELAY);
  }

  #clearReconnectTimeout() {
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }
  }

  #cleanup() {
    this.#clearReconnectTimeout();
    this.#stopHeartbeat();
    const pendingKeys = Array.from(this.#pendingRpc.keys());
    for (const key of pendingKeys) {
      const pending = this.#consumePendingRpc(key);
      if (pending) {
        pending.reject(new Error("Connection closed"));
      }
    }
    if (this.#socket) {
      this.#socket.onopen = null;
      this.#socket.onclose = null;
      this.#socket.onerror = null;
      this.#socket.onmessage = null;
      if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
        this.#socket.close();
      }
      this.#socket = null;
    }
  }
}

export const socket = new SocketStore();
