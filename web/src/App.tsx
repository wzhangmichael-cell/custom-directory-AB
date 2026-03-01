import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import VoiceButton from "./components/VoiceButton";
import { useVoiceInput } from "./lib/useVoiceInput";
import { connectSSE } from "./lib/sseClient";
import { isAudioUnlocked, unlockAudioOnce } from "./lib/audioUnlock";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type DebugEvent = {
  ts: number;
  node: string;
  payload: unknown;
};

type Status = "idle" | "connecting" | "streaming" | "error";

const THREAD_KEY = "thread_id";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
const API_BASE = import.meta.env.VITE_API_BASE || "";
const DEBUG_ALLOWED = import.meta.env.VITE_SHOW_DEBUG === "true";

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [threadId, setThreadId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THREAD_KEY);
    } catch {
      return null;
    }
  });
  const [debugOpen, setDebugOpen] = useState<boolean>(
    () => DEBUG_ALLOWED && new URLSearchParams(window.location.search).get("debug") === "1",
  );
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const debugEndRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenRef = useRef<string>("");
  const voiceBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!debugOpen) return;
    debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [debugEvents, debugOpen]);

  useEffect(() => {
    const setHeightVar = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
    };

    setHeightVar();
    window.addEventListener("resize", setHeightVar);
    window.visualViewport?.addEventListener("resize", setHeightVar);
    return () => {
      window.removeEventListener("resize", setHeightVar);
      window.visualViewport?.removeEventListener("resize", setHeightVar);
    };
  }, []);

  const statusText = useMemo(() => {
    if (status === "connecting") return "Connecting...";
    if (status === "streaming") return "Streaming...";
    if (status === "error") return "Error";
    return "Idle";
  }, [status]);

  const pushDelta = (delta: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];

      // 如果最后一条不是 assistant（或还没有），就新建一条 assistant
      if (!last || last.role !== "assistant") {
        next.push({ id: newId(), role: "assistant", content: delta });
        return next;
      }

      // 否则追加到最后一条 assistant
      next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
  };

  const setFinalText = (finalText: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];

      // 如果最后一条不是 assistant（或还没有），就新建一条 assistant
      if (!last || last.role !== "assistant") {
        next.push({ id: newId(), role: "assistant", content: finalText });
        return next;
      }

      // 否则直接覆盖最后一条 assistant
      next[next.length - 1] = { ...last, content: finalText };
      return next;
    });
  };

  async function playTTS(text: string) {
    const t = text.trim();
    if (!t) return;

    if (!isAudioUnlocked()) {
      await unlockAudioOnce();
    }

    // ✅ 去重：同一句不要重复读
    if (t === lastSpokenRef.current) return;
    lastSpokenRef.current = t;

    // ✅ 打断上一段
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {}
      audioRef.current = null;
    }

    const res = await fetch(`${API_BASE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, voice: "alloy", format: "mp3" }),
    });

    if (!res.ok) {
      // 不影响聊天，只是不播
      return;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("audio/")) {
      console.error("[tts] unexpected content-type", contentType);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playsInline = true;
    audioRef.current = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (audioRef.current === audio) audioRef.current = null;
    };

    try {
      await audio.play();
    } catch (e) {
      console.error("[tts] play blocked (Safari?)", e);
      // 浏览器可能要求用户交互后才能播放
      URL.revokeObjectURL(url);
    }
  }

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setError("");
    setStatus("connecting");
    if (debugOpen) setDebugEvents([]);

    setMessages((prev) => [...prev, { id: newId(), role: "user", content: trimmed }]);

    try {
      await connectSSE(
        USE_MOCK ? `${API_BASE}/api/mock` : `${API_BASE}/api/chat`,
        USE_MOCK ? {} : { thread_id: threadId, message: trimmed },
        ({ event, data }) => {
          console.log("[sse]", event, data);

          if (event === "debug" && debugOpen) {
            setDebugEvents((prev) => [
              ...prev,
              {
                ts: Date.now(),
                node: typeof data?.node === "string" ? data.node : "unknown",
                payload: data?.payload,
              },
            ]);
            return;
          }

          if (event === "delta") {
            const chunk = typeof data?.text === "string" ? data.text : "";
            if (chunk) {
              setStatus("streaming");
              pushDelta(chunk);
            }
            return;
          }

          if (event === "done") {
            const nextThreadId = typeof data?.thread_id === "string" ? data.thread_id : null;
            const finalText = typeof data?.text === "string" ? data.text : "";

            if (finalText) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (!last || last.role !== "assistant") {
                  next.push({ id: newId(), role: "assistant", content: finalText });
                } else {
                  next[next.length - 1] = { ...last, content: finalText };
                }
                return next;
              });

              // ✅ 自动朗读
              playTTS(finalText);
            }

            if (nextThreadId && !USE_MOCK) {
              try {
                localStorage.setItem(THREAD_KEY, nextThreadId);
              } catch {
                // ignore storage failures (e.g. Safari private mode)
              }
              setThreadId(nextThreadId);
            }
            setStatus("idle");
            return;
          }

          if (event === "error") {
            const message = typeof data?.message === "string" ? data.message : "Unknown error";
            setError(message);
            setStatus("error");
          }
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown network error";
      setError(message);
      setStatus("error");
    }
  };

  const voice = useVoiceInput({
    sttUrl: `${API_BASE}/api/stt`,
    levelTargetRef: voiceBtnRef,
    onTranscript: async (text) => {
      await sendMessage(text);
    },
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");

    await sendMessage(text);
  };

  const triggerAudioUnlock = () => {
    void unlockAudioOnce();
  };

  return (
    <div className="app chatShell">
      <header className="header">
        <h1>Custom Workflow Chat</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div>Mode: {USE_MOCK ? "Mock" : "Live"}</div>
          <div className={`status ${status}`}>Status: {statusText}</div>
        </div>
      </header>

      <main className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="role">{msg.role}</div>
            <div className="bubble">{msg.content || "..."}</div>
          </div>
        ))}
      </main>

      {error ? <div className="error">{error}</div> : null}

      <form className="composer" onSubmit={handleSubmit}>
        <input
          className="composerInput"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={triggerAudioUnlock}
          placeholder="Type a message"
          disabled={status === "connecting" || status === "streaming"}
        />
        <button
          className="sendBtn"
          type="submit"
          onPointerDown={triggerAudioUnlock}
          disabled={status === "connecting" || status === "streaming"}
        >
          Send
        </button>

        <VoiceButton
          buttonRef={voiceBtnRef}
          isRecording={voice.isRecording}
          isTranscribing={voice.isTranscribing}
          onStart={async () => {
            await voice.start();
            triggerAudioUnlock();
          }}
          onStop={voice.stop}
          right={0}
          bottom={0}
        />
      </form>

      {DEBUG_ALLOWED ? (
        debugOpen ? (
          <div className="debugPanel">
            <div className="debugHeader">
              <b>Debug Trace</b>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => setDebugEvents([])}>Clear</button>
                <button type="button" onClick={() => setDebugOpen(false)}>Hide</button>
              </div>
            </div>
            <div className="debugBody">
              {debugEvents.map((e, i) => (
                <div key={`${e.ts}-${i}`} className="debugRow">
                  <div className="debugNode">{e.node}</div>
                  <pre className="debugJson">{JSON.stringify(e.payload, null, 2)}</pre>
                </div>
              ))}
              <div ref={debugEndRef} />
            </div>
          </div>
        ) : (
          <button className="debugFab" type="button" onClick={() => setDebugOpen(true)}>
            Debug
          </button>
        )
      ) : null}
    </div>
  );
}
