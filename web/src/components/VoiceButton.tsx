import { useRef, type Ref } from "react";
import styles from "./VoiceButton.module.css";

type Props = {
  isRecording: boolean;
  isTranscribing: boolean;
  onStart: () => void;
  onStop: () => void;
  right?: number;
  bottom?: number;
  buttonRef?: Ref<HTMLButtonElement>;
};

export default function VoiceButton({
  isRecording,
  isTranscribing,
  onStart,
  onStop,
  right = 16,
  bottom = 72,
  buttonRef,
}: Props) {
  const disabled = isTranscribing;
  const ignoreClickUntilRef = useRef<number>(0);
  const triggerAction = () => {
    if (disabled) return;
    if (isRecording) {
      onStop();
      return;
    }
    onStart();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className={[
        styles.btn,
        isRecording ? styles.recording : "",
        disabled ? styles.disabled : "",
      ].join(" ")}
      style={{ right, bottom }}
      onPointerDown={(e) => {
        e.preventDefault();
        ignoreClickUntilRef.current = Date.now() + 450;
        triggerAction();
      }}
      onClick={(e) => {
        if (Date.now() < ignoreClickUntilRef.current) {
          e.preventDefault();
          return;
        }
        triggerAction();
      }}
      disabled={disabled}
      aria-label={
        isTranscribing
          ? "Transcribing"
          : isRecording
          ? "Stop recording"
          : "Start recording"
      }
      title={
        isTranscribing
          ? "Transcribing..."
          : isRecording
          ? "Stop recording"
          : "Voice input"
      }
    >
      {/* 图标 / 转写 spinner */}
      {!isTranscribing ? (
        <span className={styles.iconWrap} aria-hidden="true">
          <svg
            className={styles.audioIcon}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path className={styles.bar} d="M2 10v3" />
            <path className={`${styles.bar} ${styles.bar2}`} d="M6 6v11" />
            <path className={`${styles.bar} ${styles.bar3}`} d="M10 3v18" />
            <path className={`${styles.bar} ${styles.bar4}`} d="M14 8v7" />
            <path className={`${styles.bar} ${styles.bar5}`} d="M18 5v13" />
            <path className={`${styles.bar} ${styles.bar6}`} d="M22 10v3" />
          </svg>
        </span>
      ) : (
        <span className={styles.iconWrap} aria-hidden="true">
           <span className={styles.spinner} />
        </span>
      )}
    </button>
  );
}
