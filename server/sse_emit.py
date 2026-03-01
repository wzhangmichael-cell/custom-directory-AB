# server/sse_emit.py
from __future__ import annotations

import json
import os
from typing import Dict, Any, Optional


def sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\n" + f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def emit(model) -> str:
    payload = model.model_dump()
    event_name = payload.get("type", "message")
    return sse(event_name, payload)


def debug_trace_enabled() -> bool:
    return os.getenv("DEBUG_TRACE", "0") == "1"


def emit_debug(node: str, payload: Dict[str, Any]) -> Optional[str]:
    if not debug_trace_enabled():
        return None
    return sse("debug", {"type": "debug", "node": node, "payload": payload})
