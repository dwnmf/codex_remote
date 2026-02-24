from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from .protocol import extract_thread_id


@dataclass
class AnchorMeta:
    id: str
    hostname: str
    platform: str
    connected_at: str


class RelayHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.client_sockets: dict[WebSocket, set[str]] = {}
        self.anchor_sockets: dict[WebSocket, set[str]] = {}
        self.anchor_meta: dict[WebSocket, AnchorMeta] = {}
        self.client_id_to_socket: dict[str, WebSocket] = {}
        self.socket_to_client_id: dict[WebSocket, str] = {}
        self.thread_to_clients: dict[str, set[WebSocket]] = {}
        self.thread_to_anchors: dict[str, set[WebSocket]] = {}

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

        await self._route_message(role, raw_data, msg)

    async def _handle_subscription(self, socket: WebSocket, role: str, msg: dict[str, Any]) -> bool:
        msg_type = msg.get("type")
        if msg_type == "orbit.subscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"]
            async with self._lock:
                self._subscribe_socket_locked(socket, role, thread_id)
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

        meta = AnchorMeta(
            id=uuid.uuid4().hex,
            hostname=msg.get("hostname") if isinstance(msg.get("hostname"), str) else "unknown",
            platform=msg.get("platform") if isinstance(msg.get("platform"), str) else "unknown",
            connected_at=msg.get("ts") if isinstance(msg.get("ts"), str) else datetime.now(tz=timezone.utc).isoformat(),
        )

        async with self._lock:
            self.anchor_meta[socket] = meta
            clients = list(self.client_sockets.keys())

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

    async def _route_message(self, role: str, raw_data: str, msg: dict[str, Any] | None) -> None:
        thread_id = extract_thread_id(msg) if msg else None

        if role == "client":
            async with self._lock:
                targets = list(self.anchor_sockets.keys())
            await self._broadcast_raw(targets, raw_data)
            return

        async with self._lock:
            if thread_id:
                targets_set = self.thread_to_clients.get(thread_id)
                targets = list(targets_set) if targets_set else []
                if not targets:
                    targets = list(self.client_sockets.keys())
            else:
                targets = list(self.client_sockets.keys())

        await self._broadcast_raw(targets, raw_data)

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
            return

        meta = self.anchor_meta.pop(socket, None)
        if meta:
            clients = list(self.client_sockets.keys())
            payload = {"type": "orbit.anchor-disconnected", "anchorId": meta.id}
            await self._broadcast_json(clients, payload)
