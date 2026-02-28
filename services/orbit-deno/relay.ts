import {
  applyThreadStateMutation,
  buildMultiDispatchAggregate,
  buildThreadStateMutationFromMessage,
  createEmptyThreadState,
  parseMultiDispatchRequest,
  type MultiDispatchResultEntry,
  type RelayThreadState,
} from "./orbit-relay-state.ts";
import { asRecord, extractAnchorId, extractThreadId, parseJsonMessage } from "../orbit/src/utils/protocol.ts";

import type { Role } from "./types.ts";
import { randomId } from "./utils.ts";

interface AnchorMeta {
  id: string;
  hostname: string;
  platform: string;
  connectedAt: string;
}

interface PendingMultiDispatchChild {
  parentKey: string;
  anchorId: string;
  childId: string | number;
}

interface PendingMultiDispatch {
  clientSocket: WebSocket;
  requestId: string | number | null;
  threadId: string | null;
  results: MultiDispatchResultEntry[];
  pendingRouteKeys: Set<string>;
  timeoutHandle: number | null;
}

interface RouteFailure {
  code: string;
  message: string;
}

const MULTI_DISPATCH_TIMEOUT_MS = 20_000;
const MAX_STORED_THREADS = 200;

export class RelayHub {
  private clientSockets = new Map<WebSocket, Set<string>>();
  private anchorSockets = new Map<WebSocket, Set<string>>();
  private threadToClients = new Map<string, Set<WebSocket>>();
  private threadToAnchors = new Map<string, Set<WebSocket>>();
  private threadToAnchorId = new Map<string, string>();
  private anchorMeta = new Map<WebSocket, AnchorMeta>();
  private anchorIdToSocket = new Map<string, WebSocket>();
  private socketToAnchorId = new Map<WebSocket, string>();
  private clientIdToSocket = new Map<string, WebSocket>();
  private socketToClientId = new Map<WebSocket, string>();
  private socketIds = new WeakMap<WebSocket, string>();
  private pendingClientRequests = new Map<string, WebSocket>();
  private pendingAnchorRequests = new Map<string, WebSocket>();
  private pendingMultiDispatch = new Map<string, PendingMultiDispatch>();
  private pendingMultiDispatchByChildRoute = new Map<string, PendingMultiDispatchChild>();
  private threadStateById = new Map<string, RelayThreadState>();
  private multiDispatchSeq = 0;

  constructor(private readonly userId: string) {}

  registerSocket(socket: WebSocket, role: Role, clientId: string | null): void {
    if (role === "client") {
      if (clientId) {
        const existing = this.clientIdToSocket.get(clientId);
        if (existing && existing !== socket) {
          this.removeSocket(existing, "client");
          try {
            existing.close(1000, "Replaced by newer connection");
          } catch {
            // ignore
          }
        }
        this.clientIdToSocket.set(clientId, socket);
        this.socketToClientId.set(socket, clientId);
      }
      this.clientSockets.set(socket, new Set());
    } else {
      this.anchorSockets.set(socket, new Set());
    }

    this.sendJson(socket, {
      type: "orbit.hello",
      role,
      ts: new Date().toISOString(),
    });

    socket.addEventListener("message", (event) => {
      const raw = this.eventDataToString(event.data);
      if (!raw) return;
      this.handleMessage(socket, role, raw);
    });
  }

  private eventDataToString(data: string | ArrayBuffer | Blob): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(data));
    }
    return null;
  }

  private getSocketId(socket: WebSocket): string {
    const existing = this.socketIds.get(socket);
    if (existing) return existing;
    const next = randomId(8);
    this.socketIds.set(socket, next);
    return next;
  }

  private routeKey(socket: WebSocket, id: string | number): string {
    return `${this.getSocketId(socket)}:${String(id)}`;
  }

  private userThreadKey(threadId: string): string {
    return `${this.userId}:${threadId}`;
  }

  private sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  private sendRaw(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(payload);
    } catch {
      // ignore
    }
  }

  private listUserAnchors(): AnchorMeta[] {
    const anchors: AnchorMeta[] = [];
    for (const [socket, meta] of this.anchorMeta.entries()) {
      if (!this.anchorSockets.has(socket)) continue;
      anchors.push(meta);
    }
    return anchors;
  }

  private sendRpcError(socket: WebSocket, requestId: string | number | null, failure: RouteFailure | null): void {
    if (requestId === null || !failure) return;
    this.sendJson(socket, {
      id: requestId,
      error: {
        code: -32001,
        message: failure.message,
        data: { code: failure.code },
      },
    });
  }

  private resolveClientTarget(threadId: string | null, anchorId: string | null): { target: WebSocket | null; failure: RouteFailure | null } {
    if (anchorId) {
      const target = this.anchorIdToSocket.get(`${this.userId}:${anchorId}`);
      if (!target) {
        return { target: null, failure: { code: "anchor_not_found", message: "Selected device is unavailable." } };
      }

      if (threadId) {
        const bound = this.threadToAnchorId.get(this.userThreadKey(threadId));
        if (bound && bound !== anchorId) {
          return { target: null, failure: { code: "thread_anchor_mismatch", message: "Thread is attached to another device." } };
        }
      }
      return { target, failure: null };
    }

    if (threadId) {
      const boundAnchorId = this.threadToAnchorId.get(this.userThreadKey(threadId));
      if (boundAnchorId) {
        const target = this.anchorIdToSocket.get(`${this.userId}:${boundAnchorId}`);
        if (target) return { target, failure: null };
        return { target: null, failure: { code: "anchor_offline", message: "Device for this thread is offline." } };
      }

      const subscribed = Array.from(this.threadToAnchors.get(this.userThreadKey(threadId)) ?? []);
      if (subscribed.length === 1) {
        return { target: subscribed[0], failure: null };
      }
      if (subscribed.length > 1) {
        return { target: null, failure: { code: "thread_anchor_mismatch", message: "Thread is attached to multiple devices." } };
      }
    }

    const anchors = Array.from(this.anchorSockets.keys());
    if (anchors.length === 1) {
      return { target: anchors[0], failure: null };
    }
    if (anchors.length === 0) {
      return { target: null, failure: { code: "anchor_offline", message: "No devices are connected." } };
    }
    return { target: null, failure: { code: "anchor_required", message: "Select a device before starting a request." } };
  }

  handleMessage(socket: WebSocket, role: Role, raw: string): void {
    const parsed = parseJsonMessage(raw);

    if (parsed?.type === "ping") {
      this.sendJson(socket, { type: "pong" });
      return;
    }

    if (this.handleControl(socket, role, parsed)) {
      return;
    }

    if (this.handleAnchorHello(socket, role, parsed)) {
      return;
    }

    this.routeMessage(socket, role, raw, parsed);
  }

  private handleControl(socket: WebSocket, role: Role, parsed: Record<string, unknown> | null): boolean {
    if (!parsed) return false;

    if (parsed.type === "orbit.subscribe" && typeof parsed.threadId === "string") {
      const threadId = parsed.threadId.trim();
      if (!threadId) return true;
      this.subscribeSocket(socket, role, threadId);
      if (role === "anchor") {
        const anchorId = this.socketToAnchorId.get(socket);
        if (anchorId) {
          this.threadToAnchorId.set(this.userThreadKey(threadId), anchorId);
        }
      }
      this.sendJson(socket, { type: "orbit.subscribed", threadId });

      if (role === "client") {
        this.replayThreadState(socket, threadId);
        const notice = JSON.stringify({ type: "orbit.client-subscribed", threadId });
        const anchors = this.threadToAnchors.get(this.userThreadKey(threadId));
        if (anchors) {
          for (const anchor of anchors) {
            this.sendRaw(anchor, notice);
          }
        }
      }

      return true;
    }

    if (parsed.type === "orbit.unsubscribe" && typeof parsed.threadId === "string") {
      this.unsubscribeSocket(socket, role, parsed.threadId);
      return true;
    }

    if (parsed.type === "orbit.list-anchors" && role === "client") {
      this.sendJson(socket, { type: "orbit.anchors", anchors: this.listUserAnchors() });
      return true;
    }

    if (parsed.type === "orbit.artifacts.list" && role === "client") {
      const threadId = extractThreadId(parsed);
      const requestId = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null;
      const state = threadId ? this.threadStateById.get(this.userThreadKey(threadId)) : null;
      const payload: Record<string, unknown> = {
        type: "orbit.artifacts",
        threadId,
        artifacts: state?.artifacts ?? [],
      };
      if (requestId !== null) {
        payload.id = requestId;
      }
      this.sendJson(socket, payload);
      return true;
    }

    if (parsed.type === "orbit.multi-dispatch" && role === "client") {
      this.handleMultiDispatch(socket, parsed);
      return true;
    }

    if (parsed.type === "orbit.push-subscribe" && role === "client") {
      this.sendJson(socket, { type: "orbit.push-subscribe.ok" });
      return true;
    }

    if (parsed.type === "orbit.push-unsubscribe" && role === "client") {
      this.sendJson(socket, { type: "orbit.push-unsubscribe.ok" });
      return true;
    }

    if (parsed.type === "orbit.push-test" && role === "client") {
      this.sendJson(socket, { type: "orbit.push-test.result", ok: false, error: "Push is not configured on deno provider." });
      return true;
    }

    return false;
  }

  private handleAnchorHello(socket: WebSocket, role: Role, parsed: Record<string, unknown> | null): boolean {
    if (!parsed || role !== "anchor" || parsed.type !== "anchor.hello") return false;

    const candidateAnchorId =
      (typeof parsed.anchorId === "string" && parsed.anchorId.trim() ? parsed.anchorId.trim() : null) ??
      (typeof parsed.deviceId === "string" && parsed.deviceId.trim() ? parsed.deviceId.trim() : null);
    const anchorId = candidateAnchorId ?? randomId(8);

    const key = `${this.userId}:${anchorId}`;
    const existing = this.anchorIdToSocket.get(key);
    if (existing && existing !== socket) {
      this.removeSocket(existing, "anchor");
      try {
        existing.close(1000, "Replaced by newer connection");
      } catch {
        // ignore
      }
    }

    const meta: AnchorMeta = {
      id: anchorId,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
      platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
      connectedAt: typeof parsed.ts === "string" ? parsed.ts : new Date().toISOString(),
    };

    this.anchorMeta.set(socket, meta);
    this.anchorIdToSocket.set(key, socket);
    this.socketToAnchorId.set(socket, anchorId);

    const notification = JSON.stringify({ type: "orbit.anchor-connected", anchor: meta });
    for (const client of this.clientSockets.keys()) {
      this.sendRaw(client, notification);
    }

    return true;
  }

  private subscribeSocket(socket: WebSocket, role: Role, threadId: string): void {
    const threadKey = this.userThreadKey(threadId);
    const source = role === "client" ? this.clientSockets : this.anchorSockets;
    const socketThreads = source.get(socket);
    if (socketThreads) {
      socketThreads.add(threadId);
    }

    const reverse = role === "client" ? this.threadToClients : this.threadToAnchors;
    if (!reverse.has(threadKey)) {
      reverse.set(threadKey, new Set());
    }
    reverse.get(threadKey)?.add(socket);
  }

  private unsubscribeSocket(socket: WebSocket, role: Role, threadId: string): void {
    const normalized = threadId.trim();
    if (!normalized) return;
    const threadKey = this.userThreadKey(normalized);

    const source = role === "client" ? this.clientSockets : this.anchorSockets;
    source.get(socket)?.delete(normalized);

    const reverse = role === "client" ? this.threadToClients : this.threadToAnchors;
    const set = reverse.get(threadKey);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      reverse.delete(threadKey);
    }
  }

  private routeMessage(socket: WebSocket, role: Role, raw: string, parsed: Record<string, unknown> | null): void {
    const threadId = parsed ? extractThreadId(parsed) : null;
    const anchorId = parsed ? extractAnchorId(parsed) : null;
    const requestId = parsed && (typeof parsed.id === "string" || typeof parsed.id === "number") ? parsed.id : null;
    const hasMethod = typeof parsed?.method === "string";

    if (role === "client") {
      if (requestId !== null && !hasMethod) {
        const anchorSocket = this.pendingAnchorRequests.get(this.routeKey(socket, requestId));
        if (anchorSocket) {
          this.pendingAnchorRequests.delete(this.routeKey(socket, requestId));
          this.sendRaw(anchorSocket, raw);
          return;
        }
      }

      const resolved = this.resolveClientTarget(threadId, anchorId);
      if (!resolved.target) {
        this.sendRpcError(socket, requestId, resolved.failure);
        return;
      }

      if (threadId) {
        const resolvedAnchorId = this.socketToAnchorId.get(resolved.target);
        if (resolvedAnchorId) {
          this.threadToAnchorId.set(this.userThreadKey(threadId), resolvedAnchorId);
        }
      }

      if (requestId !== null && hasMethod) {
        this.pendingClientRequests.set(this.routeKey(resolved.target, requestId), socket);
      }
      this.sendRaw(resolved.target, raw);
      return;
    }

    if (parsed) {
      if (requestId !== null && !hasMethod) {
        const childRoute = this.pendingMultiDispatchByChildRoute.get(this.routeKey(socket, requestId));
        if (childRoute) {
          this.consumeMultiDispatchChild(childRoute, parsed);
          return;
        }

        const clientSocket = this.pendingClientRequests.get(this.routeKey(socket, requestId));
        if (clientSocket) {
          this.pendingClientRequests.delete(this.routeKey(socket, requestId));
          this.sendRaw(clientSocket, raw);
          return;
        }
      }
    }

    if (threadId && parsed) {
      const sourceAnchorId = this.socketToAnchorId.get(socket);
      if (sourceAnchorId) {
        this.threadToAnchorId.set(this.userThreadKey(threadId), sourceAnchorId);
      }
      this.mutateThreadState(parsed, raw);
    }

    let recipients: WebSocket[] = [];
    if (threadId) {
      recipients = Array.from(this.threadToClients.get(this.userThreadKey(threadId)) ?? []);
    } else {
      recipients = Array.from(this.clientSockets.keys());
    }

    if (requestId !== null && hasMethod) {
      for (const clientSocket of recipients) {
        this.pendingAnchorRequests.set(this.routeKey(clientSocket, requestId), socket);
      }
    }

    for (const clientSocket of recipients) {
      this.sendRaw(clientSocket, raw);
    }
  }

  private mutateThreadState(message: Record<string, unknown>, raw: string): void {
    const mutation = buildThreadStateMutationFromMessage(message, raw);
    if (!mutation?.threadId) return;

    const key = this.userThreadKey(mutation.threadId);
    const current = this.threadStateById.get(key) ?? createEmptyThreadState(mutation.threadId);
    const updated = applyThreadStateMutation(current, mutation);
    this.threadStateById.set(key, updated);

    if (this.threadStateById.size > MAX_STORED_THREADS) {
      const firstKey = this.threadStateById.keys().next().value as string | undefined;
      if (firstKey) {
        this.threadStateById.delete(firstKey);
      }
    }
  }

  private replayThreadState(socket: WebSocket, threadId: string): void {
    const state = this.threadStateById.get(this.userThreadKey(threadId)) ?? createEmptyThreadState(threadId);
    this.sendJson(socket, {
      type: "orbit.relay-state",
      threadId,
      boundAnchorId: state.anchorId,
      turn: state.turn,
      artifacts: state.artifacts,
      replayed: state.recentMessages.length,
    });

    for (const raw of state.recentMessages) {
      this.sendRaw(socket, raw);
    }
  }

  private handleMultiDispatch(socket: WebSocket, message: Record<string, unknown>): void {
    const parsed = parseMultiDispatchRequest(message);
    if (!parsed) {
      const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
      this.sendJson(socket, {
        type: "orbit.multi-dispatch.result",
        id,
        results: [],
        summary: { total: 0, ok: 0, failed: 0, timedOut: 0 },
      });
      return;
    }

    let anchorIds = parsed.anchorIds;
    if (anchorIds.length === 0) {
      anchorIds = this.listUserAnchors().map((anchor) => anchor.id);
    }

    const parentKey = randomId(12);
    const pending: PendingMultiDispatch = {
      clientSocket: socket,
      requestId: parsed.requestId,
      threadId: parsed.threadId,
      results: [],
      pendingRouteKeys: new Set(),
      timeoutHandle: null,
    };

    for (const anchorId of anchorIds) {
      const anchorSocket = this.anchorIdToSocket.get(`${this.userId}:${anchorId}`);
      if (!anchorSocket) {
        pending.results.push({
          anchorId,
          childId: "",
          ok: false,
          error: { code: "anchor_not_found", message: "Selected device is unavailable." },
        });
        continue;
      }

      const childId = `${parsed.requestId ?? "multi"}:${this.multiDispatchSeq++}`;
      const childRequest: Record<string, unknown> = {
        ...parsed.childRequest,
        id: childId,
      };

      const childRouteKey = this.routeKey(anchorSocket, childId);
      this.pendingMultiDispatchByChildRoute.set(childRouteKey, {
        parentKey,
        anchorId,
        childId,
      });
      pending.pendingRouteKeys.add(childRouteKey);
      this.sendRaw(anchorSocket, JSON.stringify(childRequest));
    }

    if (pending.pendingRouteKeys.size === 0) {
      const aggregate = buildMultiDispatchAggregate(parsed.requestId, parsed.threadId, pending.results);
      this.sendJson(socket, aggregate);
      return;
    }

    pending.timeoutHandle = setTimeout(() => {
      this.finalizeMultiDispatchTimeout(parentKey);
    }, MULTI_DISPATCH_TIMEOUT_MS) as unknown as number;

    this.pendingMultiDispatch.set(parentKey, pending);
  }

  private consumeMultiDispatchChild(child: PendingMultiDispatchChild, responseMessage: Record<string, unknown>): void {
    const pending = this.pendingMultiDispatch.get(child.parentKey);
    if (!pending) {
      return;
    }

    const routeKey = Array.from(pending.pendingRouteKeys).find((entry) => {
      const binding = this.pendingMultiDispatchByChildRoute.get(entry);
      return binding?.parentKey === child.parentKey && binding.childId === child.childId;
    });

    if (routeKey) {
      pending.pendingRouteKeys.delete(routeKey);
      this.pendingMultiDispatchByChildRoute.delete(routeKey);
    }

    const errorRecord = asRecord(responseMessage.error);
    pending.results.push({
      anchorId: child.anchorId,
      childId: child.childId,
      ok: !errorRecord,
      ...(errorRecord ? { error: errorRecord } : { result: responseMessage.result ?? responseMessage }),
    });

    if (pending.pendingRouteKeys.size === 0) {
      this.finalizeMultiDispatch(child.parentKey);
    }
  }

  private finalizeMultiDispatchTimeout(parentKey: string): void {
    const pending = this.pendingMultiDispatch.get(parentKey);
    if (!pending) return;

    for (const routeKey of pending.pendingRouteKeys) {
      const child = this.pendingMultiDispatchByChildRoute.get(routeKey);
      if (!child) continue;
      pending.results.push({
        anchorId: child.anchorId,
        childId: child.childId,
        ok: false,
        error: {
          code: "timeout",
          data: { code: "timeout" },
          message: "No response before timeout.",
        },
      });
      this.pendingMultiDispatchByChildRoute.delete(routeKey);
    }

    pending.pendingRouteKeys.clear();
    this.finalizeMultiDispatch(parentKey);
  }

  private finalizeMultiDispatch(parentKey: string): void {
    const pending = this.pendingMultiDispatch.get(parentKey);
    if (!pending) return;

    if (pending.timeoutHandle !== null) {
      clearTimeout(pending.timeoutHandle);
    }

    this.pendingMultiDispatch.delete(parentKey);
    const aggregate = buildMultiDispatchAggregate(pending.requestId, pending.threadId, pending.results);
    this.sendJson(pending.clientSocket, aggregate);
  }

  removeSocket(socket: WebSocket, role: Role): void {
    const socketId = this.getSocketId(socket);

    if (role === "client") {
      const subscribed = this.clientSockets.get(socket);
      if (subscribed) {
        for (const threadId of subscribed) {
          const set = this.threadToClients.get(this.userThreadKey(threadId));
          if (!set) continue;
          set.delete(socket);
          if (set.size === 0) {
            this.threadToClients.delete(this.userThreadKey(threadId));
          }
        }
      }

      this.clientSockets.delete(socket);
      const clientId = this.socketToClientId.get(socket);
      if (clientId) {
        this.socketToClientId.delete(socket);
        this.clientIdToSocket.delete(clientId);
      }
    } else {
      const subscribed = this.anchorSockets.get(socket);
      if (subscribed) {
        for (const threadId of subscribed) {
          const set = this.threadToAnchors.get(this.userThreadKey(threadId));
          if (!set) continue;
          set.delete(socket);
          if (set.size === 0) {
            this.threadToAnchors.delete(this.userThreadKey(threadId));
          }
        }
      }

      this.anchorSockets.delete(socket);
      const anchorId = this.socketToAnchorId.get(socket);
      if (anchorId) {
        this.socketToAnchorId.delete(socket);
        this.anchorIdToSocket.delete(`${this.userId}:${anchorId}`);
      }

      const meta = this.anchorMeta.get(socket);
      this.anchorMeta.delete(socket);

      if (meta) {
        const notification = JSON.stringify({ type: "orbit.anchor-disconnected", anchorId: meta.id });
        for (const clientSocket of this.clientSockets.keys()) {
          this.sendRaw(clientSocket, notification);
        }
      }
    }

    for (const [key, pendingSocket] of this.pendingClientRequests.entries()) {
      if (pendingSocket === socket || key.startsWith(`${socketId}:`)) {
        this.pendingClientRequests.delete(key);
      }
    }

    for (const [key, pendingSocket] of this.pendingAnchorRequests.entries()) {
      if (pendingSocket === socket || key.startsWith(`${socketId}:`)) {
        this.pendingAnchorRequests.delete(key);
      }
    }
  }

  hasSockets(): boolean {
    return this.clientSockets.size > 0 || this.anchorSockets.size > 0;
  }
}

export class RelayManager {
  private hubs = new Map<string, RelayHub>();

  getHub(userId: string): RelayHub {
    let hub = this.hubs.get(userId);
    if (!hub) {
      hub = new RelayHub(userId);
      this.hubs.set(userId, hub);
    }
    return hub;
  }

  removeIfIdle(userId: string): void {
    const hub = this.hubs.get(userId);
    if (!hub) return;
    if (hub.hasSockets()) return;
    this.hubs.delete(userId);
  }
}

