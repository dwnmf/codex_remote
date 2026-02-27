import { sendPush, type PushPayload, type VapidKeys } from "../push";
import type { Env, Role } from "../types";
import { asRecord, extractAnchorId, extractMethod, extractThreadId, parseJsonMessage } from "../utils/protocol";
import {
  MAX_STORED_THREADS,
  MULTI_DISPATCH_TIMEOUT_MS,
  applyThreadStateMutation,
  buildMultiDispatchAggregate,
  buildThreadStateMutationFromMessage,
  createEmptyThreadState,
  normalizeStoredThreadState,
  parseMultiDispatchRequest,
  type MultiDispatchResultEntry,
  type RelayThreadState,
  type ThreadStateMutation,
} from "./orbit-relay-state";

interface AnchorMeta {
  id: string;
  hostname: string;
  platform: string;
  connectedAt: string;
}

interface RouteFailure {
  code: string;
  message: string;
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
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const THREAD_STATE_PREFIX = "relay:thread:";

export class OrbitRelay {
  private state: DurableObjectState;
  private env: Env;
  private userId: string | null = null;

  // Socket -> subscribed thread IDs
  private clientSockets = new Map<WebSocket, Set<string>>();
  private anchorSockets = new Map<WebSocket, Set<string>>();
  private anchorMeta = new Map<WebSocket, AnchorMeta>();
  private anchorIdToSocket = new Map<string, WebSocket>();
  private socketToAnchorId = new Map<WebSocket, string>();
  private clientIdToSocket = new Map<string, WebSocket>();
  private socketToClientId = new Map<WebSocket, string>();

  // Thread ID -> subscribed sockets (reverse index for fast routing)
  private threadToClients = new Map<string, Set<WebSocket>>();
  private threadToAnchors = new Map<string, Set<WebSocket>>();
  private threadToAnchorId = new Map<string, string>();
  private pendingClientRequests = new Map<string, WebSocket>(); // (anchorSocket,id) -> clientSocket
  private pendingAnchorRequests = new Map<string, WebSocket>(); // (clientSocket,id) -> anchorSocket

  // Durable thread state
  private threadStateById = new Map<string, RelayThreadState>();
  private pendingThreadStateWrites = new Set<string>();
  private pendingThreadStateDeletes = new Set<string>();
  private threadStateFlushScheduled = false;
  private threadStateWriteQueue: Promise<void> = Promise.resolve();
  private storageReady: Promise<void>;

  // Multi-dispatch orchestration
  private pendingMultiDispatch = new Map<string, PendingMultiDispatch>();
  private pendingMultiDispatchByChildRoute = new Map<string, PendingMultiDispatchChild>();
  private multiDispatchSeq = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storageReady = this.state.blockConcurrencyWhile(async () => {
      await this.loadPersistedThreadState();
    });
  }

  fetch(req: Request): Response {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade required", { status: 426 });
    }

    const role = req.headers.get("x-orbit-role") as Role | null;
    if (role !== "client" && role !== "anchor") {
      return new Response("Missing role", { status: 400 });
    }

    const userId = req.headers.get("x-orbit-user-id");
    if (!userId) {
      return new Response("Missing user identity", { status: 400 });
    }
    this.userId = userId;

    const url = new URL(req.url);
    const clientId = role === "client" ? url.searchParams.get("clientId") : null;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    this.registerSocket(server, role, clientId);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private registerSocket(socket: WebSocket, role: Role, clientId: string | null): void {
    const source = role === "client" ? this.clientSockets : this.anchorSockets;

    if (role === "client" && clientId) {
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

    source.set(socket, new Set());

    this.sendJson(socket, {
      type: "orbit.hello",
      role,
      ts: new Date().toISOString(),
    });

    socket.addEventListener("message", (event) => {
      if (this.handlePing(socket, event.data)) {
        return;
      }

      const payloadStr = this.dataToString(event.data);
      const parsed = payloadStr ? parseJsonMessage(payloadStr) : null;

      if (this.handleSubscription(socket, role, parsed)) {
        return;
      }

      if (this.handleAnchorHello(socket, role, parsed)) {
        return;
      }

      this.routeMessage(socket, role, event.data, payloadStr, parsed);
    });

    const cleanup = () => {
      this.removeSocket(socket, role);
      try {
        socket.close();
      } catch {
        // ignore
      }
    };

    socket.addEventListener("close", cleanup);
    socket.addEventListener("error", cleanup);
  }

  private handleSubscription(socket: WebSocket, role: Role, msg: Record<string, unknown> | null): boolean {
    if (!msg) return false;

    if (msg.type === "orbit.subscribe" && typeof msg.threadId === "string") {
      this.subscribeSocket(socket, role, msg.threadId);
      if (role === "anchor") {
        const anchorId = this.anchorMeta.get(socket)?.id;
        if (anchorId) {
          this.bindThreadToAnchor(msg.threadId, anchorId);
        }
      }
      this.sendJson(socket, { type: "orbit.subscribed", threadId: msg.threadId });
      console.log(`[orbit] ${role} subscribed to thread ${msg.threadId}`);

      if (role === "client") {
        this.replayThreadState(socket, msg.threadId);

        // Notify anchors so they can re-send any pending approval from memory.
        const notification = JSON.stringify({ type: "orbit.client-subscribed", threadId: msg.threadId });
        const anchors = this.threadToAnchors.get(msg.threadId);
        if (anchors) {
          for (const anchor of anchors) {
            this.sendToSocket(anchor, notification);
          }
        }
      }

      return true;
    }

    if (msg.type === "orbit.unsubscribe" && typeof msg.threadId === "string") {
      this.unsubscribeSocket(socket, role, msg.threadId);
      console.log(`[orbit] ${role} unsubscribed from thread ${msg.threadId}`);
      return true;
    }

    if (msg.type === "orbit.list-anchors" && role === "client") {
      const anchors = Array.from(this.anchorMeta.values());
      this.sendJson(socket, { type: "orbit.anchors", anchors });
      return true;
    }

    if (msg.type === "orbit.artifacts.list") {
      const threadId = this.extractControlThreadId(msg);
      const requestId = this.extractMessageId(msg);
      const artifacts = threadId ? this.threadStateById.get(threadId)?.artifacts ?? [] : [];
      this.sendJson(socket, {
        type: "orbit.artifacts",
        ...(requestId !== null ? { id: requestId } : {}),
        threadId,
        artifacts,
      });
      return true;
    }

    if (msg.type === "orbit.multi-dispatch" && role === "client") {
      this.handleMultiDispatch(socket, msg);
      return true;
    }

    if (msg.type === "orbit.push-subscribe" && role === "client") {
      void this.savePushSubscription(msg);
      return true;
    }

    if (msg.type === "orbit.push-unsubscribe" && role === "client") {
      void this.removePushSubscription(msg);
      return true;
    }

    if (msg.type === "orbit.push-test" && role === "client") {
      void this.sendTestPush(socket);
      return true;
    }

    return false;
  }

  private handleAnchorHello(socket: WebSocket, role: Role, msg: Record<string, unknown> | null): boolean {
    if (!msg || role !== "anchor" || msg.type !== "anchor.hello") return false;

    const explicitAnchorId =
      (typeof msg.anchorId === "string" && msg.anchorId.trim() ? msg.anchorId.trim() : null) ||
      (typeof msg.deviceId === "string" && msg.deviceId.trim() ? msg.deviceId.trim() : null);
    const anchorId = explicitAnchorId ?? crypto.randomUUID();

    const existing = this.anchorIdToSocket.get(anchorId);
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
      hostname: typeof msg.hostname === "string" ? msg.hostname : "unknown",
      platform: typeof msg.platform === "string" ? msg.platform : "unknown",
      connectedAt: typeof msg.ts === "string" ? msg.ts : new Date().toISOString(),
    };

    this.anchorMeta.set(socket, meta);
    this.anchorIdToSocket.set(meta.id, socket);
    this.socketToAnchorId.set(socket, meta.id);

    const notification = JSON.stringify({ type: "orbit.anchor-connected", anchor: meta });
    for (const clientSocket of this.clientSockets.keys()) {
      this.sendToSocket(clientSocket, notification);
    }

    return true;
  }

  private subscribeSocket(socket: WebSocket, role: Role, threadId: string): void {
    const socketThreads = role === "client"
      ? this.clientSockets.get(socket)
      : this.anchorSockets.get(socket);

    if (socketThreads) {
      socketThreads.add(threadId);
    }

    const threadSockets = role === "client" ? this.threadToClients : this.threadToAnchors;
    if (!threadSockets.has(threadId)) {
      threadSockets.set(threadId, new Set());
    }
    threadSockets.get(threadId)!.add(socket);
  }

  private unsubscribeSocket(socket: WebSocket, role: Role, threadId: string): void {
    const socketThreads = role === "client"
      ? this.clientSockets.get(socket)
      : this.anchorSockets.get(socket);

    if (socketThreads) {
      socketThreads.delete(threadId);
    }

    const threadSockets = role === "client" ? this.threadToClients : this.threadToAnchors;
    const sockets = threadSockets.get(threadId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        threadSockets.delete(threadId);
      }
    }
  }

  private removeSocket(socket: WebSocket, role: Role): void {
    const source = role === "client" ? this.clientSockets : this.anchorSockets;
    const threadSockets = role === "client" ? this.threadToClients : this.threadToAnchors;

    const threads = source.get(socket);
    if (threads) {
      for (const threadId of threads) {
        const sockets = threadSockets.get(threadId);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            threadSockets.delete(threadId);
          }
        }
      }
    }

    source.delete(socket);

    if (role === "client") {
      const clientId = this.socketToClientId.get(socket);
      if (clientId) {
        this.socketToClientId.delete(socket);
        if (this.clientIdToSocket.get(clientId) === socket) {
          this.clientIdToSocket.delete(clientId);
        }
      }
    } else {
      const anchorId = this.socketToAnchorId.get(socket);
      if (anchorId) {
        this.socketToAnchorId.delete(socket);
        if (this.anchorIdToSocket.get(anchorId) === socket) {
          this.anchorIdToSocket.delete(anchorId);
        }
      }

      const meta = this.anchorMeta.get(socket);
      if (meta) {
        this.anchorMeta.delete(socket);
        const notification = JSON.stringify({ type: "orbit.anchor-disconnected", anchorId: meta.id });
        for (const clientSocket of this.clientSockets.keys()) {
          this.sendToSocket(clientSocket, notification);
        }
      }
    }

    const removedSocketId = this.socketId(socket);

    for (const [key, target] of this.pendingClientRequests.entries()) {
      if (target === socket || key.startsWith(`${removedSocketId}:`)) {
        this.pendingClientRequests.delete(key);
      }
    }

    for (const [key, target] of this.pendingAnchorRequests.entries()) {
      if (target === socket || key.startsWith(`${removedSocketId}:`)) {
        this.pendingAnchorRequests.delete(key);
      }
    }

    this.cleanupMultiDispatchForSocket(socket, role);
  }

  private routeMessage(
    socket: WebSocket,
    role: Role,
    data: string | ArrayBuffer | ArrayBufferView,
    payloadStr: string | null,
    msg: Record<string, unknown> | null,
  ): void {
    const threadId = msg ? extractThreadId(msg) : null;
    const anchorId = msg ? extractAnchorId(msg) : null;
    const requestId = this.extractMessageId(msg);
    const requestKey = this.messageIdKey(requestId);
    const hasMethod = typeof msg?.method === "string";

    if (role === "client") {
      if (requestKey && !hasMethod) {
        const responseTarget = this.pendingAnchorRequests.get(this.routeKey(socket, requestKey));
        if (responseTarget) {
          this.pendingAnchorRequests.delete(this.routeKey(socket, requestKey));
          this.sendToSocket(responseTarget, data);
          return;
        }
      }

      const resolved = this.resolveClientTarget(threadId, anchorId);
      if (!resolved.target) {
        this.sendRpcError(socket, requestId, resolved.failure);
        return;
      }

      if (threadId) {
        const boundAnchorId = this.socketToAnchorId.get(resolved.target);
        if (boundAnchorId) {
          this.bindThreadToAnchor(threadId, boundAnchorId);
        }
      }

      if (requestKey && hasMethod) {
        this.pendingClientRequests.set(this.routeKey(resolved.target, requestKey), socket);
      }

      this.sendToSocket(resolved.target, data);
      return;
    }

    if (requestKey && !hasMethod) {
      if (msg && this.handleMultiDispatchChildResponse(socket, msg, requestKey)) {
        return;
      }

      const sourceAnchorId = this.socketToAnchorId.get(socket);
      if (threadId && sourceAnchorId) {
        this.bindThreadToAnchor(threadId, sourceAnchorId);
      }
      const responseTarget = this.pendingClientRequests.get(this.routeKey(socket, requestKey));
      if (responseTarget) {
        this.pendingClientRequests.delete(this.routeKey(socket, requestKey));
        this.sendToSocket(responseTarget, data);
        return;
      }
    }

    const sourceAnchorId = this.socketToAnchorId.get(socket);
    if (threadId && sourceAnchorId) {
      this.bindThreadToAnchor(threadId, sourceAnchorId);
    }

    const targets =
      threadId && this.threadToClients.get(threadId) && this.threadToClients.get(threadId)!.size > 0
        ? Array.from(this.threadToClients.get(threadId)!)
        : Array.from(this.clientSockets.keys());

    if (requestKey && hasMethod) {
      for (const target of targets) {
        this.pendingAnchorRequests.set(this.routeKey(target, requestKey), socket);
      }
    }

    for (const target of targets) {
      this.sendToSocket(target, data);
    }

    if (msg && payloadStr) {
      this.captureThreadStateFromMessage(msg, payloadStr, sourceAnchorId);
    }

    if (msg) {
      const method = extractMethod(msg);
      if (method && this.isPushWorthy(method)) {
        void this.sendPushNotifications(msg, method, threadId);
      }
    }
  }

  private resolveClientTarget(threadId: string | null, anchorId: string | null): { target: WebSocket | null; failure: RouteFailure | null } {
    if (anchorId) {
      const target = this.anchorIdToSocket.get(anchorId);
      if (!target) {
        return { target: null, failure: { code: "anchor_not_found", message: "Selected device is unavailable." } };
      }
      if (threadId) {
        const bound = this.threadToAnchorId.get(threadId);
        if (bound && bound !== anchorId) {
          return { target: null, failure: { code: "thread_anchor_mismatch", message: "Thread is attached to another device." } };
        }
      }
      return { target, failure: null };
    }

    if (threadId) {
      const boundAnchorId = this.threadToAnchorId.get(threadId);
      if (boundAnchorId) {
        const target = this.anchorIdToSocket.get(boundAnchorId);
        if (target) return { target, failure: null };
        return { target: null, failure: { code: "anchor_offline", message: "Device for this thread is offline." } };
      }

      const subscribed = Array.from(this.threadToAnchors.get(threadId) ?? []);
      if (subscribed.length === 1) {
        return { target: subscribed[0], failure: null };
      }
      if (subscribed.length > 1) {
        return {
          target: null,
          failure: { code: "thread_anchor_mismatch", message: "Thread is attached to multiple devices." },
        };
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

  private handleMultiDispatch(socket: WebSocket, message: Record<string, unknown>): void {
    const parsed = parseMultiDispatchRequest(message);
    if (!parsed) {
      const requestId = this.extractMessageId(message);
      this.sendJson(socket, {
        type: "orbit.multi-dispatch.result",
        id: requestId,
        threadId: null,
        results: [],
        summary: { total: 0, ok: 0, failed: 0, timedOut: 0 },
      });
      return;
    }

    const explicitTargets = parsed.anchorIds.length > 0;
    const targetAnchorIds = explicitTargets ? parsed.anchorIds : this.resolveMultiDispatchTargets(parsed.threadId);
    const immediateResults: MultiDispatchResultEntry[] = [];
    const dispatchTargets: Array<{ anchorId: string; socket: WebSocket }> = [];

    for (const targetAnchorId of targetAnchorIds) {
      const targetSocket = this.anchorIdToSocket.get(targetAnchorId);
      if (!targetSocket) {
        immediateResults.push({
          anchorId: targetAnchorId,
          childId: `missing-${targetAnchorId}`,
          ok: false,
          error: this.routeFailureAsRpcError(
            explicitTargets
              ? { code: "anchor_not_found", message: "Selected device is unavailable." }
              : { code: "anchor_offline", message: "Device for this thread is offline." },
          ),
        });
        continue;
      }
      dispatchTargets.push({ anchorId: targetAnchorId, socket: targetSocket });
    }

    if (dispatchTargets.length === 0) {
      if (immediateResults.length === 0) {
        immediateResults.push({
          anchorId: "",
          childId: "none",
          ok: false,
          error: this.routeFailureAsRpcError({ code: "anchor_offline", message: "No devices are connected." }),
        });
      }
      this.sendJson(socket, buildMultiDispatchAggregate(parsed.requestId, parsed.threadId, immediateResults));
      return;
    }

    const parentKey = this.buildMultiDispatchParentKey(socket, parsed.requestId);
    const pending: PendingMultiDispatch = {
      clientSocket: socket,
      requestId: parsed.requestId,
      threadId: parsed.threadId,
      results: [...immediateResults],
      pendingRouteKeys: new Set(),
      timeoutHandle: null,
    };

    for (const target of dispatchTargets) {
      const childId = this.nextMultiDispatchChildId();
      const childPayload = this.buildMultiDispatchChildPayload(parsed.childRequest, childId, parsed.threadId, target.anchorId);
      const childRequestKey = this.messageIdKey(childId);
      if (!childRequestKey) {
        pending.results.push({
          anchorId: target.anchorId,
          childId,
          ok: false,
          error: this.routeFailureAsRpcError({ code: "invalid_request", message: "Failed to generate child request id." }),
        });
        continue;
      }

      const childRouteKey = this.routeKey(target.socket, childRequestKey);
      this.pendingMultiDispatchByChildRoute.set(childRouteKey, {
        parentKey,
        anchorId: target.anchorId,
        childId,
      });
      pending.pendingRouteKeys.add(childRouteKey);

      const sent = this.sendToSocket(target.socket, JSON.stringify(childPayload));
      if (!sent) {
        this.pendingMultiDispatchByChildRoute.delete(childRouteKey);
        pending.pendingRouteKeys.delete(childRouteKey);
        pending.results.push({
          anchorId: target.anchorId,
          childId,
          ok: false,
          error: this.routeFailureAsRpcError({ code: "anchor_offline", message: "Device for this thread is offline." }),
        });
      }
    }

    if (pending.pendingRouteKeys.size === 0) {
      this.sendJson(socket, buildMultiDispatchAggregate(parsed.requestId, parsed.threadId, pending.results));
      return;
    }

    this.pendingMultiDispatch.set(parentKey, pending);
    pending.timeoutHandle = setTimeout(() => {
      this.timeoutMultiDispatch(parentKey);
    }, MULTI_DISPATCH_TIMEOUT_MS);
  }

  private resolveMultiDispatchTargets(threadId: string | null): string[] {
    const result = new Set<string>();

    if (threadId) {
      const boundAnchorId = this.threadToAnchorId.get(threadId);
      if (boundAnchorId) {
        result.add(boundAnchorId);
      }

      const anchors = this.threadToAnchors.get(threadId);
      if (anchors) {
        for (const anchorSocket of anchors) {
          const anchorId = this.socketToAnchorId.get(anchorSocket);
          if (anchorId) result.add(anchorId);
        }
      }
    }

    if (result.size > 0) {
      return Array.from(result);
    }

    return Array.from(this.anchorIdToSocket.keys());
  }

  private buildMultiDispatchParentKey(socket: WebSocket, requestId: string | number | null): string {
    const socketId = this.socketId(socket);
    const requestKey = requestId !== null ? this.messageIdKey(requestId) ?? this.nextMultiDispatchChildId() : this.nextMultiDispatchChildId();
    return `${socketId}:multi:${requestKey}`;
  }

  private nextMultiDispatchChildId(): string {
    this.multiDispatchSeq += 1;
    return `multi-${Date.now()}-${this.multiDispatchSeq}`;
  }

  private buildMultiDispatchChildPayload(
    childRequest: Record<string, unknown>,
    childId: string,
    threadId: string | null,
    anchorId: string,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      ...childRequest,
      id: childId,
    };

    delete payload.type;
    delete payload.anchorIds;
    delete payload.anchors;
    delete payload.request;
    delete payload.rpc;

    const params = asRecord(payload.params) ?? {};
    let nextParams: Record<string, unknown> = { ...params };
    if (threadId && typeof nextParams.threadId !== "string" && typeof nextParams.thread_id !== "string") {
      nextParams = { ...nextParams, threadId };
    }
    if (typeof nextParams.anchorId !== "string" && typeof nextParams.anchor_id !== "string") {
      nextParams = { ...nextParams, anchorId };
    }
    payload.params = nextParams;

    return payload;
  }

  private handleMultiDispatchChildResponse(anchorSocket: WebSocket, message: Record<string, unknown>, requestKey: string): boolean {
    const childRouteKey = this.routeKey(anchorSocket, requestKey);
    const child = this.pendingMultiDispatchByChildRoute.get(childRouteKey);
    if (!child) return false;

    this.pendingMultiDispatchByChildRoute.delete(childRouteKey);

    const pending = this.pendingMultiDispatch.get(child.parentKey);
    if (!pending) return true;
    pending.pendingRouteKeys.delete(childRouteKey);

    const hasError = Object.prototype.hasOwnProperty.call(message, "error") && message.error !== undefined;
    pending.results.push({
      anchorId: child.anchorId,
      childId: child.childId,
      ok: !hasError,
      ...(hasError ? { error: message.error } : { result: message.result }),
    });

    if (pending.pendingRouteKeys.size === 0) {
      this.finishMultiDispatch(child.parentKey);
    }

    return true;
  }

  private timeoutMultiDispatch(parentKey: string): void {
    const pending = this.pendingMultiDispatch.get(parentKey);
    if (!pending) return;

    for (const childRouteKey of pending.pendingRouteKeys) {
      const child = this.pendingMultiDispatchByChildRoute.get(childRouteKey);
      if (!child) continue;

      this.pendingMultiDispatchByChildRoute.delete(childRouteKey);
      pending.results.push({
        anchorId: child.anchorId,
        childId: child.childId,
        ok: false,
        error: this.routeFailureAsRpcError({ code: "timeout", message: "Timed out waiting for anchor response." }),
      });
    }
    pending.pendingRouteKeys.clear();
    this.finishMultiDispatch(parentKey);
  }

  private finishMultiDispatch(parentKey: string): void {
    const pending = this.pendingMultiDispatch.get(parentKey);
    if (!pending) return;

    this.pendingMultiDispatch.delete(parentKey);
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
      pending.timeoutHandle = null;
    }

    this.sendJson(
      pending.clientSocket,
      buildMultiDispatchAggregate(pending.requestId, pending.threadId, pending.results),
    );
  }

  private cleanupMultiDispatchForSocket(socket: WebSocket, role: Role): void {
    if (role === "client") {
      const parentsToDiscard: string[] = [];
      for (const [parentKey, pending] of this.pendingMultiDispatch.entries()) {
        if (pending.clientSocket === socket) {
          parentsToDiscard.push(parentKey);
        }
      }
      for (const parentKey of parentsToDiscard) {
        this.discardMultiDispatch(parentKey);
      }
    }

    const removedSocketId = this.socketId(socket);
    const parentsToFinish = new Set<string>();
    for (const [childRouteKey, child] of this.pendingMultiDispatchByChildRoute.entries()) {
      if (!childRouteKey.startsWith(`${removedSocketId}:`)) continue;
      this.pendingMultiDispatchByChildRoute.delete(childRouteKey);

      const pending = this.pendingMultiDispatch.get(child.parentKey);
      if (!pending) continue;
      pending.pendingRouteKeys.delete(childRouteKey);
      pending.results.push({
        anchorId: child.anchorId,
        childId: child.childId,
        ok: false,
        error: this.routeFailureAsRpcError({ code: "anchor_offline", message: "Device for this thread is offline." }),
      });

      if (pending.pendingRouteKeys.size === 0) {
        parentsToFinish.add(child.parentKey);
      }
    }

    for (const parentKey of parentsToFinish) {
      this.finishMultiDispatch(parentKey);
    }
  }

  private discardMultiDispatch(parentKey: string): void {
    const pending = this.pendingMultiDispatch.get(parentKey);
    if (!pending) return;
    this.pendingMultiDispatch.delete(parentKey);
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
      pending.timeoutHandle = null;
    }
    for (const [childRouteKey, child] of this.pendingMultiDispatchByChildRoute.entries()) {
      if (child.parentKey === parentKey) {
        this.pendingMultiDispatchByChildRoute.delete(childRouteKey);
      }
    }
  }

  private bindThreadToAnchor(threadId: string, anchorId: string): void {
    this.threadToAnchorId.set(threadId, anchorId);
    this.applyThreadStateMutationAndPersist({ threadId, anchorId });
  }

  private captureThreadStateFromMessage(message: Record<string, unknown>, rawPayload: string, sourceAnchorId: string | undefined): void {
    const mutation = buildThreadStateMutationFromMessage(message, rawPayload);
    if (!mutation) return;

    if (sourceAnchorId) {
      mutation.anchorId = sourceAnchorId;
    }

    if (message._replay === true) {
      mutation.recentMessage = undefined;
      mutation.artifact = undefined;
    }

    const hasMeaningfulChange =
      mutation.anchorId !== undefined
      || mutation.turnId !== undefined
      || mutation.turnStatus !== undefined
      || mutation.recentMessage !== undefined
      || mutation.artifact !== undefined;
    if (!hasMeaningfulChange) return;

    this.applyThreadStateMutationAndPersist(mutation);
  }

  private applyThreadStateMutationAndPersist(mutation: ThreadStateMutation): void {
    const existing = this.threadStateById.get(mutation.threadId) ?? createEmptyThreadState(mutation.threadId);
    const next = applyThreadStateMutation(existing, mutation);

    if (this.threadStateById.has(mutation.threadId)) {
      this.threadStateById.delete(mutation.threadId);
    }
    this.threadStateById.set(mutation.threadId, next);

    if (next.anchorId) {
      this.threadToAnchorId.set(mutation.threadId, next.anchorId);
    }

    this.pendingThreadStateWrites.add(mutation.threadId);
    this.pendingThreadStateDeletes.delete(mutation.threadId);
    this.enforceThreadStateRetention();
    this.scheduleThreadStateFlush();
  }

  private enforceThreadStateRetention(): void {
    while (this.threadStateById.size > MAX_STORED_THREADS) {
      const oldestThreadId = this.threadStateById.keys().next().value as string | undefined;
      if (!oldestThreadId) break;
      this.threadStateById.delete(oldestThreadId);
      this.threadToAnchorId.delete(oldestThreadId);
      this.pendingThreadStateWrites.delete(oldestThreadId);
      this.pendingThreadStateDeletes.add(oldestThreadId);
    }
  }

  private scheduleThreadStateFlush(): void {
    if (this.threadStateFlushScheduled) return;
    this.threadStateFlushScheduled = true;

    queueMicrotask(() => {
      this.threadStateFlushScheduled = false;

      const writes = Array.from(this.pendingThreadStateWrites);
      const deletes = Array.from(this.pendingThreadStateDeletes);
      this.pendingThreadStateWrites.clear();
      this.pendingThreadStateDeletes.clear();

      if (writes.length === 0 && deletes.length === 0) {
        return;
      }

      this.threadStateWriteQueue = this.threadStateWriteQueue
        .then(async () => {
          await this.storageReady;
          await this.flushThreadStateChanges(writes, deletes);
        })
        .catch((err) => {
          console.warn("[orbit] failed to persist thread state", err);
          for (const threadId of writes) {
            this.pendingThreadStateWrites.add(threadId);
          }
          for (const threadId of deletes) {
            this.pendingThreadStateDeletes.add(threadId);
          }
          this.scheduleThreadStateFlush();
        });
    });
  }

  private async flushThreadStateChanges(writes: string[], deletes: string[]): Promise<void> {
    for (const threadId of writes) {
      const state = this.threadStateById.get(threadId);
      if (!state) continue;
      await this.state.storage.put(this.threadStorageKey(threadId), state);
    }
    for (const threadId of deletes) {
      await this.state.storage.delete(this.threadStorageKey(threadId));
    }
  }

  private async loadPersistedThreadState(): Promise<void> {
    const listed = await this.state.storage.list<unknown>({ prefix: THREAD_STATE_PREFIX });
    const loaded: RelayThreadState[] = [];

    for (const value of listed.values()) {
      const normalized = normalizeStoredThreadState(value);
      if (!normalized) continue;
      loaded.push(normalized);
    }

    loaded.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const retained = loaded.slice(Math.max(0, loaded.length - MAX_STORED_THREADS));
    const dropped = loaded.slice(0, Math.max(0, loaded.length - retained.length));

    for (const state of retained) {
      this.threadStateById.set(state.threadId, state);
      if (state.anchorId) {
        this.threadToAnchorId.set(state.threadId, state.anchorId);
      }
    }

    if (dropped.length > 0) {
      for (const state of dropped) {
        this.pendingThreadStateDeletes.add(state.threadId);
      }
      this.scheduleThreadStateFlush();
    }
  }

  private threadStorageKey(threadId: string): string {
    return `${THREAD_STATE_PREFIX}${threadId}`;
  }

  private replayThreadState(socket: WebSocket, threadId: string): void {
    const state = this.threadStateById.get(threadId);
    if (!state) return;

    this.replayTurnSnapshot(socket, state);

    for (const raw of state.recentMessages) {
      this.sendToSocket(socket, raw);
    }
  }

  private replayTurnSnapshot(socket: WebSocket, state: RelayThreadState): void {
    if (!state.turn.id || !state.turn.status) return;

    const normalized = state.turn.status.toLowerCase();
    let method: string | null = null;
    if (normalized === "inprogress") method = "turn/started";
    if (normalized === "completed") method = "turn/completed";
    if (normalized === "failed") method = "turn/failed";
    if (normalized === "cancelled") method = "turn/cancelled";
    if (!method) return;

    this.sendJson(socket, {
      method,
      params: {
        threadId: state.threadId,
        turn: {
          id: state.turn.id,
          status: state.turn.status,
        },
      },
    });
  }

  private extractControlThreadId(msg: Record<string, unknown>): string | null {
    if (typeof msg.threadId === "string" && msg.threadId.trim()) return msg.threadId;
    const params = asRecord(msg.params);
    if (typeof params?.threadId === "string" && params.threadId.trim()) return params.threadId;
    return extractThreadId(msg);
  }

  private extractMessageId(msg: Record<string, unknown> | null): string | number | null {
    if (!msg) return null;
    const value = msg.id;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return value;
    return null;
  }

  private messageIdKey(id: string | number | null): string | null {
    if (id == null) return null;
    return typeof id === "number" ? `n:${id}` : `s:${id}`;
  }

  private routeKey(source: WebSocket, id: string): string {
    return `${this.socketId(source)}:${id}`;
  }

  private socketId(socket: WebSocket): string {
    const anySocket = socket as unknown as { __orbit_socket_id?: string };
    if (!anySocket.__orbit_socket_id) {
      anySocket.__orbit_socket_id = crypto.randomUUID();
    }
    return anySocket.__orbit_socket_id;
  }

  private sendToSocket(target: WebSocket, data: string | ArrayBuffer | ArrayBufferView): boolean {
    try {
      target.send(data);
      return true;
    } catch (err) {
      console.warn("[orbit] failed to relay message", err);
      return false;
    }
  }

  private sendJson(socket: WebSocket, payload: Record<string, unknown>): boolean {
    return this.sendToSocket(socket, JSON.stringify(payload));
  }

  private routeFailureAsRpcError(failure: RouteFailure): Record<string, unknown> {
    return {
      code: -32001,
      message: failure.message,
      data: { code: failure.code },
    };
  }

  private sendRpcError(socket: WebSocket, requestId: string | number | null, failure: RouteFailure | null): void {
    if (requestId == null || !failure) return;
    this.sendJson(socket, {
      id: requestId,
      error: this.routeFailureAsRpcError(failure),
    });
  }

  private dataToString(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    return null;
  }

  private handlePing(socket: WebSocket, data: unknown): boolean {
    const payload = this.dataToString(data);
    if (!payload) return false;

    const trimmed = payload.trim();
    if (trimmed === '{"type":"ping"}') {
      this.sendJson(socket, { type: "pong" });
      return true;
    }

    return false;
  }

  private isPushWorthy(method: string): boolean {
    return method.endsWith("/requestApproval") || method === "item/tool/requestUserInput";
  }

  private buildPushPayload(msg: Record<string, unknown>, method: string, threadId: string | null): PushPayload {
    const params = asRecord(msg.params);
    const reason = (params?.reason as string) || "";

    let type = "approval";
    let title = "Approval Required";
    let body = reason || "An action requires your approval";

    if (method === "item/fileChange/requestApproval") {
      title = "File Change Approval";
      body = reason || "A file change needs your approval";
    } else if (method === "item/commandExecution/requestApproval") {
      title = "Command Approval";
      body = reason || "A command needs your approval";
    } else if (method === "item/mcpToolCall/requestApproval") {
      title = "Tool Call Approval";
      body = reason || "A tool call needs your approval";
    } else if (method === "item/tool/requestUserInput") {
      type = "user-input";
      title = "Input Required";
      const questions = (params?.questions as Array<{ question: string }>) || [];
      body = questions[0]?.question || "Input required";
    }

    return {
      type,
      title,
      body,
      threadId: threadId || "",
      actionUrl: threadId ? `/thread/${threadId}` : "/app",
    };
  }

  private async sendPushNotifications(msg: Record<string, unknown>, method: string, threadId: string | null): Promise<void> {
    if (!this.env.DB || !this.userId) return;

    const vapidPublic = this.env.VAPID_PUBLIC_KEY?.trim();
    const vapidPrivate = this.env.VAPID_PRIVATE_KEY?.trim();
    const vapidSubject = this.env.VAPID_SUBJECT?.trim();
    if (!vapidPublic || !vapidPrivate || !vapidSubject) return;

    const vapid: VapidKeys = { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject };

    try {
      const { results } = await this.env.DB.prepare(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
      )
        .bind(this.userId)
        .all<{ endpoint: string; p256dh: string; auth: string }>();

      if (!results.length) return;

      const payload = this.buildPushPayload(msg, method, threadId);

      for (const row of results) {
        try {
          const result = await sendPush(row, payload, vapid);
          if (result.expired) {
            await this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
              .bind(row.endpoint)
              .run();
            console.log(`[orbit] push: removed expired subscription`);
          }
        } catch (err) {
          console.warn("[orbit] push: failed to send", err);
        }
      }
    } catch (err) {
      console.warn("[orbit] push: failed to query subscriptions", err);
    }
  }

  private async savePushSubscription(msg: Record<string, unknown>): Promise<void> {
    if (!this.env.DB || !this.userId) return;

    if (typeof msg.endpoint !== "string" || typeof msg.p256dh !== "string" || typeof msg.auth !== "string") return;
    const endpoint = msg.endpoint;
    const p256dh = msg.p256dh;
    const auth = msg.auth;
    if (!endpoint || !p256dh || !auth) return;

    try {
      await this.env.DB.prepare(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth"
      )
        .bind(this.userId, endpoint, p256dh, auth, Math.floor(Date.now() / 1000))
        .run();
      console.log(`[orbit] push: subscription saved for user ${this.userId}`);
    } catch (err) {
      console.warn("[orbit] push: failed to save subscription", err);
    }
  }

  private async removePushSubscription(msg: Record<string, unknown>): Promise<void> {
    if (!this.env.DB || !this.userId) return;

    const endpoint = msg.endpoint as string;
    if (!endpoint) return;

    try {
      await this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .bind(endpoint, this.userId)
        .run();
      console.log(`[orbit] push: subscription removed for user ${this.userId}`);
    } catch (err) {
      console.warn("[orbit] push: failed to remove subscription", err);
    }
  }

  private async sendTestPush(_socket: WebSocket): Promise<void> {
    if (!this.env.DB || !this.userId) return;

    const vapidPublic = this.env.VAPID_PUBLIC_KEY?.trim();
    const vapidPrivate = this.env.VAPID_PRIVATE_KEY?.trim();
    const vapidSubject = this.env.VAPID_SUBJECT?.trim();
    if (!vapidPublic || !vapidPrivate || !vapidSubject) return;

    const vapid: VapidKeys = { publicKey: vapidPublic, privateKey: vapidPrivate, subject: vapidSubject };

    try {
      const { results } = await this.env.DB.prepare(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
      )
        .bind(this.userId)
        .all<{ endpoint: string; p256dh: string; auth: string }>();

      if (!results.length) return;

      const payload: PushPayload = {
        type: "test",
        title: "Test Notification",
        body: "Push notifications are working!",
        threadId: "",
        actionUrl: "/app",
      };

      for (const row of results) {
        try {
          const result = await sendPush(row, payload, vapid);
          console.log(`[orbit] push-test: status=${result.status} ok=${result.ok}`);
          if (result.expired) {
            await this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
              .bind(row.endpoint)
              .run();
          }
        } catch (err) {
          console.warn("[orbit] push-test: failed to send", err);
        }
      }
    } catch (err) {
      console.warn("[orbit] push-test: failed", err);
    }
  }
}
