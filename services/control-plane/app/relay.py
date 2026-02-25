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


class RelayHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.client_sockets: dict[WebSocket, set[str]] = {}
        self.anchor_sockets: dict[WebSocket, set[str]] = {}
        self.anchor_meta: dict[WebSocket, AnchorMeta] = {}
        self.anchor_id_to_socket: dict[str, WebSocket] = {}
        self.socket_to_anchor_id: dict[WebSocket, str] = {}
        self.client_id_to_socket: dict[str, WebSocket] = {}
        self.socket_to_client_id: dict[WebSocket, str] = {}
        self.thread_to_clients: dict[str, set[WebSocket]] = {}
        self.thread_to_anchors: dict[str, set[WebSocket]] = {}
        self.thread_to_anchor_id: dict[str, str] = {}
        self.pending_client_requests: dict[tuple[WebSocket, str], WebSocket] = {}
        self.pending_anchor_requests: dict[tuple[WebSocket, str], WebSocket] = {}

    async def register(self, socket: WebSocket, role: str, client_id: str | None = None) -> None:
        async with self._lock:
            source = self.client_sockets if role == "client" else self.anchor_sockets

            if role == "client" and client_id:
                existing = self.client_id_to_socket.get(client_id)
                if existing and existing is not socket:
                    await self._remove_socket_locked(existing, "client")
                    try:
                        await existing.close(code=1000, reason="Replaced by newer connection")
                    except Exception:
                        pass
                self.client_id_to_socket[client_id] = socket
                self.socket_to_client_id[socket] = client_id

            source[socket] = set()

        await self._send_json(
            socket,
            {
                "type": "orbit.hello",
                "role": role,
                "ts": datetime.now(tz=timezone.utc).isoformat(),
            },
        )

    async def unregister(self, socket: WebSocket, role: str) -> None:
        async with self._lock:
            await self._remove_socket_locked(socket, role)

    async def handle_message(self, socket: WebSocket, role: str, raw_data: str) -> None:
        try:
            msg = json.loads(raw_data)
            if not isinstance(msg, dict):
                msg = None
        except json.JSONDecodeError:
            msg = None

        if msg and msg.get("type") == "ping":
            await self._send_json(socket, {"type": "pong"})
            return

        if msg and await self._handle_subscription(socket, role, msg):
            return

        if msg and await self._handle_anchor_hello(socket, role, msg):
            return

        await self._route_message(socket, role, raw_data, msg)

    async def _handle_subscription(self, socket: WebSocket, role: str, msg: dict[str, Any]) -> bool:
        msg_type = msg.get("type")
        if msg_type == "orbit.subscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"]
            async with self._lock:
                self._subscribe_socket_locked(socket, role, thread_id)
                if role == "anchor":
                    anchor_id = self.socket_to_anchor_id.get(socket)
                    if anchor_id:
                        self.thread_to_anchor_id[thread_id] = anchor_id
                anchor_targets = list(self.thread_to_anchors.get(thread_id, set())) if role == "client" else []

            await self._send_json(socket, {"type": "orbit.subscribed", "threadId": thread_id})

            if role == "client":
                notice = json.dumps({"type": "orbit.client-subscribed", "threadId": thread_id})
                await self._broadcast_raw(anchor_targets, notice)
            return True

        if msg_type == "orbit.unsubscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"]
            async with self._lock:
                self._unsubscribe_socket_locked(socket, role, thread_id)
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
                    for meta in self.anchor_meta.values()
                ]
            await self._send_json(socket, {"type": "orbit.anchors", "anchors": anchors})
            return True

        if isinstance(msg_type, str) and msg_type.startswith("orbit.push-"):
            return True

        return False

    async def _handle_anchor_hello(self, socket: WebSocket, role: str, msg: dict[str, Any]) -> bool:
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

        async with self._lock:
            existing = self.anchor_id_to_socket.get(anchor_id)
            if existing and existing is not socket:
                await self._remove_socket_locked(existing, "anchor")
                replaced = existing

            self.anchor_meta[socket] = meta
            self.anchor_id_to_socket[anchor_id] = socket
            self.socket_to_anchor_id[socket] = anchor_id
            clients = list(self.client_sockets.keys())

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
                target_socket, failure = self._resolve_client_target_locked(thread_id, anchor_id)
                if target_socket and thread_id:
                    resolved_anchor_id = self.socket_to_anchor_id.get(target_socket)
                    if resolved_anchor_id:
                        self.thread_to_anchor_id[thread_id] = resolved_anchor_id

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
                    self.thread_to_anchor_id[thread_id] = anchor_source_id
                response_target = self.pending_client_requests.pop((socket, request_key), None)
            if response_target:
                await self._send_raw(response_target, raw_data)
                return

        async with self._lock:
            anchor_source_id = self.socket_to_anchor_id.get(socket)
            if thread_id and anchor_source_id:
                self.thread_to_anchor_id[thread_id] = anchor_source_id

            if thread_id:
                targets_set = self.thread_to_clients.get(thread_id)
                targets = list(targets_set) if targets_set else []
                if not targets:
                    targets = list(self.client_sockets.keys())
            else:
                targets = list(self.client_sockets.keys())

            if request_key and has_method:
                for target in targets:
                    self.pending_anchor_requests[(target, request_key)] = socket

        await self._broadcast_raw(targets, raw_data)

    def _resolve_client_target_locked(
        self,
        thread_id: str | None,
        anchor_id: str | None,
    ) -> tuple[WebSocket | None, RouteFailure | None]:
        if anchor_id:
            target = self.anchor_id_to_socket.get(anchor_id)
            if not target:
                return None, RouteFailure(code="anchor_not_found", message="Selected device is unavailable.")
            if thread_id:
                bound_anchor = self.thread_to_anchor_id.get(thread_id)
                if bound_anchor and bound_anchor != anchor_id:
                    return None, RouteFailure(code="thread_anchor_mismatch", message="Thread is attached to another device.")
            return target, None

        if thread_id:
            bound_anchor = self.thread_to_anchor_id.get(thread_id)
            if bound_anchor:
                target = self.anchor_id_to_socket.get(bound_anchor)
                if target:
                    return target, None
                return None, RouteFailure(code="anchor_offline", message="Device for this thread is offline.")

            subscribed = list(self.thread_to_anchors.get(thread_id, set()))
            if len(subscribed) == 1:
                return subscribed[0], None
            if len(subscribed) > 1:
                return None, RouteFailure(code="thread_anchor_mismatch", message="Thread is attached to multiple devices.")

        anchors = list(self.anchor_sockets.keys())
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

    async def _send_raw(self, socket: WebSocket, raw_data: str) -> None:
        try:
            await socket.send_text(raw_data)
        except Exception:
            pass

    def _subscribe_socket_locked(self, socket: WebSocket, role: str, thread_id: str) -> None:
        socket_threads = self.client_sockets.get(socket) if role == "client" else self.anchor_sockets.get(socket)
        if socket_threads is not None:
            socket_threads.add(thread_id)

        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors
        thread_map.setdefault(thread_id, set()).add(socket)

    def _unsubscribe_socket_locked(self, socket: WebSocket, role: str, thread_id: str) -> None:
        socket_threads = self.client_sockets.get(socket) if role == "client" else self.anchor_sockets.get(socket)
        if socket_threads is not None:
            socket_threads.discard(thread_id)

        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors
        sockets = thread_map.get(thread_id)
        if sockets:
            sockets.discard(socket)
            if not sockets:
                thread_map.pop(thread_id, None)

    async def _remove_socket_locked(self, socket: WebSocket, role: str) -> None:
        source = self.client_sockets if role == "client" else self.anchor_sockets
        thread_map = self.thread_to_clients if role == "client" else self.thread_to_anchors

        threads = source.pop(socket, set())
        for thread_id in threads:
            sockets = thread_map.get(thread_id)
            if sockets:
                sockets.discard(socket)
                if not sockets:
                    thread_map.pop(thread_id, None)

        if role == "client":
            client_id = self.socket_to_client_id.pop(socket, None)
            if client_id and self.client_id_to_socket.get(client_id) is socket:
                self.client_id_to_socket.pop(client_id, None)
        else:
            anchor_id = self.socket_to_anchor_id.pop(socket, None)
            if anchor_id and self.anchor_id_to_socket.get(anchor_id) is socket:
                self.anchor_id_to_socket.pop(anchor_id, None)

            meta = self.anchor_meta.pop(socket, None)
            if meta:
                clients = list(self.client_sockets.keys())
                payload = {"type": "orbit.anchor-disconnected", "anchorId": meta.id}
                await self._broadcast_json(clients, payload)

        stale_client_requests = [key for key, target in self.pending_client_requests.items() if key[0] is socket or target is socket]
        for key in stale_client_requests:
            self.pending_client_requests.pop(key, None)

        stale_anchor_requests = [key for key, target in self.pending_anchor_requests.items() if key[0] is socket or target is socket]
        for key in stale_anchor_requests:
            self.pending_anchor_requests.pop(key, None)
