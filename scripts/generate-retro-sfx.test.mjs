import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("voice cues regenerate with original melodies and decaying upper harmonics", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bitty-voice-sfx-"));
  try {
    execFileSync(process.execPath, [path.join(repoRoot, "scripts/generate-retro-sfx.mjs"), "--voice-input-only"], { cwd });
    for (const [filePath, firstFrequency, secondFrequency, firstNoteMs, gapMs, totalMs] of [
      ["modules/bitty-stt-transport/ios/Resources/voice-input-ready.wav", 660, 880, 80, 12, 212],
      ["assets/sfx/voice-input-send.wav", 1046.5, 784, 70, 8, 178],
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
      assert.ok(Math.max(...samples.map(Math.abs)) < 0.4, "headroom without clipping");
      assert.ok(Math.abs(samples[0]) < 0.001 && Math.abs(samples.at(-1)) < 0.001, "smooth cue boundaries");
      const firstNoteLength = Math.floor(firstNoteMs * 44.1);
      const secondNoteStart = firstNoteLength + Math.floor(gapMs * 44.1);
      assert.ok(samples.slice(firstNoteLength, secondNoteStart).every((sample) => sample === 0), "original silent gap");
      const amplitude = (note, frequency, startMs = 0, endMs = note.length / 44.1) => {
        let real = 0, imaginary = 0;
        const start = Math.floor(startMs * 44.1);
        const noteLength = Math.floor(endMs * 44.1) - start;
        for (let i = 0; i < noteLength; i++) {
          const sample = note[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (noteLength - 1)));
          real += sample * Math.cos(2 * Math.PI * frequency * i / 44100);
          imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 44100);
        }
        return Math.hypot(real, imaginary);
      };
      for (const [note, frequency] of [
        [samples.slice(0, firstNoteLength), firstFrequency],
        [samples.slice(secondNoteStart), secondFrequency],
      ]) {
        const fundamental = amplitude(note, frequency);
        assert.ok(fundamental > amplitude(note, frequency * 0.9) * 4, "original note pitch");
        assert.ok(fundamental > amplitude(note, frequency * 1.1) * 4, "original note pitch");
        assert.ok(fundamental > amplitude(note, frequency * 2), "fundamental remains the body");
        const earlyRatio = amplitude(note, frequency * 2, 8, 28) / amplitude(note, frequency, 8, 28);
        const lateRatio = amplitude(note, frequency * 2, 45, 65) / amplitude(note, frequency, 45, 65);
        assert.ok(lateRatio < earlyRatio * 0.5, "upper harmonic settles faster than the body");
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
