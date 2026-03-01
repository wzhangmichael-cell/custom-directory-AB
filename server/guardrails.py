# server/guardrails.py
from __future__ import annotations

from typing import Iterator, Callable

from sse_contract import SSEError, SSEDone
from sse_emit import emit

DEFAULT_FALLBACK_TEXT = "抱歉，系统暂时出错，请稍后再试。"


def ensure_done(
    thread_id: str,
    generator_fn: Callable[[], Iterator[str]],
    fallback_text: str = DEFAULT_FALLBACK_TEXT,
) -> Iterator[str]:
    sent_done = False
    try:
        for chunk in generator_fn():
            if "event: done" in chunk:
                sent_done = True
            yield chunk
    except Exception as e:
        yield emit(SSEError(message=str(e), code="STREAM_EXCEPTION"))
    finally:
        if not sent_done:
            yield emit(SSEDone(thread_id=thread_id, text=fallback_text))
