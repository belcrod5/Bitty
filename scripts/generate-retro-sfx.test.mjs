import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("voice cues regenerate reproducibly with body and clear harmonics at unclipped levels", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bitty-voice-sfx-"));
  try {
    execFileSync(process.execPath, [path.join(repoRoot, "scripts/generate-retro-sfx.mjs"), "--voice-input-only"], { cwd });
    for (const [filePath, firstFrequency, firstNoteMs, totalMs] of [
      ["modules/bitty-stt-transport/ios/Resources/voice-input-ready.wav", 660, 80, 212],
      ["assets/sfx/voice-input-send.wav", 1046.5, 70, 178],
    ]) {
      const wav = await readFile(path.join(cwd, filePath));
      assert.deepEqual(wav, await readFile(path.join(repoRoot, "expo", filePath)), "committed asset matches its generator");
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt16LE(20), 1, "PCM");
      assert.equal(wav.readUInt16LE(22), 1, "mono");
      assert.equal(wav.readUInt32LE(24), 44100);
      assert.equal(wav.readUInt16LE(34), 16);
      const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
      assert.ok(Math.abs(samples.length / 44.1 - totalMs) < 0.1, "short cue duration is retained");
      assert.ok(Math.max(...samples.map(Math.abs)) < 0.4, "headroom without clipping or louder peaks");
      assert.ok(Math.abs(samples[0]) < 0.001 && Math.abs(samples.at(-1)) < 0.001, "smooth cue boundaries");
      const noteLength = Math.floor(firstNoteMs * 44.1);
      const amplitude = (frequency) => {
        let real = 0, imaginary = 0;
        for (let i = 0; i < noteLength; i++) {
          const sample = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (noteLength - 1)));
          real += sample * Math.cos(2 * Math.PI * frequency * i / 44100);
          imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 44100);
        }
        return Math.hypot(real, imaginary);
      };
      const fundamental = amplitude(firstFrequency);
      assert.ok(amplitude(firstFrequency / 2) / fundamental > 0.2, "audible octave body");
      assert.ok(amplitude(firstFrequency * 2) / fundamental > 0.3, "clear second harmonic");
      assert.ok(amplitude(firstFrequency * 3) / fundamental > 0.15, "clear third harmonic");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
