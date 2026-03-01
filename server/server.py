import asyncio
import os
from pathlib import Path
from typing import AsyncIterator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel

from guardrails import ensure_done
from openai_workflow import stream_workflow_response
from sse_emit import sse


load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)
print("[env] OPENAI_API_KEY suffix:", (os.getenv("OPENAI_API_KEY") or "")[-4:])

app = FastAPI(title="Custom UI Workflow Chat Server")
STATIC_DIR = Path(__file__).resolve().parent / "static"

raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
allowed_origins = [o.strip() for o in raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    thread_id: Optional[str] = None
    message: str


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    format: Optional[str] = None


def _get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing")
    return OpenAI(api_key=api_key)


def _sse_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/healthz")
async def healthz() -> dict:
    return await health()


@app.post("/api/chat")
def chat(req: ChatRequest):
    thread_id = (req.thread_id or "").strip() or "thread_local"
    message = (req.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message cannot be empty")

    def gen():
        return stream_workflow_response(thread_id, message)

    stream = ensure_done(thread_id, gen)

    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@app.post("/api/mock")
async def mock_chat():
    async def event_stream() -> AsyncIterator[str]:
        text = "这是一个无需 OpenAI 的 SSE 自测流。"
        for ch in text:
            yield sse("delta", {"type": "delta", "text": ch})
            await asyncio.sleep(0.05)
        yield sse("done", {"type": "done", "thread_id": "mock_thread_123"})
        await asyncio.sleep(0.05)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@app.post("/api/stt")
async def stt(file: UploadFile = File(...)):
    client = _get_openai_client()
    audio_bytes = await file.read()
    if not audio_bytes:
        return JSONResponse({"error": "empty file"}, status_code=400)

    transcription = client.audio.transcriptions.create(
        model="whisper-1",
        file=(file.filename or "audio.webm", audio_bytes),
    )
    return {"text": getattr(transcription, "text", "")}


@app.post("/api/tts")
async def tts(req: TTSRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")

    voice = req.voice or "alloy"
    fmt = (req.format or "mp3").lower()
    if fmt not in ("mp3", "wav"):
        fmt = "mp3"

    client = _get_openai_client()
    # 兼容不同 SDK：优先用 response_format，如果不支持就不传格式（默认 mp3）
    kwargs = {
        "model": "gpt-4o-mini-tts",
        "voice": voice,
        "input": text,
    }

    # 新版 SDK 用 response_format；你的 SDK 不支持 format
    # 我们先尝试 response_format=mp3/wav
    try:
        audio = client.audio.speech.create(**kwargs, response_format=fmt)
    except TypeError:
        # 老 SDK：不支持 response_format，就用默认格式（一般是 mp3）
        audio = client.audio.speech.create(**kwargs)

    # 取 bytes（不同 SDK 返回也可能不同）
    data = getattr(audio, "content", None)
    if data is None:
        try:
            data = audio.read()
        except Exception:
            data = bytes(audio)

    media_type = "audio/mpeg" if fmt == "mp3" else "audio/wav"
    return Response(content=data, media_type=media_type)


# SPA static hosting: keep this after API routes so /api/* is not shadowed.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True, check_dir=False), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
