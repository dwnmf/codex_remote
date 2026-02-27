from __future__ import annotations

from typing import Any


def as_record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    return None


def _normalize_id(candidate: Any) -> str | None:
    if isinstance(candidate, str):
        normalized = candidate.strip()
        return normalized or None
    if isinstance(candidate, int) and not isinstance(candidate, bool):
        return str(candidate)
    return None


def _extract_id(message: dict[str, Any], *, singular_key: str) -> str | None:
    params = as_record(message.get("params"))
    result = as_record(message.get("result"))
    from_params = as_record(params.get(singular_key)) if params else None
    from_result = as_record(result.get(singular_key)) if result else None

    candidates: list[Any] = [
        params.get(f"{singular_key}Id") if params else None,
        params.get(f"{singular_key}_id") if params else None,
        result.get(f"{singular_key}Id") if result else None,
        result.get(f"{singular_key}_id") if result else None,
        from_params.get("id") if from_params else None,
        from_result.get("id") if from_result else None,
    ]

    for candidate in candidates:
        normalized = _normalize_id(candidate)
        if normalized is not None:
            return normalized
    return None


def extract_thread_id(message: dict[str, Any]) -> str | None:
    return _extract_id(message, singular_key="thread")


def extract_anchor_id(message: dict[str, Any]) -> str | None:
    return _extract_id(message, singular_key="anchor")
