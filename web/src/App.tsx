import { FormEvent, KeyboardEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ArrowDown, ArrowUp, RotateCw } from "lucide-react";
import VoiceButton from "./components/VoiceButton";
import { useVoiceInput } from "./lib/useVoiceInput";
import { useChatSession } from "./hooks/useChatSession";

const THREAD_KEY = "thread_id";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
const API_BASE = import.meta.env.VITE_API_BASE || "";
const DEV_MODE = import.meta.env.DEV;
const DEBUG_QUERY_ENABLED = new URLSearchParams(window.location.search).get("debug") === "1";
const DEBUG_ALLOWED = import.meta.env.VITE_SHOW_DEBUG === "true" || DEV_MODE || DEBUG_QUERY_ENABLED;
const SCROLL_BUFFER_PX = 28;

export default function App() {
  const [input, setInput] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  const [isSmallRangeScroll, setIsSmallRangeScroll] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
  const [isStandalone, setIsStandalone] = useState(() => {
    const standaloneMatch = window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
    return standaloneMatch || iosStandalone;
  });
  const [debugOpen, setDebugOpen] = useState<boolean>(
    () => DEBUG_ALLOWED && DEBUG_QUERY_ENABLED,
  );
  const shouldLogDebug = DEV_MODE || debugOpen;
  const {
    audioRef,
    clearDebugEvents,
    debugEvents,
    enableSoundAndReplay,
    error,
    messages,
    needsSoundGesture,
    resetChat,
    sendMessage,
    showAssistantCue,
    status,
    triggerAudioUnlock,
  } = useChatSession({
    apiBase: API_BASE,
    useMock: USE_MOCK,
    threadKey: THREAD_KEY,
    debugOpen,
    shouldLogDebug,
  });
  const debugEndRef = useRef<HTMLDivElement | null>(null);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const voiceBtnRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const keyboardOffsetRef = useRef<number>(0);
  const keyboardRafRef = useRef<number | null>(null);
  const focusStabilizeUntilRef = useRef<number>(0);
  const composerFocusedRef = useRef<boolean>(false);
  const scrollLockRafRef = useRef<number | null>(null);
  const viewportLockRafRef = useRef<number | null>(null);
  const lockedScrollTopRef = useRef<number>(0);
  const [composerHeight, setComposerHeight] = useState<number>(96);
  const stableAppHeightRef = useRef<number>(Math.round(window.innerHeight));
  const applyAppHeightRef = useRef<() => void>(() => {});
  const freezeAppHeightRef = useRef<boolean>(false);
  const hasMessages = messages.length > 0;

  const scrollMainToBottom = () => {
    const node = mainScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  const updateScrollToBottomVisibility = () => {
    const node = mainScrollRef.current;
    if (!node || !hasMessages) {
      setShowScrollToBottom(false);
      return;
    }
    const isOverflowing = node.scrollHeight > node.clientHeight + 1;
    if (!isOverflowing) {
      setShowScrollToBottom(false);
      return;
    }
    const distanceToBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    const threshold = 284;
    setShowScrollToBottom(distanceToBottom > threshold);
  };

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
      if (viewportLockRafRef.current !== null) {
        window.cancelAnimationFrame(viewportLockRafRef.current);
      }
      window.removeEventListener("resize", scheduleKeyboardOffset);
      window.visualViewport?.removeEventListener("resize", scheduleKeyboardOffset);
    };
  }, []);

  useEffect(() => {
    const node = mainScrollRef.current;
    if (!node || composerFocused || !hasMessages) return;

    // "Small-range scroll mode": only the top/bottom spacer contributes to overflow.
    const smallRangeMode = node.scrollHeight <= node.clientHeight + SCROLL_BUFFER_PX * 2 + 2;
    if (!smallRangeMode) return;

    // Keep the resting position at the middle so users can swipe up/down slightly.
    node.scrollTop = SCROLL_BUFFER_PX;
  }, [composerFocused, hasMessages, isSmallRangeScroll]);

  useEffect(() => {
    const node = mainScrollRef.current;
    if (!node || !hasMessages) {
      setIsSmallRangeScroll(false);
      return;
    }

    const measure = () => {
      const contentNode = node.querySelector(".chatScrollContent") as HTMLDivElement | null;
      if (!contentNode) {
        setIsSmallRangeScroll(true);
        return;
      }

      const mainStyle = window.getComputedStyle(node);
      const mainPaddingTop = parseFloat(mainStyle.paddingTop || "0") || 0;
      const mainPaddingBottom = parseFloat(mainStyle.paddingBottom || "0") || 0;
      const visibleContentHeight = Math.max(0, node.clientHeight - mainPaddingTop - mainPaddingBottom);

      const contentStyle = window.getComputedStyle(contentNode);
      const contentPaddingTop = parseFloat(contentStyle.paddingTop || "0") || 0;
      const contentPaddingBottom = parseFloat(contentStyle.paddingBottom || "0") || 0;
      const naturalContentHeight = Math.max(
        0,
        contentNode.scrollHeight - contentPaddingTop - contentPaddingBottom,
      );

      const smallRangeMode = naturalContentHeight <= visibleContentHeight + 1;
      setIsSmallRangeScroll(smallRangeMode);
    };

    const id = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(node);
    }

    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [hasMessages, messages, error, needsSoundGesture, showAssistantCue, status, composerHeight, composerFocused]);

  useEffect(() => {
    const node = mainScrollRef.current;
    if (!node) {
      setShowScrollToBottom(false);
      return;
    }
    updateScrollToBottomVisibility();
    const onScroll = () => updateScrollToBottomVisibility();
    const onResize = () => updateScrollToBottomVisibility();
    node.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      node.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [hasMessages, messages, composerHeight, status, composerFocused]);

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
      const mainNode = mainScrollRef.current;
      if (target && composerNode?.contains(target)) return;
      if (target && mainNode?.contains(target) && hasMessages) return;
      event.preventDefault();
    };

    lockBody();
    document.addEventListener("touchmove", preventBackgroundTouchMove, { passive: false });

    const preventComposerDrag = (event: TouchEvent) => {
      event.preventDefault();
    };

    const composerNode = composerRef.current;
    composerNode?.addEventListener("touchmove", preventComposerDrag, { passive: false });
    return () => {
      document.removeEventListener("touchmove", preventBackgroundTouchMove);
      composerNode?.removeEventListener("touchmove", preventComposerDrag);
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
      document.documentElement.style.overscrollBehavior = "";
    };
  }, [composerFocused, hasMessages]);

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
    scrollMainToBottom();
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
    const lockUntil = Date.now() + 900;
    if (viewportLockRafRef.current !== null) {
      window.cancelAnimationFrame(viewportLockRafRef.current);
    }
    const keepViewportTop = () => {
      window.scrollTo(0, 0);
      if (Date.now() < lockUntil && composerFocusedRef.current) {
        viewportLockRafRef.current = window.requestAnimationFrame(keepViewportTop);
      } else {
        viewportLockRafRef.current = null;
      }
    };
    viewportLockRafRef.current = window.requestAnimationFrame(keepViewportTop);
  };

  const handleComposerBlur = () => {
    setComposerFocused(false);
    composerFocusedRef.current = false;
    focusStabilizeUntilRef.current = 0;
    freezeAppHeightRef.current = false;
    keyboardOffsetRef.current = 0;
    document.documentElement.style.setProperty("--keyboard-offset", "0px");
    if (viewportLockRafRef.current !== null) {
      window.cancelAnimationFrame(viewportLockRafRef.current);
      viewportLockRafRef.current = null;
    }
    window.requestAnimationFrame(() => applyAppHeightRef.current());
  };

  const handleComposerPointerDown = (e: PointerEvent<HTMLTextAreaElement>) => {
    if (status === "connecting" || status === "streaming") {
      e.preventDefault();
      return;
    }
    if (freezeAppHeightRef.current) {
      if (isMobile) {
        e.preventDefault();
      }
      return;
    }
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

  const handleSendPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    triggerAudioUnlock();
    if (!isMobile) return;
    e.preventDefault();
    if (status === "connecting" || status === "streaming") return;
    void submitCurrentInput();
  };

  useEffect(() => {
    if (!composerFocused || !isMobile) return;
    const nudgeToTop = () => {
      if (!composerFocusedRef.current) return;
      window.scrollTo(0, 0);
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("scroll", nudgeToTop);
    return () => {
      viewport?.removeEventListener("scroll", nudgeToTop);
    };
  }, [composerFocused, isMobile]);

  const resetChatAndInput = () => {
    setInput("");
    resetChat();
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
              onClick={resetChatAndInput}
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
                "chatScroll min-h-0 flex-1 overscroll-contain px-4 pt-6",
                hasMessages && isSmallRangeScroll ? "chatScrollBuffered" : "",
                !isSmallRangeScroll ? "chatScrollNoSnap" : "",
                !hasMessages
                  ? "flex items-center justify-center overflow-y-hidden"
                  : "overflow-y-auto",
              ].join(" ")}
              style={{ paddingBottom: `calc(${composerHeight + 12}px + var(--keyboard-offset))` }}
            >
              <div className={hasMessages ? "chatScrollContent" : undefined}>
                {messages.length === 0 ? (
                  <div
                    className="w-full text-center sm:-translate-y-6"
                    style={
                      isMobile
                        ? {
                          transform: composerFocused
                            ? "translateY(calc(-2px - (var(--keyboard-offset) * 0.02)))"
                            : "translateY(0px)",
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
              </div>
            </main>

            {showScrollToBottom ? (
              <button
                type="button"
                onClick={scrollMainToBottom}
                className="absolute left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm transition hover:bg-background"
                style={{ bottom: `calc(${composerHeight + 18}px + var(--keyboard-offset))` }}
                aria-label="Scroll to latest message"
                title="Scroll to latest message"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            ) : null}

            <div
              ref={composerRef}
              className="absolute inset-x-0 z-20 bg-background px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3"
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
                    onPointerDown={handleSendPointerDown}
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
                <button type="button" onClick={clearDebugEvents}>Clear</button>
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
