import { beforeEach, describe, expect, mock, test } from "bun:test";

const STORE_KEY = "__codex_remote_connection_manager__";

const authMock: { status: string; token: string | null } = {
  status: "signed_in",
  token: "token-123",
};

const configMock = {
  url: "ws://localhost:8788/ws/client",
};

const socketConnectMock = mock((url: string, token: string) => {
  void url;
  void token;
});

const socketDisconnectMock = mock(() => {
  socketMock.status = "disconnected";
});

const socketMock: {
  status: string;
  connect: (url: string, token: string) => void;
  disconnect: () => void;
} = {
  status: "disconnected",
  connect: socketConnectMock,
  disconnect: socketDisconnectMock,
};

mock.module("./auth.svelte", () => ({ auth: authMock }));
mock.module("./config.svelte", () => ({ config: configMock }));
mock.module("./socket.svelte", () => ({ socket: socketMock }));

function installControlledTimers(options?: { allowCancelledExecution?: boolean }) {
  const allowCancelledExecution = options?.allowCancelledExecution ?? false;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  type TimeoutEntry = {
    id: number;
    fn: () => void;
    cancelled: boolean;
  };

  const timers = new Map<number, TimeoutEntry>();
  let nextId = 1;

  globalThis.setTimeout = ((handler: TimerHandler) => {
    const id = nextId++;
    const fn = typeof handler === "function" ? () => handler() : () => {};
    timers.set(id, { id, fn, cancelled: false });
    return id as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const numericId = Number(id);
    const entry = timers.get(numericId);
    if (entry) {
      entry.cancelled = true;
    }
  }) as typeof clearTimeout;

  return {
    runAll() {
      const entries = Array.from(timers.values());
      timers.clear();
      for (const entry of entries) {
        if (!entry.cancelled || allowCancelledExecution) {
          entry.fn();
        }
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function loadFreshConnectionManager() {
  delete (globalThis as Record<string, unknown>)[STORE_KEY];
  const cacheBust = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const module = await import(`./connection-manager.svelte.ts?test=${cacheBust}`);
  return module.connectionManager;
}

describe("connectionManager", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    delete (globalThis as Record<string, unknown>)[STORE_KEY];
    authMock.status = "signed_in";
    authMock.token = "token-123";
    configMock.url = "ws://localhost:8788/ws/client";
    socketMock.status = "disconnected";
  });

  test("connects after the debounced timer fires", async () => {
    const timers = installControlledTimers();

    try {
      const connectionManager = await loadFreshConnectionManager();

      connectionManager.requestConnect();
      timers.runAll();

      expect(socketConnectMock).toHaveBeenCalledTimes(1);
      expect(socketConnectMock).toHaveBeenCalledWith("ws://localhost:8788/ws/client", "token-123");
    } finally {
      timers.restore();
    }
  });

  test("does not connect if disconnect pauses manager before a queued timer callback runs", async () => {
    const timers = installControlledTimers({ allowCancelledExecution: true });

    try {
      const connectionManager = await loadFreshConnectionManager();

      connectionManager.requestConnect();
      connectionManager.requestDisconnect();

      timers.runAll();

      expect(socketDisconnectMock).toHaveBeenCalledTimes(1);
      expect(socketConnectMock).toHaveBeenCalledTimes(0);
    } finally {
      timers.restore();
    }
  });
});
