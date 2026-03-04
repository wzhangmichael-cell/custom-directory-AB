import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";

type UseVoiceInputOptions = {
  sttUrl?: string; // default "/api/stt"
  onTranscript: (text: string) => void | Promise<void>;
  levelTargetRef?: RefObject<HTMLElement | null>;
};

export function useVoiceInput({
  sttUrl = "/api/stt",
  onTranscript,
  levelTargetRef,
}: UseVoiceInputOptions) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const analysingRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const cleanupAnalyser = useCallback(() => {
    analysingRef.current = false;
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;

    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;

    const el = levelTargetRef?.current;
    if (el) el.style.setProperty("--voice-level", "0");
  }, [levelTargetRef]);

  const start = useCallback(async () => {
    if (isRecording || isTranscribing) return;
    if (!navigator?.mediaDevices?.getUserMedia) {
      console.error("[voice] mediaDevices.getUserMedia is not supported");
      return;
    }
    if (typeof window.MediaRecorder === "undefined") {
      console.error("[voice] MediaRecorder is not supported");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      chunksRef.current = [];
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/aac",
      ];
      const selectedMime = mimeCandidates.find(
        (mime) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(mime),
      );
      const mr = selectedMime ? new MediaRecorder(stream, { mimeType: selectedMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        setIsTranscribing(true);
        try {
          const blob = new Blob(chunksRef.current, {
            type: mr.mimeType || "audio/webm",
          });
          chunksRef.current = [];

          const form = new FormData();
          const mimeType = (blob.type || mr.mimeType || "").toLowerCase();
          let ext = "webm";
          if (mimeType.includes("mp4")) ext = "mp4";
          else if (mimeType.includes("aac")) ext = "aac";
          else if (mimeType.includes("wav")) ext = "wav";
          form.append("file", blob, `recording.${ext}`); // field name MUST be "file"

          const res = await fetch(sttUrl, { method: "POST", body: form });
          const data = await res.json();

          const text = (data?.text || "").trim();
          if (text) await onTranscript(text);
        } catch (err) {
          console.error("[voice] stt failed:", err);
        } finally {
          setIsTranscribing(false);
          setIsRecording(false);
          cleanupAnalyser();

          // release mic
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
          }
        }
      };

      mr.start();
      setIsRecording(true);

      // Defer visualizer setup until after recorder starts so tap feedback is faster.
      window.requestAnimationFrame(() => {
        if (!streamRef.current) return;

        // =========================
        // ✅ 声纹可视化：RMS + 压缩器 + 简易AGC + 强门控 + 双端压缩
        // 写到 levelTargetRef（按钮）上：--voice-level
        // =========================
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);

        // 高通：砍掉低频底噪
        const hpf = audioCtx.createBiquadFilter();
        hpf.type = "highpass";
        hpf.frequency.value = 120;
        source.connect(hpf);

        // 压缩
        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -45;
        compressor.knee.value = 30;
        compressor.ratio.value = 10;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        // analyser
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;

        hpf.connect(compressor);
        compressor.connect(analyser);

        const data = new Float32Array(analyser.fftSize);
        analysingRef.current = true;

        // AGC 状态
        let peak = 0.08;

        // 门控状态
        let isSpeech = false;
        let silenceFrames = 0;

        const setLevel = (v: number) => {
          const el = levelTargetRef?.current;
          if (el) el.style.setProperty("--voice-level", String(v));
        };

        const getPrevLevel = () => {
          const el = levelTargetRef?.current;
          if (!el) return 0;
          const prevStr = getComputedStyle(el).getPropertyValue("--voice-level").trim();
          return prevStr ? Number(prevStr) : 0;
        };

        const tick = () => {
          analyser.getFloatTimeDomainData(data);

          // RMS
          let sumSq = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i];
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / data.length);

          // AGC：只在明显有声时更新 peak
          if (rms > 0.015) {
            peak = peak * 0.985 + rms * 0.015;
          } else {
            peak = peak * 0.995;
          }

          const gain = Math.min(1 / Math.max(peak, 0.04), 7);
          const boosted = Math.min(rms * gain, 1);

          // 门控（滞回 + 静音计数）
          const SPEECH_ON = 0.16;
          const SPEECH_OFF = 0.10;
          const SILENCE_FRAMES_TO_OFF = 18;

          if (!isSpeech) {
            if (boosted > SPEECH_ON) {
              isSpeech = true;
              silenceFrames = 0;
            }
          } else {
            if (boosted < SPEECH_OFF) {
              silenceFrames += 1;
              if (silenceFrames > SILENCE_FRAMES_TO_OFF) {
                isSpeech = false;
                silenceFrames = 0;
              }
            } else {
              silenceFrames = 0;
            }
          }

          // 不在说话态：快速回落到 0
          if (!isSpeech) {
            const prev = getPrevLevel();
            const SILENCE_DECAY = 0.6;
            const level = prev + (0 - prev) * SILENCE_DECAY;
            setLevel(level);

            if (analysingRef.current) {
              rafIdRef.current = requestAnimationFrame(tick);
            }
            return;
          }

          // 说话态：映射
          const NOISE_FLOOR = 0.25;
          const raw = boosted < NOISE_FLOOR ? 0 : (boosted - NOISE_FLOOR) / (1 - NOISE_FLOOR);

          const GAMMA = 0.55;
          let level = Math.pow(raw, GAMMA);

          // 平滑
          const prev = getPrevLevel();
          const SMOOTH = 0.35;
          level = prev + (level - prev) * SMOOTH;

          // 双端视觉压缩
          if (level < 0.2) {
            const t = level / 0.2;
            const scale = 0.7 + 0.3 * t;
            level *= scale;
          } else if (level > 0.8) {
            const t = (1 - level) / 0.2;
            const scale = 0.7 + 0.3 * t;
            level *= scale;
          }

          if (level > 0 && level < 0.04) level = 0.04;

          setLevel(level);

          if (analysingRef.current) {
            rafIdRef.current = requestAnimationFrame(tick);
          }
        };

        tick();
      });
    } catch (err) {
      console.error("[voice] mic permission/record failed:", err);
    }
  }, [isRecording, isTranscribing, sttUrl, onTranscript, levelTargetRef, cleanupAnalyser]);

  const stop = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    try {
      cleanupAnalyser();
      mr.stop();
    } catch (err) {
      console.error("[voice] stop failed:", err);
    }
  }, [cleanupAnalyser]);

  return { isRecording, isTranscribing, start, stop };
}
