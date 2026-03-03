import { FormEvent, KeyboardEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, RotateCw } from "lucide-react";
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
  const [composerFocused, setComposerFocused] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
  const [isStandalone, setIsStandalone] = useState(() => {
    const standaloneMatch = window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
    return standaloneMatch || iosStandalone;
  });
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
  const composerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const lastSpokenRef = useRef<string>("");
  const voiceBtnRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const keyboardOffsetRef = useRef<number>(0);
  const keyboardRafRef = useRef<number | null>(null);
  const focusStabilizeUntilRef = useRef<number>(0);
  const composerFocusedRef = useRef<boolean>(false);
  const scrollLockRafRef = useRef<number | null>(null);
  const lockedScrollTopRef = useRef<number>(0);
  const [composerHeight, setComposerHeight] = useState<number>(96);
  const [showAssistantCue, setShowAssistantCue] = useState(false);
  const stableAppHeightRef = useRef<number>(Math.round(window.innerHeight));
  const applyAppHeightRef = useRef<() => void>(() => {});
  const freezeAppHeightRef = useRef<boolean>(false);

  useEffect(() => {
    if (!debugOpen) return;
    debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [debugEvents, debugOpen]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);

    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const updateStandalone = () => {
      const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
      setIsStandalone(standaloneQuery.matches || iosStandalone);
    };

    updateStandalone();
    standaloneQuery.addEventListener("change", updateStandalone);
    return () => standaloneQuery.removeEventListener("change", updateStandalone);
  }, []);

  useEffect(() => {
    const setHeightVar = () => {
      const measuredHeight = Math.round(window.innerHeight);

      // Freeze app shell height during keyboard transition/open on mobile,
      // so iOS viewport changes don't move the whole container.
      if (!freezeAppHeightRef.current) {
        stableAppHeightRef.current = measuredHeight;
      }

      document.documentElement.style.setProperty(
        "--app-height",
        `${stableAppHeightRef.current}px`,
      );
    };

    applyAppHeightRef.current = setHeightVar;
    setHeightVar();
    window.addEventListener("resize", setHeightVar);
    window.visualViewport?.addEventListener("resize", setHeightVar);
    return () => {
      window.removeEventListener("resize", setHeightVar);
      window.visualViewport?.removeEventListener("resize", setHeightVar);
    };
  }, []);

  useEffect(() => {
    const applyKeyboardOffset = () => {
      const viewport = window.visualViewport;
      if (!viewport) {
        keyboardOffsetRef.current = 0;
        document.documentElement.style.setProperty("--keyboard-offset", "0px");
        return;
      }

      // iOS may shrink window.innerHeight together with visualViewport while keyboard opens.
      // Use the frozen pre-keyboard app height as baseline so offset remains measurable.
      const baselineHeight = Math.max(
        stableAppHeightRef.current,
        Math.round(window.innerHeight),
      );
      const rawOffset = baselineHeight - (viewport.height + viewport.offsetTop);
      const activeThreshold = composerFocusedRef.current ? 20 : 80;
      const normalizedOffset = rawOffset > activeThreshold ? Math.max(0, rawOffset) : 0;
      const maxReasonableOffset = Math.round(baselineHeight * 0.55);
      const measuredOffset = Math.min(normalizedOffset, maxReasonableOffset);
      const mobileFocusedMinOffset =
        composerFocusedRef.current && window.matchMedia("(max-width: 1024px)").matches
          ? Math.round(baselineHeight * (isStandalone ? 0.48 : 0.4))
          : 0;
      const baseTargetOffset = composerFocusedRef.current
        ? Math.max(measuredOffset, mobileFocusedMinOffset)
        : measuredOffset;
      const current = keyboardOffsetRef.current;
      const inFocusStabilizing =
        composerFocusedRef.current && Date.now() < focusStabilizeUntilRef.current;
      const targetOffset =
        inFocusStabilizing && baseTargetOffset < current ? current : baseTargetOffset;
      const holdOffsetWhileFocused =
        composerFocusedRef.current && current > 0 && targetOffset < current;
      const effectiveTargetOffset = holdOffsetWhileFocused ? current : targetOffset;
      const lockedFocusedTarget =
        composerFocusedRef.current && current > 0
          ? Math.min(effectiveTargetOffset, current)
          : effectiveTargetOffset;
      const delta = lockedFocusedTarget - current;
      const maxStep = lockedFocusedTarget === 0 ? 36 : inFocusStabilizing ? 16 : 24;
      const step = Math.max(-maxStep, Math.min(maxStep, delta));
      const keyboardOffset = current + step;

      keyboardOffsetRef.current = keyboardOffset;
      document.documentElement.style.setProperty(
        "--keyboard-offset",
        `${Math.round(Math.max(0, keyboardOffset))}px`,
      );
    };

    const scheduleKeyboardOffset = () => {
      if (keyboardRafRef.current !== null) {
        window.cancelAnimationFrame(keyboardRafRef.current);
      }
      keyboardRafRef.current = window.requestAnimationFrame(() => {
        keyboardRafRef.current = null;
        applyKeyboardOffset();
      });
    };

    applyKeyboardOffset();
    window.addEventListener("resize", scheduleKeyboardOffset);
    window.visualViewport?.addEventListener("resize", scheduleKeyboardOffset);
    return () => {
      if (keyboardRafRef.current !== null) {
        window.cancelAnimationFrame(keyboardRafRef.current);
      }
      if (scrollLockRafRef.current !== null) {
        window.cancelAnimationFrame(scrollLockRafRef.current);
      }
      window.removeEventListener("resize", scheduleKeyboardOffset);
      window.visualViewport?.removeEventListener("resize", scheduleKeyboardOffset);
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

  useEffect(() => {
    const node = composerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const updateComposerHeight = () => {
      // Freeze measured composer height while keyboard is opening/open,
      // so main content bottom padding does not jump for a single frame.
      if (composerFocusedRef.current) return;
      setComposerHeight(Math.round(node.getBoundingClientRect().height));
    };

    const observer = new ResizeObserver(() => updateComposerHeight());
    observer.observe(node);
    updateComposerHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!composerFocused) return;

    const lockBody = () => {
      document.body.style.overflow = "hidden";
      document.body.style.touchAction = "none";
      document.documentElement.style.overscrollBehavior = "none";
      window.scrollTo(0, 0);
    };

    const preventBackgroundTouchMove = (event: TouchEvent) => {
      const target = event.target as Node | null;
      const composerNode = composerRef.current;
      if (target && composerNode?.contains(target)) return;
      event.preventDefault();
    };

    lockBody();
    document.addEventListener("touchmove", preventBackgroundTouchMove, { passive: false });
    return () => {
      document.removeEventListener("touchmove", preventBackgroundTouchMove);
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
      document.documentElement.style.overscrollBehavior = "";
    };
  }, [composerFocused]);

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
    setShowAssistantCue(true);
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
              setShowAssistantCue(false);
              setStatus("streaming");
              pushDelta(chunk);
            }
            return;
          }

          if (event === "done") {
            const nextThreadId = typeof data?.thread_id === "string" ? data.thread_id : null;
            const finalText = typeof data?.text === "string" ? data.text : "";

            if (finalText) {
              setShowAssistantCue(false);
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
            setShowAssistantCue(false);
            return;
          }

          if (event === "error") {
            const message = typeof data?.message === "string" ? data.message : "Unknown error";
            setError(message);
            setStatus("error");
            setShowAssistantCue(false);
          }
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown network error";
      setError(message);
      setStatus("error");
      setShowAssistantCue(false);
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

  const lockMainScrollBriefly = () => {
    const node = mainScrollRef.current;
    if (!node) return;

    const lockUntil = Date.now() + 280;
    lockedScrollTopRef.current = node.scrollTop;

    if (scrollLockRafRef.current !== null) {
      window.cancelAnimationFrame(scrollLockRafRef.current);
    }

    const keepLocked = () => {
      const currentNode = mainScrollRef.current;
      if (currentNode) {
        currentNode.scrollTop = lockedScrollTopRef.current;
      }
      if (Date.now() < lockUntil) {
        scrollLockRafRef.current = window.requestAnimationFrame(keepLocked);
      } else {
        scrollLockRafRef.current = null;
      }
    };

    scrollLockRafRef.current = window.requestAnimationFrame(keepLocked);
  };

  const handleComposerFocus = () => {
    triggerAudioUnlock();
    freezeAppHeightRef.current = true;
    stableAppHeightRef.current = Math.round(window.innerHeight);
    document.documentElement.style.setProperty(
      "--app-height",
      `${stableAppHeightRef.current}px`,
    );
    if (isMobile) {
      // Immediate fallback lift to avoid iOS keyboard covering composer
      // before visualViewport reports a stable keyboard height.
      const fallbackOffset = Math.round(stableAppHeightRef.current * (isStandalone ? 0.48 : 0.4));
      keyboardOffsetRef.current = Math.max(keyboardOffsetRef.current, fallbackOffset);
      document.documentElement.style.setProperty(
        "--keyboard-offset",
        `${Math.max(0, keyboardOffsetRef.current)}px`,
      );
    }
    setComposerFocused(true);
    composerFocusedRef.current = true;
    focusStabilizeUntilRef.current = Date.now() + 280;
    lockMainScrollBriefly();
    // iOS may auto-scroll focused fields; force viewport back to top immediately.
    window.requestAnimationFrame(() => window.scrollTo(0, 0));
  };

  const handleComposerBlur = () => {
    setComposerFocused(false);
    composerFocusedRef.current = false;
    focusStabilizeUntilRef.current = 0;
    freezeAppHeightRef.current = false;
    keyboardOffsetRef.current = 0;
    document.documentElement.style.setProperty("--keyboard-offset", "0px");
    window.requestAnimationFrame(() => applyAppHeightRef.current());
  };

  const handleComposerPointerDown = (e: PointerEvent<HTMLTextAreaElement>) => {
    if (freezeAppHeightRef.current) return;
    freezeAppHeightRef.current = true;
    stableAppHeightRef.current = Math.round(window.innerHeight);
    document.documentElement.style.setProperty(
      "--app-height",
      `${stableAppHeightRef.current}px`,
    );

    // Prevent iOS Safari from auto-scrolling layout viewport on focus.
    if (isMobile && document.activeElement !== textareaRef.current) {
      e.preventDefault();
      textareaRef.current?.focus({ preventScroll: true });
    }
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

  const resetChat = () => {
    setMessages([]);
    setInput("");
    setError("");
    setStatus("idle");
    setShowAssistantCue(false);
    setNeedsSoundGesture(false);
    setDebugEvents([]);
    setThreadId(null);

    try {
      localStorage.removeItem(THREAD_KEY);
    } catch {
      // ignore storage failures (e.g. Safari private mode)
    }
  };

  return (
    <div
      className="fixed inset-0 h-[var(--app-height)] overflow-hidden bg-muted/30 p-0 text-foreground lg:static lg:p-4"
      onPointerDownCapture={triggerAudioUnlock}
    >
      <div className="flex h-full justify-center overflow-hidden" style={isMobile ? { width: "100vw", maxWidth: "100vw" } : undefined}>
        <div className="h-full w-full lg:w-[1133px]" style={isMobile ? { width: "100vw", maxWidth: "100vw" } : undefined}>
        <Card className="flex h-full flex-col overflow-hidden rounded-none border-0 lg:h-[744px] lg:rounded-xl lg:border" style={isMobile ? { width: "100vw", maxWidth: "100vw" } : undefined}>
          <div className="flex items-center justify-between border-b px-4 pb-[6px] pt-1 -mt-1 lg:mt-0 lg:py-3">
            <div className="flex items-center">
              <div className="text-[1.125rem] font-semibold lg:text-base">AisleBay Chat</div>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="mr-2 h-7 w-7 rounded-full p-0 lg:mr-2 lg:h-9 lg:w-9"
              onClick={resetChat}
              disabled={status === "connecting" || status === "streaming"}
              aria-label="Refresh chat"
              title="Refresh chat"
            >
              <RotateCw className="h-3.5 w-3.5 lg:h-4 lg:w-4" />
            </Button>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <main
              ref={mainScrollRef}
              className={[
                "min-h-0 flex-1 overscroll-contain px-4 pt-6",
                composerFocused
                  ? "overflow-y-hidden"
                  : isMainOverflowing
                    ? "overflow-y-auto"
                    : "overflow-y-hidden",
              ].join(" ")}
              style={{ paddingBottom: `${composerHeight + 12}px` }}
            >
              {messages.length === 0 ? (
                <div
                  className="flex h-full items-center justify-center text-center sm:-translate-y-6"
                  style={
                    isMobile
                      ? {
                          transform: composerFocused
                            ? "translateY(calc(-24px - (var(--keyboard-offset) * 0.28)))"
                            : "translateY(-24px)",
                        }
                      : undefined
                  }
                >
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

              {showAssistantCue && (status === "connecting" || status === "streaming") ? (
                <div className="mt-[30px] flex w-full justify-start">
                  <div className="assistantCueBubble" aria-live="polite" aria-label="AI is preparing a response">
                    <span className="assistantCueDot" />
                  </div>
                </div>
              ) : null}
            </main>

            <div
              ref={composerRef}
              className="fixed inset-x-0 z-20 bg-background px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 lg:absolute lg:left-0 lg:right-0"
              style={{
                bottom: 0,
                paddingBottom: "max(12px, env(safe-area-inset-bottom), var(--keyboard-offset))",
              }}
            >
              <form onSubmit={handleSubmit} className="mx-auto flex max-w-[1133px] items-center gap-2 rounded-[28px] border bg-background px-2 py-1">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  onPointerDown={handleComposerPointerDown}
                  onFocus={handleComposerFocus}
                  onBlur={handleComposerBlur}
                  placeholder={isMobile ? "Type or speak to find items…" : "Type or speak to find items, check availability, or get quick help..."}
                  disabled={status === "connecting" || status === "streaming"}
                  className="h-11 min-h-11 max-h-11 resize-none rounded-2xl border-0 bg-transparent px-3 py-[11px] leading-[22px] text-[#282828] placeholder:text-[#282828]/60 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
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
