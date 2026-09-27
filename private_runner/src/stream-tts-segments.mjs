export function createStreamTtsSegments({
  emit, synthesizeSegment, signal, speedScale, takeNextSegment, sanitizeText,
  maxChars, targetChars, maxEstMs, estimateDurationMs,
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
      segmentTargetChars: targetChars,
      segmentMaxEstMs: maxEstMs,
      speedScale,
    };
    emit({ type: "segment_queued", ...details });
    chain = chain.then(async () => {
      if (cancelled || signal?.aborted || failure) return;
      emit({ type: "segment_tts_started", ...details });
      try {
        const audio = await synthesizeSegment(text, seq);
        if (cancelled || signal?.aborted) return;
        emit({ type: "audio_chunk", ...details, ...audio, speedScale: audio.speedScale });
        emit({ type: "segment_tts_done", ...details });
      } catch (error) {
        failure = error;
      }
    });
  }

  function flush(force) {
    for (;;) {
      const next = takeNextSegment(pending, maxChars, force);
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
