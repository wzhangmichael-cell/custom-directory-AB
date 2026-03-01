# server/openai_workflow.py
from __future__ import annotations

import asyncio
import re
from typing import Iterator, List, Dict, Any

from sse_contract import SSEStatus, SSEError, SSEDone
from sse_emit import emit, emit_debug
from workflow_export import run_workflow, WorkflowInput


def detect_language(text: str) -> str:
    """
    Very lightweight language detection.
    Returns: 'zh', 'en', or 'other'
    """
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    if re.search(r"[a-zA-Z]", text):
        return "en"
    return "other"


def _run_workflow_and_extract_text(
    thread_id: str, user_text: str, lang: str
) -> tuple[str, List[Dict[str, Any]]]:
    status_events: List[Dict[str, Any]] = []

    def emit_status(kind: str, node: str, detail: Any = None) -> None:
        if kind == "debug":
            status_events.append({"type": "debug", "node": node, "payload": detail})
            return

        status_events.append({"type": "status", "phase": kind, "node": node, "label": detail})

    result = asyncio.run(
        run_workflow(
            WorkflowInput(input_as_text=user_text),
            emit_status=emit_status,
            lang=lang,
        )
    )
    if isinstance(result, dict):
        text = str(result.get("output_text") or result.get("text") or "")
    else:
        text = str(result or "")
    return text, status_events


def stream_workflow_response(thread_id: str, user_text: str) -> Iterator[str]:
    try:
        lang = detect_language(user_text)
        # 1) 状态：开始思考
        yield emit(SSEStatus(phase="thinking", node="run_workflow"))

        # 2) 运行 workflow（保留你现有逻辑）
        text, status_events = _run_workflow_and_extract_text(thread_id, user_text, lang=lang)

        for s in status_events:
            if s.get("type") == "debug":
                evt = emit_debug(
                    node=str(s.get("node") or ""),
                    payload=s.get("payload") if isinstance(s.get("payload"), dict) else {},
                )
                if evt:
                    yield evt
                continue

            yield emit(
                SSEStatus(
                    phase=s.get("phase", "tool"),
                    node=s.get("node"),
                    label=s.get("label"),
                )
            )

        if not text:
            text = "抱歉，我没有生成有效回答。"

        # 3) 状态：准备输出
        yield emit(SSEStatus(phase="answering", node="finalize"))

        # 4) done（合同固定）
        yield emit(SSEDone(thread_id=thread_id, text=text))

    except Exception as e:
        # 5) error（合同固定）
        yield emit(SSEError(message=str(e), code="WORKFLOW_FAILED"))

        # 注意：不要在这里补 done。
        # done 的兜底由 ensure_done 统一处理（护栏3）
