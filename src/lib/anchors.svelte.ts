import { socket } from "./socket.svelte";

const STORE_KEY = "__codex_remote_anchors_store__";
const SELECTED_STORAGE_KEY = "codex_remote_selected_anchor_id";
const ANCHOR_CHECK_TIMEOUT_MS = 5_000;

export interface AnchorInfo {
  id: string;
  hostname: string;
  platform: string;
  connectedAt: string;
}

type AnchorStatus = "unknown" | "checking" | "connected" | "none";

class AnchorsStore {
  list = $state<AnchorInfo[]>([]);
  status = $state<AnchorStatus>("unknown");
  selectedId = $state<string | null>(null);
  #checkTimeout: ReturnType<typeof setTimeout> | null = null;
  #selectionHandlers = new Set<(anchorId: string | null) => void>();

  constructor() {
    if (typeof window === "undefined") return;
    this.#loadSelection();
    this.#wire();
  }

  #wire() {
    if (socket.isHealthy) {
      this.request();
    }

    socket.onConnect(() => {
      this.request();
    });

    socket.onProtocol((msg) => {
      if (msg.type === "orbit.anchors") {
        this.list = (msg.anchors as AnchorInfo[]) ?? [];
        this.status = this.list.length ? "connected" : "none";
        this.#reconcileSelection();
        this.#clearTimeout();
      } else if (msg.type === "orbit.anchor-connected") {
        const anchor = msg.anchor as AnchorInfo;
        if (!this.list.some((a) => a.id === anchor.id)) {
          this.list = [...this.list, anchor];
        }
        this.status = "connected";
        this.#reconcileSelection();
        this.#clearTimeout();
      } else if (msg.type === "orbit.anchor-disconnected") {
        this.list = this.list.filter((a) => a.id !== (msg.anchorId as string));
        this.status = this.list.length ? "connected" : "none";
        this.#reconcileSelection();
      }
    });
  }

  request() {
    if (!socket.isHealthy) {
      this.status = "unknown";
      return;
    }
    this.status = "checking";
    this.#armTimeout();
    socket.requestAnchors();
  }

  get selected(): AnchorInfo | null {
    if (!this.selectedId) return null;
    return this.list.find((anchor) => anchor.id === this.selectedId) ?? null;
  }

  select(anchorId: string | null) {
    this.#setSelectedId(anchorId, true);
  }

  onSelectionChange(handler: (anchorId: string | null) => void) {
    this.#selectionHandlers.add(handler);
    handler(this.selectedId);
    return () => this.#selectionHandlers.delete(handler);
  }

  #armTimeout() {
    this.#clearTimeout();
    this.#checkTimeout = setTimeout(() => {
      this.#checkTimeout = null;
      if (this.status !== "checking") return;
      this.list = [];
      this.status = "none";
      this.#reconcileSelection();
    }, ANCHOR_CHECK_TIMEOUT_MS);
  }

  #clearTimeout() {
    if (this.#checkTimeout) {
      clearTimeout(this.#checkTimeout);
      this.#checkTimeout = null;
    }
  }

  #reconcileSelection() {
    if (this.selectedId && this.list.some((anchor) => anchor.id === this.selectedId)) {
      return;
    }

    if (this.list.length === 1) {
      this.#setSelectedId(this.list[0].id, true);
      return;
    }

    if (this.selectedId) {
      this.#setSelectedId(null, true);
    }
  }

  #loadSelection() {
    try {
      const value = localStorage.getItem(SELECTED_STORAGE_KEY);
      this.selectedId = value ? value : null;
    } catch {
      this.selectedId = null;
    }
  }

  #setSelectedId(anchorId: string | null, persist: boolean) {
    const normalized = anchorId?.trim() ? anchorId.trim() : null;
    if (this.selectedId === normalized) return;
    this.selectedId = normalized;
    if (persist) {
      this.#saveSelection();
    }
    this.#notifySelectionChange();
  }

  #notifySelectionChange() {
    for (const handler of this.#selectionHandlers) {
      handler(this.selectedId);
    }
  }

  #saveSelection() {
    try {
      if (this.selectedId) {
        localStorage.setItem(SELECTED_STORAGE_KEY, this.selectedId);
      } else {
        localStorage.removeItem(SELECTED_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }
}

function getStore(): AnchorsStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new AnchorsStore();
  }
  return global[STORE_KEY] as AnchorsStore;
}

export const anchors = getStore();
