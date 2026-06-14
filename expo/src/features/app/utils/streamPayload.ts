type StreamSegmentEnvelope = {
  seq: number | null;
  text: string;
  audioUrl: string;
  mimeType: string;
  audioBytes: number;
  chunkChars: number | null;
  segmentTargetChars: number | null;
  estimatedDurationMs: number | null;
};

function parseNullableFiniteNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseStreamSegmentEnvelope(payload: unknown): StreamSegmentEnvelope {
  const data = (payload && typeof payload === "object")
    ? payload as Record<string, unknown>
    : {};
  const seqRaw = Number(data.seq);
  const audioBytesRaw = Number(data.audioBytes);
  return {
    seq: Number.isInteger(seqRaw) ? seqRaw : null,
    text: String(data.text || ""),
    audioUrl: String(data.audioUrl || "").trim(),
    mimeType: String(data.mimeType || "audio/wav"),
    audioBytes: Number.isFinite(audioBytesRaw) ? Math.max(0, Math.floor(audioBytesRaw)) : 0,
    chunkChars: parseNullableFiniteNumber(data.chunkChars),
    segmentTargetChars: parseNullableFiniteNumber(data.segmentTargetChars),
    estimatedDurationMs: parseNullableFiniteNumber(data.estimatedDurationMs),
  };
}
