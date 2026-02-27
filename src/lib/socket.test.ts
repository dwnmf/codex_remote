import { afterEach, beforeEach, describe, expect, test } from "bun:test";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason: "" });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function loadFreshSocketModule() {
  const cacheBust = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return import(`./socket.svelte.ts?test=${cacheBust}`);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "$state", {
    value: <T>(value: T) => value,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).$state;
  delete (globalThis as Record<string, unknown>).WebSocket;
});

describe("socket orbit handlers", () => {
  test("forwards orbit protocol messages to protocol listeners", async () => {
    const { socket } = await loadFreshSocketModule();
    const received: Array<Record<string, unknown>> = [];
    socket.onProtocol((msg) => received.push(msg));

    socket.connect("ws://localhost:8788/ws/client");
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.emitMessage({
      type: "orbit.multi-dispatch",
      dispatches: [],
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("orbit.multi-dispatch");
    socket.disconnect();
  });
});

describe("socket rpc helpers", () => {
  test("sends orbit.artifacts.list and resolves response", async () => {
    const { socket } = await loadFreshSocketModule();
    socket.connect("ws://localhost:8788/ws/client");
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const promise = socket.artifactsList("thread-1");
    const request = JSON.parse(ws.sent[0]) as { id: string; method: string; params: Record<string, unknown> };

    expect(request.method).toBe("orbit.artifacts.list");
    expect(request.params.threadId).toBe("thread-1");

    ws.emitMessage({
      type: "orbit.artifacts",
      requestId: request.id,
      artifacts: [
        {
          id: "artifact-1",
          threadId: "thread-1",
          type: "bundle",
          title: "Build",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await promise;
    expect(result.artifacts[0].id).toBe("artifact-1");
    socket.disconnect();
  });

  test("resolves orbit RPC responses by requestId payloads", async () => {
    const { socket } = await loadFreshSocketModule();
    socket.connect("ws://localhost:8788/ws/client");
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const promise = socket.artifactsList("thread-2");
    const request = JSON.parse(ws.sent[0]) as { id: string };

    ws.emitMessage({
      type: "orbit.artifacts",
      requestId: request.id,
      artifacts: [
        {
          id: "artifact-2",
          threadId: "thread-2",
          type: "file",
          title: "Patch",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await promise;
    expect(result.artifacts[0].id).toBe("artifact-2");
    socket.disconnect();
  });

  test("sends release inspect/start/status RPC methods", async () => {
    const { socket } = await loadFreshSocketModule();
    socket.connect("ws://localhost:8788/ws/client");
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const inspectPromise = socket.releaseInspect({ repoPath: "/repo", targetRef: "main", tag: "v1.0.0" });
    const inspectRequest = JSON.parse(ws.sent[0]) as { id: string; method: string };
    expect(inspectRequest.method).toBe("anchor.release.inspect");
    ws.emitMessage({ id: inspectRequest.id, result: { ready: true, checks: [] } });
    await inspectPromise;

    const startPromise = socket.releaseStart({ repoPath: "/repo", tag: "v1.0.0" });
    const startRequest = JSON.parse(ws.sent[1]) as { id: string; method: string };
    expect(startRequest.method).toBe("anchor.release.start");
    ws.emitMessage({ id: startRequest.id, result: { releaseId: "release-1", status: "queued" } });
    await startPromise;

    const statusPromise = socket.releaseStatus("release-1");
    const statusRequest = JSON.parse(ws.sent[2]) as { id: string; method: string };
    expect(statusRequest.method).toBe("anchor.release.status");
    ws.emitMessage({ id: statusRequest.id, result: { releaseId: "release-1", status: "running", logs: [], assets: [], links: [] } });
    const status = await statusPromise;
    expect(status.releaseId).toBe("release-1");
    socket.disconnect();
  });
});
