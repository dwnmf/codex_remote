import { describe, expect, test } from "bun:test";

import type { Env } from "../types";
import { OrbitRelay } from "./orbit-relay-do";

class MockStorage {
  data = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const prefix = options?.prefix ?? "";
    for (const [key, value] of this.data.entries()) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.set(key, value as T);
    }
    return out;
  }
}

class FakeSocket {
  sent: string[] = [];

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new TextDecoder().decode(data));
      return;
    }
    this.sent.push(new TextDecoder().decode(data));
  }

  addEventListener(): void {
    // no-op for tests
  }

  close(): void {
    // no-op for tests
  }
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    ORBIT_DO: {} as DurableObjectNamespace,
    PASSKEY_CHALLENGE_DO: {} as DurableObjectNamespace,
  };
}

function createRelayWithStorage(storage: MockStorage): OrbitRelay {
  const state = {
    storage,
    blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T> {
      return cb();
    },
  } as unknown as DurableObjectState;

  return new OrbitRelay(state, createEnv());
}

function parseSent(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe("orbit relay routing", () => {
  test("replays persisted thread state on client subscribe", async () => {
    const storage = new MockStorage();
    storage.data.set("relay:thread:thread-1", {
      threadId: "thread-1",
      anchorId: "anchor-1",
      turn: {
        id: "turn-1",
        status: "InProgress",
        updatedAt: new Date().toISOString(),
      },
      recentMessages: [
        JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "hello" } }),
      ],
      artifacts: [],
      updatedAt: new Date().toISOString(),
    });

    const relay = createRelayWithStorage(storage);
    await (relay as unknown as { storageReady: Promise<void> }).storageReady;

    const client = new FakeSocket();
    const relayAny = relay as unknown as {
      clientSockets: Map<WebSocket, Set<string>>;
      handleSubscription: (socket: WebSocket, role: "client" | "anchor", msg: Record<string, unknown>) => boolean;
    };

    relayAny.clientSockets.set(client as unknown as WebSocket, new Set());

    const handled = relayAny.handleSubscription(client as unknown as WebSocket, "client", {
      type: "orbit.subscribe",
      threadId: "thread-1",
    });

    expect(handled).toBe(true);
    const payloads = parseSent(client);
    expect(payloads[0]?.type).toBe("orbit.subscribed");
    expect(payloads[1]?.method).toBe("turn/started");
    expect(payloads[2]?.method).toBe("item/agentMessage/delta");
  });

  test("returns artifacts via orbit.artifacts.list", async () => {
    const relay = createRelayWithStorage(new MockStorage());
    await (relay as unknown as { storageReady: Promise<void> }).storageReady;

    const relayAny = relay as unknown as {
      threadStateById: Map<string, unknown>;
      handleSubscription: (socket: WebSocket, role: "client" | "anchor", msg: Record<string, unknown>) => boolean;
      clientSockets: Map<WebSocket, Set<string>>;
    };

    relayAny.threadStateById.set("thread-9", {
      threadId: "thread-9",
      anchorId: "anchor-9",
      turn: { id: "turn-9", status: "Completed", updatedAt: new Date().toISOString() },
      recentMessages: [],
      artifacts: [{ id: "thread-9:item-1", itemId: "item-1", threadId: "thread-9", type: "fileChange", createdAt: new Date().toISOString(), payload: { path: "a.ts" } }],
      updatedAt: new Date().toISOString(),
    });

    const client = new FakeSocket();
    relayAny.clientSockets.set(client as unknown as WebSocket, new Set());

    const handled = relayAny.handleSubscription(client as unknown as WebSocket, "client", {
      type: "orbit.artifacts.list",
      id: "art-1",
      threadId: "thread-9",
    });

    expect(handled).toBe(true);
    const payload = parseSent(client)[0];
    expect(payload?.type).toBe("orbit.artifacts");
    expect(payload?.id).toBe("art-1");
    expect((payload?.artifacts as unknown[])?.length).toBe(1);
  });

  test("aggregates multi-dispatch child responses", async () => {
    const relay = createRelayWithStorage(new MockStorage());
    await (relay as unknown as { storageReady: Promise<void> }).storageReady;

    const relayAny = relay as unknown as {
      handleSubscription: (socket: WebSocket, role: "client" | "anchor", msg: Record<string, unknown>) => boolean;
      routeMessage: (
        socket: WebSocket,
        role: "client" | "anchor",
        data: string,
        payloadStr: string,
        msg: Record<string, unknown>,
      ) => void;
      anchorIdToSocket: Map<string, WebSocket>;
      socketToAnchorId: Map<WebSocket, string>;
      clientSockets: Map<WebSocket, Set<string>>;
    };

    const client = new FakeSocket();
    const anchorA = new FakeSocket();
    const anchorB = new FakeSocket();

    relayAny.clientSockets.set(client as unknown as WebSocket, new Set());
    relayAny.anchorIdToSocket.set("anchor-a", anchorA as unknown as WebSocket);
    relayAny.anchorIdToSocket.set("anchor-b", anchorB as unknown as WebSocket);
    relayAny.socketToAnchorId.set(anchorA as unknown as WebSocket, "anchor-a");
    relayAny.socketToAnchorId.set(anchorB as unknown as WebSocket, "anchor-b");

    const handled = relayAny.handleSubscription(client as unknown as WebSocket, "client", {
      type: "orbit.multi-dispatch",
      id: "multi-1",
      anchorIds: ["anchor-a", "anchor-b"],
      request: {
        method: "anchor.echo",
        params: { threadId: "thread-1", value: 1 },
      },
    });
    expect(handled).toBe(true);

    const childRequestA = parseSent(anchorA)[0];
    const childRequestB = parseSent(anchorB)[0];
    expect(childRequestA?.method).toBe("anchor.echo");
    expect(childRequestB?.method).toBe("anchor.echo");

    const childResponseA = { id: childRequestA?.id, result: { ok: true } };
    relayAny.routeMessage(
      anchorA as unknown as WebSocket,
      "anchor",
      JSON.stringify(childResponseA),
      JSON.stringify(childResponseA),
      childResponseA,
    );

    const childResponseB = { id: childRequestB?.id, error: { code: -1, message: "boom" } };
    relayAny.routeMessage(
      anchorB as unknown as WebSocket,
      "anchor",
      JSON.stringify(childResponseB),
      JSON.stringify(childResponseB),
      childResponseB,
    );

    const clientPayloads = parseSent(client);
    const result = clientPayloads.find((entry) => entry.type === "orbit.multi-dispatch.result");
    expect(result).toBeDefined();
    expect(result?.id).toBe("multi-1");
    expect((result?.summary as { total: number })?.total).toBe(2);
    expect((result?.summary as { ok: number })?.ok).toBe(1);
    expect((result?.summary as { failed: number })?.failed).toBe(1);
  });
});
