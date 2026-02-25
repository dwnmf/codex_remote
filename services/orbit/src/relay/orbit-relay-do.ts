import { sendPush, type PushPayload, type VapidKeys } from "../push";
import type { Env, Role } from "../types";
import { asRecord, extractAnchorId, extractMethod, extractThreadId, parseJsonMessage } from "../utils/protocol";

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

export class OrbitRelay {
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

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
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

    socket.send(
      JSON.stringify({
        type: "orbit.hello",
        role,
        ts: new Date().toISOString(),
      })
    );

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

      this.routeMessage(socket, role, event.data, parsed);
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
          this.threadToAnchorId.set(msg.threadId, anchorId);
        }
      }
      try {
        socket.send(JSON.stringify({ type: "orbit.subscribed", threadId: msg.threadId }));
      } catch {
        // ignore
      }
      console.log(`[orbit] ${role} subscribed to thread ${msg.threadId}`);

      // Notify anchors so they can re-send any pending approval from memory
      if (role === "client") {
        const notification = JSON.stringify({ type: "orbit.client-subscribed", threadId: msg.threadId });
        const anchors = this.threadToAnchors.get(msg.threadId);
        if (anchors) {
          for (const anchor of anchors) {
            try { anchor.send(notification); } catch { /* ignore */ }
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
      try {
        socket.send(JSON.stringify({ type: "orbit.anchors", anchors }));
      } catch {
        // ignore
      }
      return true;
    }

    if (msg.type === "orbit.push-subscribe" && role === "client") {
      this.savePushSubscription(msg);
      return true;
    }

    if (msg.type === "orbit.push-unsubscribe" && role === "client") {
      this.removePushSubscription(msg);
      return true;
    }

    if (msg.type === "orbit.push-test" && role === "client") {
      this.sendTestPush(socket);
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
      try {
        clientSocket.send(notification);
      } catch {
        // ignore
      }
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
          try {
            clientSocket.send(notification);
          } catch {
            // ignore
          }
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
  }

  private routeMessage(socket: WebSocket, role: Role, data: string | ArrayBuffer | ArrayBufferView, msg: Record<string, unknown> | null): void {
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
          this.threadToAnchorId.set(threadId, boundAnchorId);
        }
      }

      if (requestKey && hasMethod) {
        this.pendingClientRequests.set(this.routeKey(resolved.target, requestKey), socket);
      }

      this.sendToSocket(resolved.target, data);
      return;
    }

    if (requestKey && !hasMethod) {
      const sourceAnchorId = this.socketToAnchorId.get(socket);
      if (threadId && sourceAnchorId) {
        this.threadToAnchorId.set(threadId, sourceAnchorId);
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
      this.threadToAnchorId.set(threadId, sourceAnchorId);
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

    // Send push notification for blocking events (async, non-blocking)
    if (msg) {
      const method = extractMethod(msg);
      if (method && this.isPushWorthy(method)) {
        this.sendPushNotifications(msg, method, threadId);
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

  private extractMessageId(msg: Record<string, unknown> | null): string | number | null {
    if (!msg) return null;
    const value = msg.id;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return value;
    return null;
  }

  private messageIdKey(id: string | number | null): string | null {
    if (id == null) return null;
    return String(id);
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

  private sendToSocket(target: WebSocket, data: string | ArrayBuffer | ArrayBufferView): void {
    try {
      target.send(data);
    } catch (err) {
      console.warn("[orbit] failed to relay message", err);
    }
  }

  private sendRpcError(socket: WebSocket, requestId: string | number | null, failure: RouteFailure | null): void {
    if (requestId == null || !failure) return;
    try {
      socket.send(
        JSON.stringify({
          id: requestId,
          error: {
            code: -32001,
            message: failure.message,
            data: { code: failure.code },
          },
        })
      );
    } catch {
      // ignore
    }
  }

  private dataToString(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    return null;
  }

  private handlePing(socket: WebSocket, data: unknown): boolean {
    const payload = this.dataToString(data);
    if (!payload) return false;

    const trimmed = payload.trim();
    if (trimmed === '{"type":"ping"}') {
      try {
        socket.send(JSON.stringify({ type: "pong" }));
      } catch {}
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
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth"
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
