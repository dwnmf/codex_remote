import type { OrbitArtifact } from "./types";
import { socket } from "./socket.svelte";
import {
  extractArtifactIdsFromDispatch,
  extractMultiDispatchPayloads,
  normalizeArtifact,
  normalizeArtifactsListResult,
} from "./artifacts";

const STORE_KEY = "__codex_remote_artifacts_store__";

class ArtifactsStore {
  #byThread = $state<Map<string, OrbitArtifact[]>>(new Map());
  #loadingByThread = $state<Map<string, boolean>>(new Map());
  #errorByThread = $state<Map<string, string | null>>(new Map());
  #requestTokenByThread = new Map<string, number>();
  #requestCounter = 0;

  constructor() {
    socket.onProtocol((msg) => this.#handleProtocol(msg));
  }

  getThreadArtifacts(threadId: string | null): OrbitArtifact[] {
    if (!threadId) return [];
    return this.#byThread.get(threadId) ?? [];
  }

  getThreadLoading(threadId: string | null): boolean {
    if (!threadId) return false;
    return this.#loadingByThread.get(threadId) ?? false;
  }

  getThreadError(threadId: string | null): string | null {
    if (!threadId) return null;
    return this.#errorByThread.get(threadId) ?? null;
  }

  clearThread(threadId: string) {
    this.#byThread.delete(threadId);
    this.#loadingByThread.delete(threadId);
    this.#errorByThread.delete(threadId);
    this.#requestTokenByThread.delete(threadId);
    this.#byThread = new Map(this.#byThread);
    this.#loadingByThread = new Map(this.#loadingByThread);
    this.#errorByThread = new Map(this.#errorByThread);
  }

  async requestThread(threadId: string, anchorId?: string) {
    const normalized = threadId.trim();
    if (!normalized) return;

    const requestToken = ++this.#requestCounter;
    this.#requestTokenByThread.set(normalized, requestToken);
    this.#loadingByThread = new Map(this.#loadingByThread).set(normalized, true);
    this.#errorByThread = new Map(this.#errorByThread).set(normalized, null);

    try {
      const result = await socket.artifactsList(normalized, anchorId);
      if (this.#requestTokenByThread.get(normalized) !== requestToken) return;
      const normalizedList = normalizeArtifactsListResult(result, normalized);
      this.#byThread = new Map(this.#byThread).set(normalized, normalizedList.artifacts);
      this.#errorByThread = new Map(this.#errorByThread).set(normalized, null);
    } catch (err) {
      if (this.#requestTokenByThread.get(normalized) !== requestToken) return;
      const message = err instanceof Error ? err.message : "Failed to load artifacts";
      this.#errorByThread = new Map(this.#errorByThread).set(normalized, message);
    } finally {
      if (this.#requestTokenByThread.get(normalized) !== requestToken) return;
      this.#loadingByThread = new Map(this.#loadingByThread).set(normalized, false);
    }
  }

  #handleProtocol(message: Record<string, unknown>) {
    if (message.type === "orbit.multi-dispatch") {
      const payloads = extractMultiDispatchPayloads(message);
      for (const payload of payloads) {
        if (!payload.channel.toLowerCase().includes("artifact")) continue;
        this.#applyArtifactDispatch(payload);
      }
      return;
    }

    if (typeof message.type !== "string" || !message.type.toLowerCase().includes("artifact")) {
      return;
    }

    const threadId =
      (typeof message.threadId === "string" ? message.threadId : null) ??
      (typeof message.thread_id === "string" ? message.thread_id : null);
    if (!threadId) return;

    if (
      message.type === "orbit.artifact-removed" ||
      message.type === "orbit.artifacts-removed" ||
      message.type.endsWith(".removed")
    ) {
      const ids = extractArtifactIdsFromDispatch({
        channel: message.type,
        threadId,
        data: message,
      });
      if (ids.length > 0) {
        this.#removeArtifacts(threadId, ids);
      }
      return;
    }

    const candidates: unknown[] = [];
    if (message.artifact) candidates.push(message.artifact);
    if (message.item) candidates.push(message.item);
    if (Array.isArray(message.artifacts)) candidates.push(...message.artifacts);
    candidates.push(message);
    for (const candidate of candidates) {
      const normalized = normalizeArtifact(candidate, threadId);
      if (normalized) {
        this.#upsertArtifact(normalized);
      }
    }
  }

  #applyArtifactDispatch(payload: {
    channel: string;
    threadId?: string;
    event?: string;
    data: Record<string, unknown>;
  }) {
    const fallbackThreadId = payload.threadId;
    const channel = payload.channel.toLowerCase();
    const event = payload.event?.toLowerCase() ?? "";
    const isRemoval =
      event.includes("remove") ||
      event.includes("delete") ||
      channel.includes("remove") ||
      channel.includes("delete");

    if (isRemoval && fallbackThreadId) {
      const ids = extractArtifactIdsFromDispatch({
        channel: payload.channel,
        threadId: fallbackThreadId,
        data: payload.data,
      });
      if (ids.length > 0) {
        this.#removeArtifacts(fallbackThreadId, ids);
      }
      return;
    }

    const candidates: unknown[] = [];
    if (payload.data.artifact) candidates.push(payload.data.artifact);
    if (payload.data.item) candidates.push(payload.data.item);
    if (Array.isArray(payload.data.artifacts)) candidates.push(...payload.data.artifacts);
    if (Array.isArray(payload.data.items)) candidates.push(...payload.data.items);
    candidates.push(payload.data);

    for (const candidate of candidates) {
      const normalized = normalizeArtifact(candidate, fallbackThreadId);
      if (normalized) {
        this.#upsertArtifact(normalized);
      }
    }
  }

  #upsertArtifact(artifact: OrbitArtifact) {
    const existing = this.#byThread.get(artifact.threadId) ?? [];
    const index = existing.findIndex((item) => item.id === artifact.id);
    const next = [...existing];
    if (index >= 0) next[index] = artifact;
    else next.push(artifact);
    next.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    this.#byThread = new Map(this.#byThread).set(artifact.threadId, next);
    this.#errorByThread = new Map(this.#errorByThread).set(artifact.threadId, null);
  }

  #removeArtifacts(threadId: string, artifactIds: string[]) {
    if (artifactIds.length === 0) return;
    const idSet = new Set(artifactIds);
    const existing = this.#byThread.get(threadId) ?? [];
    const filtered = existing.filter((artifact) => !idSet.has(artifact.id));
    this.#byThread = new Map(this.#byThread).set(threadId, filtered);
  }
}

function getStore(): ArtifactsStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new ArtifactsStore();
  }
  return global[STORE_KEY] as ArtifactsStore;
}

export const artifacts = getStore();
