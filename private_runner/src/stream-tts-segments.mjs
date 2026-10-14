export const TTS_SEGMENT_BOUNDARY = "。";

export function takeNextStreamTtsSegment(buffer, force = false) {
  const text = String(buffer || "");
  const boundary = text.indexOf(TTS_SEGMENT_BOUNDARY);
  if (boundary >= 0) {
    return { segment: text.slice(0, boundary + 1), rest: text.slice(boundary + 1) };
  }
  return force && text.trim() ? { segment: text, rest: "" } : null;
}

export function createStreamTtsSegments({
  emit, synthesizeSegment, signal, speedScale, sanitizeText, estimateDurationMs,
}) {
  let pending = "";
  let nextSeq = 0;
  let chain = Promise.resolve();
  let failure = null;
  let cancelled = false;
  let finished = false;

  function queue(rawText) {
    const text = sanitizeText(rawText);
    if (!text) return;
    const seq = nextSeq++;
    const details = {
      seq, text, rawText,
      chunkChars: text.length,
      rawChars: rawText.length,
      estimatedDurationMs: estimateDurationMs(text, speedScale),
      speedScale,
    };
    const queuedAt = performance.now();
    emit({ type: "segment_queued", ...details });
    chain = chain.then(async () => {
      if (cancelled || signal?.aborted || failure) return;
      const queueWaitMs = performance.now() - queuedAt;
      emit({ type: "segment_tts_started", ...details, queueWaitMs });
      try {
        const audio = await synthesizeSegment(text, seq);
        if (cancelled || signal?.aborted) return;
        emit({ type: "audio_chunk", ...details, ...audio, queueWaitMs, speedScale: audio.speedScale });
        emit({ type: "segment_tts_done", ...details });
      } catch (error) {
        failure = error;
      }
    });
  }

  function flush(force) {
    for (;;) {
      const next = takeNextStreamTtsSegment(pending, force);
      if (!next) return;
      pending = next.rest;
      queue(next.segment);
    }
  }

  return {
    append(delta) {
      if (cancelled || signal?.aborted || finished || !delta) return;
      pending += delta;
      flush(false);
    },
    async finish() {
      if (cancelled || signal?.aborted) return;
      if (!finished) { finished = true; flush(true); }
      await chain;
      if (failure) throw failure;
    },
    cancel() { cancelled = true; pending = ""; },
  };
}
