import { useCallback, useEffect, useRef, useState } from "react";
import { connectSSE } from "../lib/sseClient";
import { isAudioUnlocked, unlockAudioOnce } from "../lib/audioUnlock";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type DebugEvent = {
  ts: number;
  node: string;
  payload: unknown;
};

export type ChatStatus = "idle" | "connecting" | "streaming" | "error";

type UseChatSessionOptions = {
  apiBase: string;
  useMock: boolean;
  threadKey: string;
  debugOpen: boolean;
  shouldLogDebug: boolean;
};

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function useChatSession({
  apiBase,
  useMock,
  threadKey,
  debugOpen,
  shouldLogDebug,
}: UseChatSessionOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState("");
  const [needsSoundGesture, setNeedsSoundGesture] = useState(false);
  const [showAssistantCue, setShowAssistantCue] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(threadKey);
    } catch {
      return null;
    }
  });
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const lastSpokenRef = useRef<string>("");

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  const pushDelta = useCallback((delta: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") {
        next.push({ id: newId(), role: "assistant", content: delta });
        return next;
      }
      next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
  }, []);

  const playTTS = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;

      if (!isAudioUnlocked()) {
        void unlockAudioOnce();
      }

      if (t === lastSpokenRef.current) return;
      lastSpokenRef.current = t;

      const audio = audioRef.current;
      if (!audio) return;

      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {}
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }

      const res = await fetch(`${apiBase}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, voice: "alloy", format: "mp3" }),
      });

      if (!res.ok) return;

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
        setNeedsSoundGesture(true);
      }
    },
    [apiBase, shouldLogDebug],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      setError("");
      setStatus("connecting");
      setShowAssistantCue(true);
      if (debugOpen) setDebugEvents([]);
      setMessages((prev) => [...prev, { id: newId(), role: "user", content: trimmed }]);

      try {
        await connectSSE(
          useMock ? `${apiBase}/api/mock` : `${apiBase}/api/chat`,
          useMock ? {} : { thread_id: threadId, message: trimmed },
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
                void playTTS(finalText);
              }

              if (nextThreadId && !useMock) {
                try {
                  localStorage.setItem(threadKey, nextThreadId);
                } catch {}
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
    },
    [apiBase, debugOpen, playTTS, pushDelta, threadId, threadKey, useMock],
  );

  const enableSoundAndReplay = useCallback(async () => {
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
  }, [shouldLogDebug]);

  const resetChat = useCallback(() => {
    setMessages([]);
    setError("");
    setStatus("idle");
    setShowAssistantCue(false);
    setNeedsSoundGesture(false);
    setDebugEvents([]);
    setThreadId(null);

    try {
      localStorage.removeItem(threadKey);
    } catch {}
  }, [threadKey]);

  const clearDebugEvents = useCallback(() => setDebugEvents([]), []);
  const triggerAudioUnlock = useCallback(() => {
    void unlockAudioOnce();
  }, []);

  return {
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
  };
}
