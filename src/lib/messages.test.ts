import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const STORE_KEY = "__codex_remote_messages_store__";

async function loadFreshMessagesModule() {
  const cacheBust = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return import(`./messages.svelte.ts?test=${cacheBust}`);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "$state", {
    value: <T>(value: T) => value,
    configurable: true,
    writable: true,
  });
  mock.module("./socket.svelte", () => ({
    socket: {
      onMessage: () => () => {},
      send: () => ({ success: true }),
    },
  }));
  mock.module("./threads.svelte", () => ({
    threads: {
      currentId: "thread-1",
    },
  }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY];
  delete (globalThis as Record<string, unknown>).$state;
  mock.restore();
});

describe("messages turn terminal handling", () => {
  test("marks turn as Interrupted on turn/cancelled", async () => {
    const { messages } = await loadFreshMessagesModule();
    messages.handleMessage({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "InProgress" } },
    });

    messages.handleMessage({
      method: "turn/cancelled",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "Cancelled" } },
    });

    expect(messages.getThreadTurnStatus("thread-1")).toBe("Interrupted");
  });

  test("marks turn as Failed on turn/failed", async () => {
    const { messages } = await loadFreshMessagesModule();
    messages.handleMessage({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "InProgress" } },
    });

    messages.handleMessage({
      method: "turn/failed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "Failed" } },
    });

    expect(messages.getThreadTurnStatus("thread-1")).toBe("Failed");
  });

  test("stores structured file-change metadata with line stats", async () => {
    const { messages } = await loadFreshMessagesModule();
    messages.handleMessage({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "file-1",
          type: "fileChange",
          changes: [
            {
              path: "src/app.ts",
              diff: [
                "@@ -1,2 +1,3 @@",
                "-const a = 1;",
                "+const a = 2;",
                "+const b = 3;",
              ].join("\n"),
            },
          ],
        },
      },
    });

    const fileMessage = messages.getThreadMessages("thread-1").find((item) => item.id === "file-1");
    expect(fileMessage?.kind).toBe("file");
    expect(fileMessage?.metadata?.linesAdded).toBe(2);
    expect(fileMessage?.metadata?.linesRemoved).toBe(1);
    expect(fileMessage?.metadata?.fileChanges?.[0]?.path).toBe("src/app.ts");
  });
});
