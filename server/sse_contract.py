# server/sse_contract.py
from __future__ import annotations

from typing import Literal, Optional, Dict, Any

from pydantic import BaseModel


class SSEDelta(BaseModel):
    type: Literal["delta"] = "delta"
    text: str


class SSEDone(BaseModel):
    type: Literal["done"] = "done"
    thread_id: str
    text: str


class SSEError(BaseModel):
    type: Literal["error"] = "error"
    message: str
    code: Optional[str] = None
    detail: Optional[Dict[str, Any]] = None


class SSEStatus(BaseModel):
    type: Literal["status"] = "status"
    phase: Literal["thinking", "tool", "answering"] = "thinking"
    node: Optional[str] = None
    label: Optional[str] = None
