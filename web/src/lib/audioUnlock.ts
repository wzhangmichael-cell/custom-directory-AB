let unlocked = false;
const DEV_MODE = import.meta.env.DEV;

export async function unlockAudioOnce() {
  if (unlocked) return true;

  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === "suspended") await ctx.resume();

      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      source.stop(0.01);
    }

    const a = document.createElement("audio");
    a.muted = true;
    a.playsInline = true;
    a.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

    await a.play();
    a.pause();
    a.currentTime = 0;
    a.muted = false;

    unlocked = true;
    return true;
  } catch (e) {
    if (DEV_MODE) console.warn("[audio] unlock failed", e);
    return false;
  }
}

export function isAudioUnlocked() {
  return unlocked;
}
