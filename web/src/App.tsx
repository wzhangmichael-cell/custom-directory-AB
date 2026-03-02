import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp } from "lucide-react";
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
const DEV_MODE = import.meta.env.DEV;
const DEBUG_QUERY_ENABLED = new URLSearchParams(window.location.search).get("debug") === "1";
const DEBUG_ALLOWED = import.meta.env.VITE_SHOW_DEBUG === "true" || DEV_MODE || DEBUG_QUERY_ENABLED;

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [needsSoundGesture, setNeedsSoundGesture] = useState(false);
  const [isMainOverflowing, setIsMainOverflowing] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THREAD_KEY);
    } catch {
      return null;
    }
  });
  const [debugOpen, setDebugOpen] = useState<boolean>(
    () => DEBUG_ALLOWED && DEBUG_QUERY_ENABLED,
  );
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const shouldLogDebug = DEV_MODE || debugOpen;
  const debugEndRef = useRef<HTMLDivElement | null>(null);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
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

  useEffect(() => {
    const checkOverflow = () => {
      const node = mainScrollRef.current;
      if (!node) return;
      setIsMainOverflowing(node.scrollHeight > node.clientHeight + 1);
    };

    const id = window.requestAnimationFrame(checkOverflow);
    window.addEventListener("resize", checkOverflow);
    window.visualViewport?.addEventListener("resize", checkOverflow);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", checkOverflow);
      window.visualViewport?.removeEventListener("resize", checkOverflow);
    };
  }, [messages, error, needsSoundGesture, status]);

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
      void unlockAudioOnce();
    }

    // ✅ 去重：同一句不要重复读
    if (t === lastSpokenRef.current) return;
    lastSpokenRef.current = t;

    const audio = audioRef.current;
    if (!audio) return;

    // ✅ 打断上一段
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
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
      if (shouldLogDebug) console.warn("[tts] unexpected content-type", contentType);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    audio.src = url;
    audio.playsInline = true;
    audio.load();

    audio.onended = () => {
      if (audioUrlRef.current === url) {
        URL.revokeObjectURL(url);
        audioUrlRef.current = null;
      }
    };

    try {
      await audio.play();
      setNeedsSoundGesture(false);
    } catch (e) {
      if (shouldLogDebug) console.warn("[tts] play blocked (Safari/WebKit?)", e);
      // Safari/WebKit may require explicit user gesture for audible playback.
      setNeedsSoundGesture(true);
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

  const submitCurrentInput = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitCurrentInput();
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (status === "connecting" || status === "streaming") return;
    void submitCurrentInput();
  };

  const triggerAudioUnlock = () => {
    void unlockAudioOnce();
  };

  const enableSoundAndReplay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setNeedsSoundGesture(false);
    } catch (e) {
      if (shouldLogDebug) console.warn("[tts] manual play failed", e);
      try {
        await unlockAudioOnce();
        await audio.play();
        setNeedsSoundGesture(false);
      } catch (err) {
        if (shouldLogDebug) console.warn("[tts] manual enable sound failed", err);
        setNeedsSoundGesture(true);
      }
    }
  };

  return (
    <div className="min-h-dvh bg-muted/30 p-4 text-foreground" onPointerDownCapture={triggerAudioUnlock}>
      <div className="flex justify-center">
        <div className="w-[1133px]">
        <Card className="h-[744px] overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold">AisleBay Chat</div>
              <Badge variant="secondary">Local</Badge>
            </div>
            <Badge variant={status === "streaming" ? "default" : "secondary"}>
              {status === "connecting"
                ? "Connecting"
                : status === "streaming"
                  ? "Thinking"
                  : "Ready"}
            </Badge>
          </div>

          <div className="flex h-full flex-col">
            <main
              ref={mainScrollRef}
              className={[
                "flex-1 overscroll-contain px-4 py-6",
                isMainOverflowing ? "overflow-y-auto" : "overflow-y-hidden",
              ].join(" ")}
            >
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="text-2xl font-bold">What can I help you find today?</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg) => {
                    const isUser = msg.role === "user";
                    return (
                      <div
                        key={msg.id}
                        className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={[
                            "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm",
                            isUser
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-foreground",
                          ].join(" ")}
                        >
                          <div className="whitespace-pre-wrap break-words">
                            {msg.content || "..."}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {error || needsSoundGesture ? (
                <div className="mt-4 space-y-2">
                  {error ? (
                    <Card className="border-destructive/40">
                      <CardContent className="p-3 text-sm text-destructive">
                        {error}
                      </CardContent>
                    </Card>
                  ) : null}

                  {needsSoundGesture ? (
                    <Card className="border-amber-500/30">
                      <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm text-amber-700 dark:text-amber-300">
                          Voice playback is paused by browser settings.
                        </div>
                        <Button
                          type="button"
                          onPointerDown={triggerAudioUnlock}
                          onClick={enableSoundAndReplay}
                        >
                          Enable Voice
                        </Button>
                      </CardContent>
                    </Card>
                  ) : null}
                </div>
              ) : null}
            </main>

            <div className="bg-background px-4 pb-8 pt-3">
              <form onSubmit={handleSubmit} className="-mt-[85px] flex items-center gap-2 rounded-[28px] border bg-background px-2 py-1">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  onFocus={triggerAudioUnlock}
                  placeholder="Type a message..."
                  disabled={status === "connecting" || status === "streaming"}
                  className="h-11 min-h-11 max-h-11 resize-none rounded-2xl border-0 bg-transparent px-3 py-[10px] leading-6 text-[#282828] placeholder:text-[#282828]/60 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />

                <div className="flex items-center gap-1">
                  <button
                    type="submit"
                    onPointerDown={triggerAudioUnlock}
                    disabled={status === "connecting" || status === "streaming"}
                    className={[
                      "flex h-11 w-11 items-center justify-center rounded-full",
                      "bg-[#181818] text-white shadow-md transition",
                      "hover:opacity-90 active:scale-95",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    ].join(" ")}
                    aria-label="Send message"
                  >
                    <ArrowUp className="h-6 w-6" />
                  </button>

                  <div className="h-11 w-11">
                    <VoiceButton
                      buttonRef={voiceBtnRef}
                      isRecording={voice.isRecording}
                      isTranscribing={voice.isTranscribing}
                      onStart={async () => {
                        triggerAudioUnlock();
                        await voice.start();
                      }}
                      onStop={voice.stop}
                      right={0}
                      bottom={0}
                    />
                  </div>
                </div>
              </form>

            </div>
          </div>
        </Card>
        </div>
      </div>

      <audio ref={audioRef} playsInline preload="auto" />

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
