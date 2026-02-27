import type { ReleaseInspectResult, ReleaseStartParams, ReleaseStatusResult } from "./types";
import { socket } from "./socket.svelte";
import { extractMultiDispatchPayloads } from "./artifacts";
import {
  isReleaseTerminalStatus,
  mergeReleaseStatus,
  normalizeReleaseInspectResult,
  normalizeReleaseStartResult,
  normalizeReleaseStatusResult,
} from "./release-cockpit";

const STORE_KEY = "__codex_remote_release_cockpit_store__";
const POLL_INTERVAL_MS = 2_500;

class ReleaseCockpitStore {
  inspect = $state<ReleaseInspectResult | null>(null);
  status = $state<ReleaseStatusResult | null>(null);
  releaseId = $state<string | null>(null);
  inspectLoading = $state(false);
  startLoading = $state(false);
  statusLoading = $state(false);
  polling = $state(false);
  error = $state<string | null>(null);
  info = $state<string | null>(null);

  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #pollAnchorId: string | undefined;

  constructor() {
    socket.onProtocol((message) => this.#handleProtocol(message));
  }

  clear() {
    this.stopPolling();
    this.inspect = null;
    this.status = null;
    this.releaseId = null;
    this.error = null;
    this.info = null;
  }

  async inspectRelease(params?: {
    repoPath?: string;
    targetRef?: string;
    tag?: string;
    anchorId?: string;
  }) {
    this.inspectLoading = true;
    this.error = null;
    this.info = null;
    try {
      const result = await socket.releaseInspect(params);
      this.inspect = normalizeReleaseInspectResult(result);
      this.info = this.inspect.ready ? "Release checks passed." : "Release checks require attention.";
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to inspect release readiness";
    } finally {
      this.inspectLoading = false;
    }
  }

  async startRelease(params: ReleaseStartParams) {
    this.startLoading = true;
    this.error = null;
    this.info = null;
    this.stopPolling();
    try {
      const result = await socket.releaseStart(params);
      const startResult = normalizeReleaseStartResult(result);
      this.releaseId = startResult.releaseId;
      this.status = {
        releaseId: startResult.releaseId,
        status: startResult.status,
        logs: startResult.message
          ? [
            {
              id: `start-${Date.now()}`,
              ts: new Date().toISOString(),
              level: "info",
              message: startResult.message,
            },
          ]
          : [],
        assets: [],
        links: [],
      };
      this.info = `Release started (${startResult.releaseId}).`;
      await this.pollStatus(params.anchorId);
      if (!isReleaseTerminalStatus(this.status?.status)) {
        this.startPolling(params.anchorId);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to start release";
    } finally {
      this.startLoading = false;
    }
  }

  async pollStatus(anchorId?: string) {
    if (!this.releaseId) return;
    this.statusLoading = true;
    if (anchorId !== undefined) {
      this.#pollAnchorId = anchorId;
    }
    try {
      const result = await socket.releaseStatus(this.releaseId, anchorId);
      const normalized = normalizeReleaseStatusResult(result, this.releaseId);
      if (!normalized.releaseId) {
        normalized.releaseId = this.releaseId;
      }
      this.status = mergeReleaseStatus(this.status, normalized);
      this.releaseId = this.status.releaseId;
      if (this.status.error) {
        this.error = this.status.error;
      }
      if (isReleaseTerminalStatus(this.status.status)) {
        this.stopPolling();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to load release status";
    } finally {
      this.statusLoading = false;
    }
  }

  startPolling(anchorId?: string) {
    if (!this.releaseId) return;
    if (anchorId !== undefined) {
      this.#pollAnchorId = anchorId;
    }
    this.polling = true;
    this.#scheduleNextPoll(0);
  }

  stopPolling() {
    this.polling = false;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #scheduleNextPoll(delayMs = POLL_INTERVAL_MS) {
    if (!this.polling) return;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#pollTimer = setTimeout(async () => {
      this.#pollTimer = null;
      if (!this.polling) return;
      await this.pollStatus(this.#pollAnchorId);
      if (!this.polling) return;
      if (isReleaseTerminalStatus(this.status?.status)) {
        this.stopPolling();
        return;
      }
      this.#scheduleNextPoll(POLL_INTERVAL_MS);
    }, delayMs);
  }

  #handleProtocol(message: Record<string, unknown>) {
    if (message.type !== "orbit.multi-dispatch") return;
    const payloads = extractMultiDispatchPayloads(message);
    for (const payload of payloads) {
      if (!payload.channel.toLowerCase().includes("release")) continue;
      const fallbackReleaseId = payload.releaseId ?? this.releaseId ?? undefined;
      const normalized = normalizeReleaseStatusResult(payload.data, fallbackReleaseId);
      if (!normalized.releaseId) continue;
      if (this.releaseId && normalized.releaseId !== this.releaseId) continue;

      this.releaseId = normalized.releaseId;
      this.status = mergeReleaseStatus(this.status, normalized);
      if (this.status?.error) {
        this.error = this.status.error;
      } else if (this.error) {
        this.error = null;
      }
      if (isReleaseTerminalStatus(this.status?.status)) {
        this.stopPolling();
      }
    }
  }
}

function getStore(): ReleaseCockpitStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new ReleaseCockpitStore();
  }
  return global[STORE_KEY] as ReleaseCockpitStore;
}

export const releaseCockpit = getStore();
