import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 44100;
const OUT_DIR = path.resolve("assets/sfx");
const THEME_OUT_DIR = path.resolve("assets/themes");

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
  const isPcm16 = samples instanceof Int16Array;
  for (let i = 0; i < samples.length; i += 1) {
    const s = isPcm16 ? samples[i] : clamp01(samples[i]);
    const n = isPcm16 ? s
      : s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
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

function writeWav(outDir, fileName, samples) {
  const pcm = toPcm16(samples);
  const header = wavHeader(pcm.length);
  const outPath = path.join(outDir, fileName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
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

function buildVoiceInputSfxPack() {
  // Adopted "Neon Relay" pair: decaying metallic FM droplets with three echoes.
  const synth = (notes) => {
    const sampleCount = Math.round(0.420 * SAMPLE_RATE);
    const dry = new Float64Array(sampleCount);
    for (const [onset, frequency, amplitude, length, bend] of notes) {
      const start = Math.round(onset * SAMPLE_RATE);
      for (let j = 0; j < Math.round(length * SAMPLE_RATE) && start + j < sampleCount; j += 1) {
        const t = j / SAMPLE_RATE;
        const progress = t / length;
        let envelope = (1 - Math.exp(-t / 0.0045)) * Math.exp(-t / 0.045);
        envelope *= Math.sin(Math.PI * Math.min(1, (1 - progress) / 0.25) / 2) ** 2;
        const phase = 2 * Math.PI * frequency * (t + bend * 0.018 * (1 - Math.exp(-t / 0.018)));
        const fm = 0.65 * Math.exp(-t / 0.035) * Math.sin(2.004 * phase);
        const body = Math.sin(phase + fm);
        const glass = 0.13 * Math.sin(2.997 * phase) * Math.exp(-t / 0.018);
        dry[start + j] += amplitude * envelope * (body + glass);
      }
    }
    const output = dry.slice();
    for (const [delay, gain] of [[0.057, 0.34], [0.114, 0.135], [0.171, 0.055]]) {
      const offset = Math.round(delay * SAMPLE_RATE);
      for (let i = offset; i < sampleCount; i += 1) output[i] += gain * dry[i - offset];
    }
    let energy = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const fadeIn = Math.min(1, i / Math.round(0.003 * SAMPLE_RATE));
      const fadeOut = Math.min(1, (sampleCount - 1 - i) / Math.round(0.018 * SAMPLE_RATE));
      output[i] *= Math.sin(Math.PI / 2 * fadeIn) ** 2 * Math.sin(Math.PI / 2 * fadeOut) ** 2;
      energy += output[i] * output[i];
      peak = Math.max(peak, Math.abs(output[i]));
    }
    const scale = Math.min(0.095 / Math.sqrt(energy / sampleCount), 0.65 / peak);
    // Quantize symmetrically, matching the selected PCM16 audition exactly.
    return Int16Array.from(output, (sample) => Math.round(sample * scale * 32767));
  };
  return {
    "voice-input-ready.wav": synth([[0, 415.305, 0.85, 0.130, -0.015], [0.066, 622.254, 1, 0.155, -0.010]]),
    "voice-input-send.wav": synth([[0, 622.254, 0.85, 0.130, 0.010], [0.056, 415.305, 1, 0.155, 0.015]]),
  };
}

function buildVoiceResetSfxPack() {
  // Original notification-style bell: two bright notes with a soft decaying overtone.
  const bell = (freq, durationMs) => mix([
    tone({ freq, durationMs, volume: 0.26, wave: "sine", attackMs: 3, releaseMs: durationMs - 8 }),
    tone({ freq: freq * 2.76, durationMs, volume: 0.045, wave: "sine", attackMs: 2, releaseMs: durationMs - 5 }),
  ]);
  return { "voice-reset-confirmation.wav": concat([bell(880, 125), silence(25), bell(1174.66, 240)]) };
}

function buildThemeSfxPacks() {
  const cyberpunkPopupSound = (firstFreq, secondFreq) => concat([
    tone({ freq: firstFreq, durationMs: 15, volume: 0.12, pulseWidth: 0.14, attackMs: 0.5, releaseMs: 3 }),
    silence(11),
    tone({ freq: secondFreq, durationMs: 15, volume: 0.12, pulseWidth: 0.14, attackMs: 0.5, releaseMs: 3 }),
  ]);

  return {
    cyberpunk: {
      "popup-open.wav": cyberpunkPopupSound(3760, 3440),
      "popup-close.wav": cyberpunkPopupSound(4060, 3720),
    },
  };
}

function main() {
  const written = [];
  const themesOnly = process.argv.includes("--themes-only");
  if (themesOnly) {
    for (const [themeId, pack] of Object.entries(buildThemeSfxPacks())) {
      for (const [fileName, samples] of Object.entries(pack)) {
        const outPath = writeWav(path.join(THEME_OUT_DIR, themeId, "sfx"), fileName, samples);
        written.push(path.relative(process.cwd(), outPath));
      }
    }
  } else {
    const pack = process.argv.includes("--voice-reset-only") ? buildVoiceResetSfxPack()
      : process.argv.includes("--voice-input-only") ? buildVoiceInputSfxPack()
        : { ...buildSfxPack(), ...buildVoiceInputSfxPack(), ...buildVoiceResetSfxPack() };
    for (const [fileName, samples] of Object.entries(pack)) {
      const outDir = fileName === "voice-input-ready.wav"
        ? path.resolve("modules/bitty-stt-transport/ios/Resources") : OUT_DIR;
      const outPath = writeWav(outDir, fileName, samples);
      written.push(path.relative(process.cwd(), outPath));
    }
  }
  console.log(themesOnly ? "Generated theme SFX:" : "Generated SFX:");
  for (const p of written) {
    console.log(`- ${p}`);
  }
}

main();
