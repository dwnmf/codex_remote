from __future__ import annotations

from typing import Any


def as_record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    return None


def extract_thread_id(message: dict[str, Any]) -> str | None:
    params = as_record(message.get("params"))
    result = as_record(message.get("result"))
    thread_from_params = as_record(params.get("thread")) if params else None
    thread_from_result = as_record(result.get("thread")) if result else None

    candidates: list[Any] = [
        params.get("threadId") if params else None,
        params.get("thread_id") if params else None,
        result.get("threadId") if result else None,
        result.get("thread_id") if result else None,
        thread_from_params.get("id") if thread_from_params else None,
        thread_from_result.get("id") if thread_from_result else None,
    ]

    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate
        if isinstance(candidate, int):
            return str(candidate)
    return None


def extract_anchor_id(message: dict[str, Any]) -> str | None:
    params = as_record(message.get("params"))
    result = as_record(message.get("result"))
    anchor_from_params = as_record(params.get("anchor")) if params else None
    anchor_from_result = as_record(result.get("anchor")) if result else None

    candidates: list[Any] = [
        params.get("anchorId") if params else None,
        params.get("anchor_id") if params else None,
        result.get("anchorId") if result else None,
        result.get("anchor_id") if result else None,
        anchor_from_params.get("id") if anchor_from_params else None,
        anchor_from_result.get("id") if anchor_from_result else None,
    ]

    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate
        if isinstance(candidate, int):
            return str(candidate)
    return None
