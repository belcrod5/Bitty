import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 44100;
const OUT_DIR = path.resolve("assets/sfx");

function clamp01(v) {
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

function envAt(t, duration, attackMs = 2, releaseMs = 20) {
  const attack = Math.max(0.001, attackMs / 1000);
  const release = Math.max(0.001, releaseMs / 1000);
  if (t < attack) return t / attack;
  if (t > duration - release) return Math.max(0, (duration - t) / release);
  return 1;
}

function tone({
  freq = 440,
  toFreq = null,
  durationMs = 120,
  volume = 0.4,
  wave = "square",
  pulseWidth = 0.5,
  attackMs = 2,
  releaseMs = 24,
}) {
  const duration = Math.max(0.001, durationMs / 1000);
  const samples = Math.floor(duration * SAMPLE_RATE);
  const out = new Float32Array(samples);
  let phase = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = i / Math.max(1, samples - 1);
    const f = toFreq === null ? freq : freq + (toFreq - freq) * progress;
    phase += f / SAMPLE_RATE;
    phase -= Math.floor(phase);

    let v = 0;
    if (wave === "square") {
      v = phase < pulseWidth ? 1 : -1;
    } else if (wave === "triangle") {
      v = 1 - 4 * Math.abs(phase - 0.5);
    } else if (wave === "noise") {
      v = Math.random() * 2 - 1;
    } else {
      v = Math.sin(phase * Math.PI * 2);
    }

    const e = envAt(t, duration, attackMs, releaseMs);
    out[i] = clamp01(v * volume * e);
  }
  return out;
}

function silence(durationMs) {
  const samples = Math.max(1, Math.floor((durationMs / 1000) * SAMPLE_RATE));
  return new Float32Array(samples);
}

function concat(parts) {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function mix(parts) {
  const maxLen = parts.reduce((acc, p) => Math.max(acc, p.length), 0);
  const out = new Float32Array(maxLen);
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      out[i] += part[i];
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = clamp01(out[i]);
  }
  return out;
}

function toPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = clamp01(samples[i]);
    const n = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    buf.writeInt16LE(n, i * 2);
  }
  return buf;
}

function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function writeWav(fileName, samples) {
  const pcm = toPcm16(samples);
  const header = wavHeader(pcm.length);
  const outPath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
  return outPath;
}

function buildSfxPack() {
  const sfx = {
    "retro-send.wav": concat([
      tone({ freq: 740, toFreq: 820, durationMs: 70, volume: 0.34, pulseWidth: 0.35 }),
      silence(18),
      tone({ freq: 980, toFreq: 1120, durationMs: 80, volume: 0.32, pulseWidth: 0.32 }),
    ]),
    "retro-reply.wav": concat([
      tone({ freq: 660, durationMs: 55, volume: 0.28, pulseWidth: 0.4 }),
      silence(12),
      tone({ freq: 880, durationMs: 55, volume: 0.27, pulseWidth: 0.4 }),
      silence(12),
      tone({ freq: 1180, durationMs: 80, volume: 0.26, pulseWidth: 0.4 }),
    ]),
    "retro-tool-start.wav": tone({ freq: 520, toFreq: 640, durationMs: 90, volume: 0.28, pulseWidth: 0.3 }),
    "retro-tool-done.wav": concat([
      tone({ freq: 720, durationMs: 60, volume: 0.26, pulseWidth: 0.4 }),
      silence(10),
      tone({ freq: 940, durationMs: 90, volume: 0.24, pulseWidth: 0.4 }),
    ]),
    "retro-youtube-play.wav": concat([
      tone({ freq: 700, durationMs: 60, volume: 0.24, pulseWidth: 0.4 }),
      silence(8),
      tone({ freq: 1040, durationMs: 130, volume: 0.23, pulseWidth: 0.36 }),
    ]),
    "retro-youtube-stop.wav": concat([
      tone({ freq: 580, durationMs: 70, volume: 0.22, pulseWidth: 0.35 }),
      silence(8),
      tone({ freq: 380, durationMs: 110, volume: 0.24, pulseWidth: 0.33 }),
    ]),
    "retro-record-start.wav": tone({ freq: 760, toFreq: 980, durationMs: 120, volume: 0.25, pulseWidth: 0.28 }),
    "retro-record-stop.wav": tone({ freq: 620, toFreq: 380, durationMs: 140, volume: 0.25, pulseWidth: 0.32 }),
    "retro-approval.wav": concat([
      tone({ freq: 430, durationMs: 80, volume: 0.2, pulseWidth: 0.4 }),
      silence(8),
      tone({ freq: 560, durationMs: 100, volume: 0.2, pulseWidth: 0.4 }),
    ]),
    "retro-error.wav": mix([
      tone({ freq: 200, toFreq: 150, durationMs: 180, volume: 0.2, pulseWidth: 0.45 }),
      tone({ freq: 1900, durationMs: 100, volume: 0.035, wave: "noise", releaseMs: 40 }),
    ]),
  };

  return sfx;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pack = buildSfxPack();
  const written = [];
  for (const [fileName, samples] of Object.entries(pack)) {
    const outPath = writeWav(fileName, samples);
    written.push(path.relative(process.cwd(), outPath));
  }
  console.log("Generated retro SFX:");
  for (const p of written) {
    console.log(`- ${p}`);
  }
}

main();
