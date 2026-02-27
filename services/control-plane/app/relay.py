from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from .db import Database, RelayArtifactRecord
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


@dataclass
class MultiDispatchAggregate:
    requester_socket: WebSocket
    request_id: str
    ordered_anchor_ids: list[str]
    results: dict[str, dict[str, Any]]
    pending_anchor_ids: set[str]
    timeout_task: asyncio.Task[None] | None


class RelayHub:
    REPLAY_LIMIT = 100
    MULTI_DISPATCH_TIMEOUT_SEC = 15

    def __init__(self, database: Database) -> None:
        self._lock = asyncio.Lock()
        self.db = database
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
        self.pending_multi_dispatch: dict[tuple[WebSocket, str], MultiDispatchAggregate] = {}
        self.pending_multi_dispatch_responses: dict[tuple[WebSocket, str], tuple[tuple[WebSocket, str], str]] = {}

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

        if msg and await self._handle_control(socket, role, user_id, msg):
            return

        if msg and await self._handle_anchor_hello(socket, role, user_id, msg):
            return

        await self._route_message(socket, role, user_id, raw_data, msg)

    async def _handle_control(self, socket: WebSocket, role: str, user_id: str, msg: dict[str, Any]) -> bool:
        msg_type = msg.get("type")
        if msg_type == "orbit.subscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"].strip()
            if not thread_id:
                return True
            async with self._lock:
                thread_key = self._thread_key(user_id, thread_id)
                self._subscribe_socket_locked(socket, role, thread_key, thread_id)
                if role == "anchor":
                    anchor_id = self.socket_to_anchor_id.get(socket)
                    if anchor_id:
                        self.thread_to_anchor_id[thread_key] = anchor_id
                        self.db.set_relay_thread_anchor(user_id, thread_id, anchor_id)
                anchor_targets = list(self.thread_to_anchors.get(thread_key, set())) if role == "client" else []

            await self._send_json(socket, {"type": "orbit.subscribed", "threadId": thread_id})

            if role == "client":
                await self._replay_thread_state(socket, user_id, thread_id)
                notice = json.dumps({"type": "orbit.client-subscribed", "threadId": thread_id})
                await self._broadcast_raw(anchor_targets, notice)
            return True

        if msg_type == "orbit.unsubscribe" and isinstance(msg.get("threadId"), str):
            thread_id = msg["threadId"].strip()
            if not thread_id:
                return True
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

        if msg_type == "orbit.artifacts.list" and role == "client":
            await self._handle_artifact_list(socket, user_id, msg)
            return True

        if msg_type == "orbit.multi-dispatch" and role == "client":
            await self._handle_multi_dispatch(socket, user_id, msg)
            return True

        if isinstance(msg_type, str) and msg_type.startswith("orbit.push-"):
            return True

        return False

    async def _handle_artifact_list(self, socket: WebSocket, user_id: str, msg: dict[str, Any]) -> None:
        thread_id = msg.get("threadId") if isinstance(msg.get("threadId"), str) else None
        limit = msg.get("limit")
        before_id = msg.get("beforeId")
        request_id = self._coerce_request_key(msg.get("requestId")) or self._coerce_request_key(msg.get("id"))

        safe_limit = limit if isinstance(limit, int) else 50
        safe_before = before_id if isinstance(before_id, int) else None
        records = self.db.list_relay_artifacts(user_id=user_id, thread_id=thread_id, limit=safe_limit, before_id=safe_before)

        payload: dict[str, Any] = {
            "type": "orbit.artifacts",
            "threadId": thread_id,
            "artifacts": [self._serialize_artifact(record) for record in records],
            "nextBeforeId": records[-1].id if records else None,
        }
        if request_id:
            payload["requestId"] = request_id
        await self._send_json(socket, payload)

    async def _handle_multi_dispatch(self, socket: WebSocket, user_id: str, msg: dict[str, Any]) -> None:
        request_id = self._coerce_request_key(msg.get("requestId")) or self._coerce_request_key(msg.get("id")) or uuid.uuid4().hex
        template = self._extract_multi_dispatch_template(msg)
        if not template:
            await self._send_json(
                socket,
                {
                    "type": "orbit.multi-dispatch.result",
                    "requestId": request_id,
                    "results": [],
                    "error": {"code": "invalid_request", "message": "Provide a request payload with a method."},
                },
            )
            return

        requested_anchor_ids = self._extract_multi_dispatch_anchor_ids(msg)
        prepared_sends: list[tuple[WebSocket, str]] = []
        dispatch_key = (socket, request_id)
        completion: tuple[WebSocket, dict[str, Any]] | None = None

        async with self._lock:
            if not requested_anchor_ids:
                requested_anchor_ids = [
                    anchor_id
                    for (known_user_id, anchor_id), _ in self.anchor_id_to_socket.items()
                    if known_user_id == user_id
                ]

            aggregate = MultiDispatchAggregate(
                requester_socket=socket,
                request_id=request_id,
                ordered_anchor_ids=requested_anchor_ids,
                results={},
                pending_anchor_ids=set(),
                timeout_task=None,
            )

            for anchor_id in requested_anchor_ids:
                target = self.anchor_id_to_socket.get((user_id, anchor_id))
                if not target:
                    aggregate.results[anchor_id] = {
                        "ok": False,
                        "error": {"code": "anchor_not_found", "message": "Selected device is unavailable."},
                    }
                    continue

                outbound = self._copy_dict(template)
                sub_id = f"{self._coerce_request_key(outbound.get('id')) or request_id}:{anchor_id}:{uuid.uuid4().hex[:8]}"
                outbound["id"] = sub_id
                prepared_sends.append((target, json.dumps(outbound)))
                aggregate.pending_anchor_ids.add(anchor_id)
                self.pending_multi_dispatch_responses[(target, sub_id)] = (dispatch_key, anchor_id)

            if aggregate.pending_anchor_ids:
                self.pending_multi_dispatch[dispatch_key] = aggregate
                aggregate.timeout_task = asyncio.create_task(self._expire_multi_dispatch(dispatch_key))
            else:
                completion = self._build_completed_multi_dispatch_locked(aggregate)

        if completion:
            await self._send_json(completion[0], completion[1])
            return

        await asyncio.gather(*(self._send_raw(target, payload) for target, payload in prepared_sends), return_exceptions=True)

    def _extract_multi_dispatch_template(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        for key in ("request", "payload"):
            candidate = msg.get(key)
            if isinstance(candidate, dict) and isinstance(candidate.get("method"), str):
                return self._copy_dict(candidate)

        if isinstance(msg.get("method"), str):
            template: dict[str, Any] = {"method": msg["method"]}
            if "params" in msg and isinstance(msg.get("params"), dict):
                template["params"] = self._copy_dict(msg["params"])
            if "dispatchRequestId" in msg:
                template["id"] = msg.get("dispatchRequestId")
            return template

        return None

    def _extract_multi_dispatch_anchor_ids(self, msg: dict[str, Any]) -> list[str]:
        source = msg.get("anchorIds")
        if not isinstance(source, list):
            source = msg.get("anchors")
            if not isinstance(source, list):
                return []

        result: list[str] = []
        seen: set[str] = set()
        for item in source:
            if not isinstance(item, str):
                continue
            anchor_id = item.strip()
            if not anchor_id or anchor_id in seen:
                continue
            seen.add(anchor_id)
            result.append(anchor_id)
        return result

    async def _expire_multi_dispatch(self, dispatch_key: tuple[WebSocket, str]) -> None:
        await asyncio.sleep(self.MULTI_DISPATCH_TIMEOUT_SEC)
        completion: tuple[WebSocket, dict[str, Any]] | None = None
        async with self._lock:
            aggregate = self.pending_multi_dispatch.get(dispatch_key)
            if not aggregate:
                return

            for anchor_id in list(aggregate.pending_anchor_ids):
                aggregate.results[anchor_id] = {
                    "ok": False,
                    "error": {"code": "timeout", "message": "No response before timeout."},
                }
                aggregate.pending_anchor_ids.discard(anchor_id)

            completion = self._finalize_multi_dispatch_locked(dispatch_key)

        if completion:
            await self._send_json(completion[0], completion[1])

    def _finalize_multi_dispatch_locked(self, dispatch_key: tuple[WebSocket, str]) -> tuple[WebSocket, dict[str, Any]] | None:
        aggregate = self.pending_multi_dispatch.pop(dispatch_key, None)
        if not aggregate:
            return None

        if aggregate.timeout_task:
            aggregate.timeout_task.cancel()

        stale_keys = [key for key, binding in self.pending_multi_dispatch_responses.items() if binding[0] == dispatch_key]
        for key in stale_keys:
            self.pending_multi_dispatch_responses.pop(key, None)

        return self._build_completed_multi_dispatch_locked(aggregate)

    def _build_completed_multi_dispatch_locked(self, aggregate: MultiDispatchAggregate) -> tuple[WebSocket, dict[str, Any]]:
        ordered_results: list[dict[str, Any]] = []
        for anchor_id in aggregate.ordered_anchor_ids:
            entry = aggregate.results.get(anchor_id)
            if not entry:
                entry = {
                    "ok": False,
                    "error": {"code": "no_result", "message": "No result was collected for this anchor."},
                }
            ordered_results.append({"anchorId": anchor_id, **entry})

        payload = {
            "type": "orbit.multi-dispatch.result",
            "requestId": aggregate.request_id,
            "results": ordered_results,
            "completedAt": datetime.now(tz=timezone.utc).isoformat(),
        }
        return aggregate.requester_socket, payload

    async def _replay_thread_state(self, socket: WebSocket, user_id: str, thread_id: str) -> None:
        state = self.db.get_relay_thread_state(user_id, thread_id)
        if state and state.bound_anchor_id:
            async with self._lock:
                self.thread_to_anchor_id.setdefault(self._thread_key(user_id, thread_id), state.bound_anchor_id)

        replay_messages = self.db.list_relay_thread_messages(user_id, thread_id, limit=self.REPLAY_LIMIT)
        payload: dict[str, Any] = {
            "type": "orbit.relay-state",
            "threadId": thread_id,
            "boundAnchorId": state.bound_anchor_id if state else None,
            "turn": (
                {"id": state.turn_id, "status": state.turn_status}
                if state and (state.turn_id or state.turn_status)
                else None
            ),
            "replayed": len(replay_messages),
        }
        await self._send_json(socket, payload)
        for record in replay_messages:
            await self._send_raw(socket, record.raw_data)

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
        thread_id = self._extract_thread_id(msg)
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
                        thread_key = self._thread_key(user_id, thread_id)
                        self.thread_to_anchor_id[thread_key] = resolved_anchor_id
                        self.db.set_relay_thread_anchor(user_id, thread_id, resolved_anchor_id)

                if target_socket and request_key and has_method:
                    self.pending_client_requests[(target_socket, request_key)] = socket

            if target_socket:
                await self._send_raw(target_socket, raw_data)
                return

            if failure:
                await self._send_rpc_error(socket, request_id, failure)
            return

        if request_key and not has_method:
            completion: tuple[WebSocket, dict[str, Any]] | None = None
            response_target: WebSocket | None = None
            async with self._lock:
                anchor_source_id = self.socket_to_anchor_id.get(socket)
                if thread_id and anchor_source_id:
                    thread_key = self._thread_key(user_id, thread_id)
                    self.thread_to_anchor_id[thread_key] = anchor_source_id
                    self.db.set_relay_thread_anchor(user_id, thread_id, anchor_source_id)

                multi_binding = self.pending_multi_dispatch_responses.pop((socket, request_key), None)
                if multi_binding:
                    dispatch_key, source_anchor_id = multi_binding
                    aggregate = self.pending_multi_dispatch.get(dispatch_key)
                    if aggregate:
                        aggregate.pending_anchor_ids.discard(source_anchor_id)
                        aggregate.results[source_anchor_id] = {
                            "ok": True,
                            "response": self._copy_dict(msg) if msg else {"raw": raw_data},
                        }
                        if not aggregate.pending_anchor_ids:
                            completion = self._finalize_multi_dispatch_locked(dispatch_key)
                else:
                    response_target = self.pending_client_requests.pop((socket, request_key), None)

            if completion:
                await self._send_json(completion[0], completion[1])
                return

            if response_target:
                if thread_id:
                    self._capture_relay_state(user_id, thread_id, self.socket_to_anchor_id.get(socket), raw_data, msg)
                await self._send_raw(response_target, raw_data)
                return

        async with self._lock:
            anchor_source_id = self.socket_to_anchor_id.get(socket)
            if thread_id and anchor_source_id:
                thread_key = self._thread_key(user_id, thread_id)
                self.thread_to_anchor_id[thread_key] = anchor_source_id
                self.db.set_relay_thread_anchor(user_id, thread_id, anchor_source_id)

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

        if thread_id:
            self._capture_relay_state(user_id, thread_id, self.socket_to_anchor_id.get(socket), raw_data, msg)

        await self._broadcast_raw(targets, raw_data)

    def _capture_relay_state(
        self,
        user_id: str,
        thread_id: str,
        anchor_id: str | None,
        raw_data: str,
        msg: dict[str, Any] | None,
    ) -> None:
        self.db.append_relay_thread_message(user_id, thread_id, raw_data)
        if anchor_id:
            self.db.set_relay_thread_anchor(user_id, thread_id, anchor_id)

        if not msg:
            return

        turn_id, turn_status = self._extract_turn_state(msg)
        if turn_id is not None or turn_status is not None:
            existing = self.db.get_relay_thread_state(user_id, thread_id)
            persisted_turn_id = turn_id if turn_id is not None else (existing.turn_id if existing else None)
            persisted_turn_status = turn_status if turn_status is not None else (existing.turn_status if existing else None)
            self.db.set_relay_thread_turn(user_id, thread_id, persisted_turn_id, persisted_turn_status)

        artifact = self._extract_artifact(msg, thread_id, anchor_id, user_id)
        if artifact:
            self.db.upsert_relay_artifact(
                user_id=user_id,
                thread_id=artifact.thread_id,
                turn_id=artifact.turn_id,
                anchor_id=artifact.anchor_id,
                item_id=artifact.item_id,
                artifact_type=artifact.artifact_type,
                item_type=artifact.item_type,
                summary=artifact.summary,
                payload_json=artifact.payload_json,
            )

    def _extract_artifact(
        self,
        msg: dict[str, Any],
        thread_id: str,
        anchor_id: str | None,
        user_id: str,
    ) -> RelayArtifactRecord | None:
        if msg.get("method") != "item/completed":
            return None

        params = msg.get("params")
        if not isinstance(params, dict):
            return None

        item = params.get("item")
        if not isinstance(item, dict):
            return None

        item_type = item.get("type")
        if not isinstance(item_type, str):
            return None

        artifact_type_map = {
            "commandExecution": "command",
            "fileChange": "file",
            "imageView": "image",
            "mcpToolCall": "tool",
            "webSearch": "tool",
            "collabAgentToolCall": "tool",
        }
        artifact_type = artifact_type_map.get(item_type)
        if not artifact_type:
            return None

        item_id_value = item.get("id")
        item_id = item_id_value.strip() if isinstance(item_id_value, str) and item_id_value.strip() else uuid.uuid4().hex
        turn_id = self._extract_turn_id(msg, item)
        if not turn_id:
            state = self.db.get_relay_thread_state(user_id, thread_id)
            turn_id = state.turn_id if state else None

        summary = self._summarize_artifact(item_type, item)
        payload_json = json.dumps(item, default=str)
        return RelayArtifactRecord(
            id=0,
            user_id=user_id,
            thread_id=thread_id,
            turn_id=turn_id,
            anchor_id=anchor_id,
            item_id=item_id,
            artifact_type=artifact_type,
            item_type=item_type,
            summary=summary,
            payload_json=payload_json,
            created_at=0,
        )

    def _serialize_artifact(self, record: RelayArtifactRecord) -> dict[str, Any]:
        payload: Any
        try:
            payload = json.loads(record.payload_json)
        except Exception:
            payload = record.payload_json

        return {
            "id": record.id,
            "threadId": record.thread_id,
            "turnId": record.turn_id,
            "anchorId": record.anchor_id,
            "itemId": record.item_id,
            "artifactType": record.artifact_type,
            "itemType": record.item_type,
            "summary": record.summary,
            "payload": payload,
            "createdAt": record.created_at,
        }

    def _summarize_artifact(self, item_type: str, item: dict[str, Any]) -> str | None:
        if item_type == "commandExecution":
            command = item.get("command") if isinstance(item.get("command"), str) else ""
            exit_code = item.get("exitCode") if isinstance(item.get("exitCode"), int) else None
            if command and exit_code is not None:
                return f"{command} (exit={exit_code})"
            return command or None

        if item_type == "fileChange":
            changes = item.get("changes")
            if not isinstance(changes, list):
                return None
            paths: list[str] = []
            for entry in changes:
                if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                    paths.append(entry["path"])
            if not paths:
                return None
            return ", ".join(paths[:5])

        if item_type == "imageView":
            for key in ("path", "imagePath", "image_url", "imageUrl", "url"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return "image artifact"

        if item_type == "mcpToolCall":
            tool = item.get("tool")
            if isinstance(tool, str) and tool.strip():
                return tool.strip()
            return "mcp tool call"

        if item_type == "webSearch":
            query = item.get("query")
            if isinstance(query, str) and query.strip():
                return query.strip()
            return "web search"

        if item_type == "collabAgentToolCall":
            tool = item.get("tool")
            if isinstance(tool, str) and tool.strip():
                return tool.strip()
            return "collaboration tool"

        return None

    def _extract_turn_state(self, msg: dict[str, Any]) -> tuple[str | None, str | None]:
        method = msg.get("method")
        if method not in {"turn/started", "turn/completed"}:
            return None, None

        params = msg.get("params")
        if not isinstance(params, dict):
            return None, None

        turn = params.get("turn")
        turn_id = None
        turn_status = None
        if isinstance(turn, dict):
            if isinstance(turn.get("id"), str) and turn["id"].strip():
                turn_id = turn["id"].strip()
            if isinstance(turn.get("status"), str) and turn["status"].strip():
                turn_status = turn["status"].strip()

        if not turn_id and isinstance(params.get("turnId"), str) and params["turnId"].strip():
            turn_id = params["turnId"].strip()
        if not turn_status and isinstance(params.get("status"), str) and params["status"].strip():
            turn_status = params["status"].strip()

        return turn_id, turn_status

    def _extract_turn_id(self, msg: dict[str, Any], item: dict[str, Any]) -> str | None:
        params = msg.get("params")
        if isinstance(params, dict):
            for key in ("turnId", "turn_id"):
                value = params.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

        for key in ("turnId", "turn_id"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        return None

    def _extract_thread_id(self, msg: dict[str, Any] | None) -> str | None:
        if not msg:
            return None

        thread_id = extract_thread_id(msg)
        if thread_id:
            return thread_id

        params = msg.get("params")
        if not isinstance(params, dict):
            return None

        for key in ("threadId", "thread_id"):
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        item = params.get("item")
        if isinstance(item, dict):
            for key in ("threadId", "thread_id"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

        return None

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
                thread_key = self._thread_key(user_id, thread_id)
                bound_anchor = self.thread_to_anchor_id.get(thread_key)
                if not bound_anchor:
                    state = self.db.get_relay_thread_state(user_id, thread_id)
                    if state and state.bound_anchor_id:
                        bound_anchor = state.bound_anchor_id
                        self.thread_to_anchor_id[thread_key] = bound_anchor
                if bound_anchor and bound_anchor != anchor_id:
                    return None, RouteFailure(code="thread_anchor_mismatch", message="Thread is attached to another device.")
            return target, None

        if thread_id:
            thread_key = self._thread_key(user_id, thread_id)
            bound_anchor = self.thread_to_anchor_id.get(thread_key)
            if not bound_anchor:
                state = self.db.get_relay_thread_state(user_id, thread_id)
                if state and state.bound_anchor_id:
                    bound_anchor = state.bound_anchor_id
                    self.thread_to_anchor_id[thread_key] = bound_anchor

            if bound_anchor:
                target = self.anchor_id_to_socket.get((user_id, bound_anchor))
                if target:
                    return target, None
                return None, RouteFailure(code="anchor_offline", message="Device for this thread is offline.")

            subscribed = list(self.thread_to_anchors.get(thread_key, set()))
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

    def _coerce_request_key(self, value: Any) -> str | None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, int):
            return str(value)
        return None

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

    def _copy_dict(self, value: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(value))

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
                    self.db.set_relay_thread_anchor(user_id, thread_key[1], None)

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

        stale_dispatches = [key for key in self.pending_multi_dispatch.keys() if key[0] is socket]
        for key in stale_dispatches:
            aggregate = self.pending_multi_dispatch.pop(key, None)
            if aggregate and aggregate.timeout_task:
                aggregate.timeout_task.cancel()

        stale_dispatch_bindings = [
            key
            for key, binding in self.pending_multi_dispatch_responses.items()
            if key[0] is socket or binding[0][0] is socket
        ]
        for key in stale_dispatch_bindings:
            self.pending_multi_dispatch_responses.pop(key, None)

        return notifications
