const TRANSCRIPT_INACTIVITY_MS = 2_000;

export function createTranscriptInactivityTimer(onTimeout) {
  let lastText = "";
  let timer;
  let stopped = false;

  return {
    update(text) {
      if (stopped || text === lastText) return;
      lastText = text;
      clearTimeout(timer);
      if (!text.trim()) return;
      timer = setTimeout(onTimeout, TRANSCRIPT_INACTIVITY_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
