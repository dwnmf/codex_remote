from __future__ import annotations

import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.protocol import extract_anchor_id, extract_thread_id


@pytest.mark.parametrize(
    ("extractor", "message", "expected"),
    [
        (
            extract_thread_id,
            {"params": {"threadId": "  thread-1  "}},
            "thread-1",
        ),
        (
            extract_thread_id,
            {"params": {"thread_id": 42}},
            "42",
        ),
        (
            extract_anchor_id,
            {"result": {"anchorId": "  anchor-a\t"}},
            "anchor-a",
        ),
        (
            extract_anchor_id,
            {"result": {"anchor_id": 9001}},
            "9001",
        ),
    ],
)
def test_extract_id_normalizes_strings_and_ints(extractor, message, expected) -> None:
    assert extractor(message) == expected


@pytest.mark.parametrize(
    ("extractor", "message", "expected"),
    [
        (
            extract_thread_id,
            {"params": {"threadId": True}, "result": {"threadId": "thread-from-result"}},
            "thread-from-result",
        ),
        (
            extract_anchor_id,
            {"params": {"anchorId": False}, "result": {"anchorId": "anchor-from-result"}},
            "anchor-from-result",
        ),
    ],
)
def test_extract_id_ignores_bool_values(extractor, message, expected) -> None:
    assert extractor(message) == expected


def test_extract_thread_id_preserves_candidate_precedence() -> None:
    message = {
        "params": {"threadId": "from-params", "thread": {"id": "nested-params"}},
        "result": {"threadId": "from-result", "thread": {"id": "nested-result"}},
    }
    assert extract_thread_id(message) == "from-params"


def test_extract_anchor_id_falls_back_to_nested_id() -> None:
    message = {
        "params": {"anchorId": "", "anchor_id": "   ", "anchor": {"id": " nested-anchor "}},
        "result": {"anchorId": "  ", "anchor_id": None, "anchor": {"id": "result-anchor"}},
    }
    assert extract_anchor_id(message) == "nested-anchor"


@pytest.mark.parametrize("extractor", [extract_thread_id, extract_anchor_id])
def test_extract_id_handles_malformed_shapes(extractor) -> None:
    message = {
        "params": ["not-a-record"],
        "result": {"threadId": None, "anchorId": None, "thread": "x", "anchor": "y"},
    }
    assert extractor(message) is None
