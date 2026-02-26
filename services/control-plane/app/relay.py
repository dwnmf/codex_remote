from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from .protocol import extract_anchor_id, extract_thread_id


@dataclass
class AnchorMeta:
    id: str
    hostname: str
    platform: str
    connected_at: str


@dataclass
class RouteFailure:
    code: str
    message: str


@dataclass
class BroadcastNotification:
    sockets: list[WebSocket]
    payload: dict[str, Any]


class RelayHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.client_sockets: dict[WebSocket, set[str]] = {}
        self.anchor_sockets: dict[WebSocket, set[str]] = {}
        self.socket_to_user_id: dict[WebSocket, str] = {}
        self.user_to_client_sockets: dict[str, set[WebSocket]] = {}
        self.user_to_anchor_sockets: dict[str, set[WebSocket]] = {}
        self.anchor_meta: dict[WebSocket, AnchorMeta] = {}
        self.anchor_id_to_socket: dict[tuple[str, str], WebSocket] = {}
        self.socket_to_anchor_id: dict[WebSocket, str] = {}
        self.client_id_to_socket: dict[tuple[str, str], WebSocket] = {}
        self.socket_to_client_id: dict[WebSocket, str] = {}
        self.thread_to_clients: dict[tuple[str, str], set[WebSocket]] = {}
        self.thread_to_anchors: dict[tuple[str, str], set[WebSocket]] = {}
        self.thread_to_anchor_id: dict[tuple[str, str], str] = {}
        self.pending_client_requests: dict[tuple[WebSocket, str], WebSocket] = {}
        self.pending_anchor_requests: dict[tuple[WebSocket, str], WebSocket] = {}

    async def register(self, socket: WebSocket, role: str, user_id: str, client_id: str | None = None) -> None:
        replaced: WebSocket | None = None
        notifications: list[BroadcastNotification] = []
        async with self._lock:
            source = self.client_sockets if role == "client" else self.anchor_sockets
            by_user = self.user_to_client_sockets if role == "client" else self.user_to_anchor_sockets
            self.socket_to_user_id[socket] = user_id
            by_user.setdefault(user_id, set()).add(socket)

            if role == "client" and client_id:
                existing = self.client_id_to_socket.get((user_id, client_id))
                if existing and existing is not socket:
                    notifications.extend(self._remove_socket_locked(existing, "client"))
                    replaced = existing
                self.client_id_to_socket[(user_id, client_id)] = socket
                self.socket_to_client_id[socket] = client_id

            source[socket] = set()

        await self._flush_notifications(notifications)
        if replaced:
            try:
                await replaced.close(code=1000, reason="Replaced by newer connection")
            except Exception:
                pass

        await self._send_json(
            socket,
            {
                "type": "orbit.hello",
                "role": role,
                "ts": datetime.now(tz=timezone.utc).isoformat(),
            },
        )

    async def unregister(self, socket: WebSocket, role: str) -> None:
        notifications: list[BroadcastNotification]
        async with self._lock:
            notifications = self._remove_socket_locked(socket, role)
        await self._flush_notifications(notifications)

    async def handle_message(self, socket: WebSocket, role: str, raw_data: str) -> None:
        try:
            msg = json.loads(raw_data)
            if not isinstance(msg, dict):
                msg = None
        except json.JSONDecodeError:
            msg = None

        async with self._lock:
            user_id = self.socket_to_user_id.get(socket)
        if not user_id:
            return

        if msg and msg.get("type") == "ping":
            await self._send_json(socket, {"type": "pong"})
            return

        if msg and await self._handle_subscription(socket, role, user_id, msg):
            return

        if msg and await self._handle_anchor_hello(socket, role, user_id, msg):
            return

        await self._route_message(socket, role, user_id, raw_data, msg)

    async def _handle_subscription(self, socket: WebSocket, role: str, user_id: str, msg: dict[str, Any]) -> bool:
        msg_type = msg.get("type")
        if msg_type == "orbit.subscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"]
            async with self._lock:
                thread_key = self._thread_key(user_id, thread_id)
                self._subscribe_socket_locked(socket, role, thread_key, thread_id)
                if role == "anchor":
                    anchor_id = self.socket_to_anchor_id.get(socket)
                    if anchor_id:
                        self.thread_to_anchor_id[thread_key] = anchor_id
                anchor_targets = list(self.thread_to_anchors.get(thread_key, set())) if role == "client" else []

            await self._send_json(socket, {"type": "orbit.subscribed", "threadId": thread_id})

            if role == "client":
                notice = json.dumps({"type": "orbit.client-subscribed", "threadId": thread_id})
                await self._broadcast_raw(anchor_targets, notice)
            return True

        if msg_type == "orbit.unsubscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"]
            async with self._lock:
                self._unsubscribe_socket_locked(socket, role, self._thread_key(user_id, thread_id), thread_id)
            return True

        if msg_type == "orbit.list-anchors" and role == "client":
            async with self._lock:
                anchors = [
                    {
                        "id": meta.id,
                        "hostname": meta.hostname,
                        "platform": meta.platform,
                        "connectedAt": meta.connected_at,
                    }
                    for anchor_socket, meta in self.anchor_meta.items()
                    if self.socket_to_user_id.get(anchor_socket) == user_id
                ]
            await self._send_json(socket, {"type": "orbit.anchors", "anchors": anchors})
            return True

        if isinstance(msg_type, str) and msg_type.startswith("orbit.push-"):
            return True

        return False

    async def _handle_anchor_hello(self, socket: WebSocket, role: str, user_id: str, msg: dict[str, Any]) -> bool:
        if role != "anchor" or msg.get("type") != "anchor.hello":
            return False

        raw_anchor_id = msg.get("anchorId")
        if not isinstance(raw_anchor_id, str) or not raw_anchor_id.strip():
            raw_anchor_id = msg.get("deviceId")

        anchor_id = raw_anchor_id.strip() if isinstance(raw_anchor_id, str) and raw_anchor_id.strip() else uuid.uuid4().hex
        replaced: WebSocket | None = None

        meta = AnchorMeta(
            id=anchor_id,
            hostname=msg.get("hostname") if isinstance(msg.get("hostname"), str) else "unknown",
            platform=msg.get("platform") if isinstance(msg.get("platform"), str) else "unknown",
            connected_at=msg.get("ts") if isinstance(msg.get("ts"), str) else datetime.now(tz=timezone.utc).isoformat(),
        )

        replaced: WebSocket | None = None
        notifications: list[BroadcastNotification] = []
        async with self._lock:
            existing = self.anchor_id_to_socket.get((user_id, anchor_id))
            if existing and existing is not socket:
                notifications.extend(self._remove_socket_locked(existing, "anchor"))
                replaced = existing

            self.anchor_meta[socket] = meta
            self.anchor_id_to_socket[(user_id, anchor_id)] = socket
            self.socket_to_anchor_id[socket] = anchor_id
            clients = list(self.user_to_client_sockets.get(user_id, set()))

        await self._flush_notifications(notifications)

        if replaced:
            try:
                await replaced.close(code=1000, reason="Replaced by newer connection")
            except Exception:
                pass

        payload = {
            "type": "orbit.anchor-connected",
            "anchor": {
                "id": meta.id,
                "hostname": meta.hostname,
                "platform": meta.platform,
                "connectedAt": meta.connected_at,
            },
        }
        await self._broadcast_json(clients, payload)
        return True

    async def _route_message(
        self,
        socket: WebSocket,
        role: str,
        user_id: str,
        raw_data: str,
        msg: dict[str, Any] | None,
    ) -> None:
        thread_id = extract_thread_id(msg) if msg else None
        anchor_id = extract_anchor_id(msg) if msg else None
        request_id = self._extract_message_id(msg)
        request_key = self._message_id_key(request_id)
        has_method = isinstance(msg.get("method"), str) if msg else False

        if role == "client":
            if request_key and not has_method:
                async with self._lock:
                    response_target = self.pending_anchor_requests.pop((socket, request_key), None)
                if response_target:
                    await self._send_raw(response_target, raw_data)
                    return

            async with self._lock:
                target_socket, failure = self._resolve_client_target_locked(user_id, thread_id, anchor_id)
                if target_socket and thread_id:
                    resolved_anchor_id = self.socket_to_anchor_id.get(target_socket)
                    if resolved_anchor_id:
                        self.thread_to_anchor_id[self._thread_key(user_id, thread_id)] = resolved_anchor_id

                if target_socket and request_key and has_method:
                    self.pending_client_requests[(target_socket, request_key)] = socket

            if target_socket:
                await self._send_raw(target_socket, raw_data)
                return

            if failure:
                await self._send_rpc_error(socket, request_id, failure)
            return

        if request_key and not has_method:
            async with self._lock:
                anchor_source_id = self.socket_to_anchor_id.get(socket)
                if thread_id and anchor_source_id:
                    self.thread_to_anchor_id[self._thread_key(user_id, thread_id)] = anchor_source_id
                response_target = self.pending_client_requests.pop((socket, request_key), None)
            if response_target:
                await self._send_raw(response_target, raw_data)
                return

        async with self._lock:
            anchor_source_id = self.socket_to_anchor_id.get(socket)
            if thread_id and anchor_source_id:
                self.thread_to_anchor_id[self._thread_key(user_id, thread_id)] = anchor_source_id

            if thread_id:
                targets_set = self.thread_to_clients.get(self._thread_key(user_id, thread_id))
                targets = list(targets_set) if targets_set else []
                if not targets:
                    targets = list(self.user_to_client_sockets.get(user_id, set()))
            else:
                targets = list(self.user_to_client_sockets.get(user_id, set()))

            if request_key and has_method:
                for target in targets:
                    self.pending_anchor_requests[(target, request_key)] = socket

        await self._broadcast_raw(targets, raw_data)

    def _resolve_client_target_locked(
        self,
        user_id: str,
        thread_id: str | None,
        anchor_id: str | None,
    ) -> tuple[WebSocket | None, RouteFailure | None]:
        if anchor_id:
            target = self.anchor_id_to_socket.get((user_id, anchor_id))
            if not target:
                return None, RouteFailure(code="anchor_not_found", message="Selected device is unavailable.")
            if thread_id:
                bound_anchor = self.thread_to_anchor_id.get(self._thread_key(user_id, thread_id))
                if bound_anchor and bound_anchor != anchor_id:
                    return None, RouteFailure(code="thread_anchor_mismatch", message="Thread is attached to another device.")
            return target, None

        if thread_id:
            bound_anchor = self.thread_to_anchor_id.get(self._thread_key(user_id, thread_id))
            if bound_anchor:
                target = self.anchor_id_to_socket.get((user_id, bound_anchor))
                if target:
                    return target, None
                return None, RouteFailure(code="anchor_offline", message="Device for this thread is offline.")

            subscribed = list(self.thread_to_anchors.get(self._thread_key(user_id, thread_id), set()))
            if len(subscribed) == 1:
                return subscribed[0], None
            if len(subscribed) > 1:
                return None, RouteFailure(code="thread_anchor_mismatch", message="Thread is attached to multiple devices.")

        anchors = list(self.user_to_anchor_sockets.get(user_id, set()))
        if len(anchors) == 1:
            return anchors[0], None
        if not anchors:
            return None, RouteFailure(code="anchor_offline", message="No devices are connected.")
        return None, RouteFailure(code="anchor_required", message="Select a device before starting a request.")

    def _extract_message_id(self, msg: dict[str, Any] | None) -> str | int | None:
        if not msg:
            return None
        value = msg.get("id")
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, int):
            return value
        return None

    def _message_id_key(self, request_id: str | int | None) -> str | None:
        if request_id is None:
            return None
        return str(request_id)

    async def _send_rpc_error(self, socket: WebSocket, request_id: str | int | None, failure: RouteFailure) -> None:
        if request_id is None:
            return
        await self._send_json(
            socket,
            {
                "id": request_id,
                "error": {
                    "code": -32001,
                    "message": failure.message,
                    "data": {"code": failure.code},
                },
            },
        )

    async def _send_json(self, socket: WebSocket, payload: dict[str, Any]) -> None:
        try:
            await socket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def _broadcast_json(self, sockets: list[WebSocket], payload: dict[str, Any]) -> None:
        await self._broadcast_raw(sockets, json.dumps(payload))

    async def _broadcast_raw(self, sockets: list[WebSocket], raw_data: str) -> None:
        if not sockets:
            return
        await asyncio.gather(*(self._send_raw(socket, raw_data) for socket in sockets), return_exceptions=True)

    async def _flush_notifications(self, notifications: list[BroadcastNotification]) -> None:
        for item in notifications:
            await self._broadcast_json(item.sockets, item.payload)

    async def _send_raw(self, socket: WebSocket, raw_data: str) -> None:
        try:
            await socket.send_text(raw_data)
        except Exception:
            pass

    def _thread_key(self, user_id: str, thread_id: str) -> tuple[str, str]:
        return (user_id, thread_id)

    def _subscribe_socket_locked(
        self,
        socket: WebSocket,
        role: str,
        thread_key: tuple[str, str],
        thread_id: str,
    ) -> None:
        socket_threads = self.client_sockets.get(socket) if role == "client" else self.anchor_sockets.get(socket)
        if socket_threads is not None:
            socket_threads.add(thread_id)

        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors
        thread_map.setdefault(thread_key, set()).add(socket)

    def _unsubscribe_socket_locked(
        self,
        socket: WebSocket,
        role: str,
        thread_key: tuple[str, str],
        thread_id: str,
    ) -> None:
        socket_threads = self.client_sockets.get(socket) if role == "client" else self.anchor_sockets.get(socket)
        if socket_threads is not None:
            socket_threads.discard(thread_id)

        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors
        sockets = thread_map.get(thread_key)
        if sockets:
            sockets.discard(socket)
            if not sockets:
                thread_map.pop(thread_key, None)

    def _remove_socket_locked(self, socket: WebSocket, role: str) -> list[BroadcastNotification]:
        notifications: list[BroadcastNotification] = []
        user_id = self.socket_to_user_id.pop(socket, None)
        source = self.client_sockets if role == "client" else self.anchor_sockets
        by_user = self.user_to_client_sockets if role == "client" else self.user_to_anchor_sockets
        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors

        if user_id:
            user_sockets = by_user.get(user_id)
            if user_sockets:
                user_sockets.discard(socket)
                if not user_sockets:
                    by_user.pop(user_id, None)

        threads = source.pop(socket, set())
        for thread_id in threads:
            if not user_id:
                continue
            thread_key = self._thread_key(user_id, thread_id)
            sockets = thread_map.get(thread_key)
            if sockets:
                sockets.discard(socket)
                if not sockets:
                    thread_map.pop(thread_key, None)

        if role == "client":
            client_id = self.socket_to_client_id.pop(socket, None)
            if client_id and user_id and self.client_id_to_socket.get((user_id, client_id)) is socket:
                self.client_id_to_socket.pop((user_id, client_id), None)
        else:
            anchor_id = self.socket_to_anchor_id.pop(socket, None)
            if anchor_id and user_id and self.anchor_id_to_socket.get((user_id, anchor_id)) is socket:
                self.anchor_id_to_socket.pop((user_id, anchor_id), None)
                stale_thread_keys = [
                    thread_key
                    for thread_key, bound_anchor_id in self.thread_to_anchor_id.items()
                    if thread_key[0] == user_id and bound_anchor_id == anchor_id
                ]
                for thread_key in stale_thread_keys:
                    self.thread_to_anchor_id.pop(thread_key, None)

            meta = self.anchor_meta.pop(socket, None)
            if meta and user_id:
                clients = list(self.user_to_client_sockets.get(user_id, set()))
                payload = {"type": "orbit.anchor-disconnected", "anchorId": meta.id}
                notifications.append(BroadcastNotification(sockets=clients, payload=payload))

        stale_client_requests = [key for key, target in self.pending_client_requests.items() if key[0] is socket or target is socket]
        for key in stale_client_requests:
            self.pending_client_requests.pop(key, None)

        stale_anchor_requests = [key for key, target in self.pending_anchor_requests.items() if key[0] is socket or target is socket]
        for key in stale_anchor_requests:
            self.pending_anchor_requests.pop(key, None)

        return notifications
