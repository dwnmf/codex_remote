import { afterEach, describe, expect, mock, test, vi } from "bun:test";

const STORE_KEY = "__codex_remote_anchors_store__";
const SELECTED_STORAGE_KEY = "codex_remote_selected_anchor_id";
const ANCHOR_CHECK_TIMEOUT_MS = 5_000;

function createLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function resetAnchorsStoreSingleton() {
  const global = globalThis as Record<string, unknown>;
  delete global[STORE_KEY];
}

afterEach(() => {
  vi.useRealTimers();
  mock.restore();
  resetAnchorsStoreSingleton();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).$state;
});

describe("anchors timeout reconciliation", () => {
  test("clears stale list and stale selection when a request times out", async () => {
    vi.useFakeTimers();

    const protocolHandlers: Array<(msg: Record<string, unknown>) => void> = [];
    const socket = {
      isHealthy: true,
      requestAnchors: vi.fn(),
      onConnect(_handler: () => void) {
        return () => {};
      },
      onProtocol(handler: (msg: Record<string, unknown>) => void) {
        protocolHandlers.push(handler);
        return () => {};
      },
    };

    const storage = createLocalStorage();
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "$state", { value: <T>(value: T) => value, configurable: true, writable: true });

    resetAnchorsStoreSingleton();
    mock.module("./socket.svelte", () => ({ socket }));
    const { anchors } = await import("./anchors.svelte.ts");

    expect(socket.requestAnchors).toHaveBeenCalledTimes(1);
    expect(protocolHandlers).toHaveLength(1);

    protocolHandlers[0]({
      type: "orbit.anchors",
      anchors: [
        {
          id: "anchor-1",
          hostname: "laptop",
          platform: "linux",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(anchors.list.map((anchor) => anchor.id)).toEqual(["anchor-1"]);
    expect(anchors.selectedId).toBe("anchor-1");
    expect(storage.getItem(SELECTED_STORAGE_KEY)).toBe("anchor-1");

    anchors.request();
    expect(anchors.status).toBe("checking");
    expect(socket.requestAnchors).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(ANCHOR_CHECK_TIMEOUT_MS);

    expect(anchors.status).toBe("none");
    expect(anchors.list).toEqual([]);
    expect(anchors.selectedId).toBeNull();
    expect(storage.getItem(SELECTED_STORAGE_KEY)).toBeNull();
  });
});
