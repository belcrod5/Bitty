export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024;
export const MAX_DURATION_SECONDS = 4 * 60 + 50;

export function validStart(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === 2
    && payload.type === "start" && payload.sampleRate === SAMPLE_RATE;
}

export function validStop(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === 1 && payload.type === "stop";
}

export function validAudioFrame(buffer) {
  return buffer.length > 0 && buffer.length <= MAX_FRAME_BYTES && buffer.length % 2 === 0;
}
