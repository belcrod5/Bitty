export type AudioContainer = "wav" | "mp3" | "ogg" | "m4a" | "unknown";

const DEFAULT_WAVEFORM_BARS = 192;
const DEFAULT_WAVEFORM_VIEW_BARS = 64;

function fourCc(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

export function detectAudioContainer(bytes: Uint8Array, mimeType?: string): AudioContainer {
  if (bytes.length >= 12) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (fourCc(view, 0) === "RIFF" && fourCc(view, 8) === "WAVE") return "wav";
    if (fourCc(view, 0) === "OggS") return "ogg";
    if (fourCc(view, 4) === "ftyp") return "m4a";
  }

  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "mp3";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "mp3";
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  if (normalizedMimeType.includes("wav")) return "wav";
  if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) return "mp3";
  if (normalizedMimeType.includes("ogg")) return "ogg";
  if (
    normalizedMimeType.includes("mp4") ||
    normalizedMimeType.includes("m4a") ||
    normalizedMimeType.includes("aac")
  ) {
    return "m4a";
  }

  return "unknown";
}

export function resolveAudioFileExtension(container: AudioContainer, mimeType?: string) {
  if (container === "mp3") return "mp3";
  if (container === "wav") return "wav";
  if (container === "ogg") return "ogg";
  if (container === "m4a") return "m4a";
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) return "mp3";
  if (normalizedMimeType.includes("wav")) return "wav";
  if (normalizedMimeType.includes("ogg")) return "ogg";
  if (normalizedMimeType.includes("mp4") || normalizedMimeType.includes("m4a")) return "m4a";
  return "bin";
}

function readWavSample(view: DataView, offset: number, audioFormat: number, bitsPerSample: number) {
  let value = 0;
  if (audioFormat === 3 && bitsPerSample === 32) {
    value = view.getFloat32(offset, true);
  } else if (audioFormat === 1) {
    if (bitsPerSample === 8) {
      value = (view.getUint8(offset) - 128) / 128;
    } else if (bitsPerSample === 16) {
      value = view.getInt16(offset, true) / 32768;
    } else if (bitsPerSample === 24) {
      const b0 = view.getUint8(offset);
      const b1 = view.getUint8(offset + 1);
      const b2 = view.getUint8(offset + 2);
      let int = b0 | (b1 << 8) | (b2 << 16);
      if (int & 0x800000) int |= ~0xffffff;
      value = int / 8388608;
    } else if (bitsPerSample === 32) {
      value = view.getInt32(offset, true) / 2147483648;
    }
  }
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

export function extractWaveformBarsFromWavBytes(bytes: Uint8Array, bars = DEFAULT_WAVEFORM_BARS) {
  if (bytes.length < 44) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourCc(view, 0) !== "RIFF" || fourCc(view, 8) !== "WAVE") return [];

  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let cursor = 12;
  while (cursor + 8 <= view.byteLength) {
    const chunkId = fourCc(view, cursor);
    const chunkSize = view.getUint32(cursor + 4, true);
    const chunkDataOffset = cursor + 8;
    if (chunkDataOffset > view.byteLength) break;
    const chunkDataEnd = Math.min(view.byteLength, chunkDataOffset + chunkSize);
    if (chunkId === "fmt " && fmtOffset < 0) {
      fmtOffset = chunkDataOffset;
      fmtSize = chunkDataEnd - chunkDataOffset;
    } else if (chunkId === "data" && dataOffset < 0) {
      dataOffset = chunkDataOffset;
      dataSize = chunkDataEnd - chunkDataOffset;
    }
    cursor = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (fmtOffset < 0 || fmtSize < 16 || dataOffset < 0 || dataSize <= 0) return [];
  const audioFormatRaw = view.getUint16(fmtOffset, true);
  const channels = view.getUint16(fmtOffset + 2, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);
  const extensibleSubFormat = (
    audioFormatRaw === 0xfffe && fmtSize >= 40
      ? view.getUint16(fmtOffset + 24, true)
      : 0
  );
  const audioFormat = audioFormatRaw === 0xfffe ? extensibleSubFormat : audioFormatRaw;
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const blockAlign = view.getUint16(fmtOffset + 12, true) || channels * bytesPerSample;
  if ((audioFormat !== 1 && audioFormat !== 3) || channels <= 0 || bytesPerSample <= 0 || blockAlign <= 0) return [];
  if (dataOffset + dataSize > view.byteLength) return [];

  const frameCount = Math.floor(dataSize / blockAlign);
  if (frameCount <= 0) return [];
  const peakBars = Array.from({ length: bars }, () => 0);

  for (let barIndex = 0; barIndex < bars; barIndex += 1) {
    const fromFrame = Math.floor((barIndex / bars) * frameCount);
    const toFrame = Math.max(fromFrame + 1, Math.floor(((barIndex + 1) / bars) * frameCount));
    let peak = 0;
    for (let frame = fromFrame; frame < toFrame; frame += 1) {
      const frameOffset = dataOffset + frame * blockAlign;
      let sumAbs = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        const sampleOffset = frameOffset + ch * bytesPerSample;
        if (sampleOffset + bytesPerSample > dataOffset + dataSize) continue;
        sumAbs += Math.abs(readWavSample(view, sampleOffset, audioFormat, bitsPerSample));
      }
      peak = Math.max(peak, sumAbs / channels);
    }
    peakBars[barIndex] = Math.max(0, Math.min(1, peak));
  }
  return peakBars;
}

export function extractWaveformBarsFromEncodedBytes(bytes: Uint8Array, bars = DEFAULT_WAVEFORM_BARS) {
  if (bytes.length <= 0 || bars <= 0) return [];
  const points = Array.from({ length: bars }, (_, index) => {
    const from = Math.floor((index / bars) * bytes.length);
    const to = Math.max(from + 1, Math.floor(((index + 1) / bars) * bytes.length));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      const centered = (Number(bytes[i] || 0) - 128) / 128;
      peak = Math.max(peak, Math.abs(centered));
    }
    return Math.max(0.02, Math.min(1, peak));
  });
  return points;
}

export function extractWaveformBarsFromAudioBytes(
  bytes: Uint8Array,
  mimeType?: string,
  bars = DEFAULT_WAVEFORM_BARS
) {
  const container = detectAudioContainer(bytes, mimeType);
  if (container === "wav") {
    const wavBars = extractWaveformBarsFromWavBytes(bytes, bars);
    if (wavBars.length > 0) return wavBars;
  }
  return extractWaveformBarsFromEncodedBytes(bytes, bars);
}

export function resampleWaveformBars(points: number[], bars = DEFAULT_WAVEFORM_VIEW_BARS) {
  const source = Array.isArray(points) ? points : [];
  if (source.length <= 0) return [];
  if (source.length === bars) return source;
  return Array.from({ length: bars }, (_, index) => {
    const from = Math.floor((index / bars) * source.length);
    const to = Math.max(from + 1, Math.floor(((index + 1) / bars) * source.length));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      peak = Math.max(peak, Number(source[i] || 0));
    }
    return Math.max(0, Math.min(1, peak));
  });
}

export function mergeWaveformBars(segments: number[][], bars = DEFAULT_WAVEFORM_BARS) {
  const merged = segments.flat();
  return resampleWaveformBars(merged, bars);
}

export function collectStreamWaveformSegments(raw: number[][]) {
  const segments: number[][] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!Array.isArray(item) || item.length <= 0) continue;
    segments.push(item);
  }
  return segments;
}

export function normalizeMetering(meteringDb: number) {
  const clamped = Math.max(-80, Math.min(0, meteringDb));
  return (clamped + 80) / 80;
}

export function buildEmptyWaveform(enabled: boolean, points: number) {
  if (!enabled || points <= 0) return [];
  return Array.from({ length: points }, () => 0);
}
