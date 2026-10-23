import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generator = path.join(repoRoot, "scripts/generate-retro-sfx.mjs");

test("voice cues reproduce the adopted Neon Relay audition including its fading echoes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bitty-voice-sfx-"));
  try {
    execFileSync(process.execPath, [generator, "--voice-input-only"], { cwd });
    for (const [filePath, adoptedHash] of [
      ["modules/bitty-stt-transport/ios/Resources/voice-input-ready.wav", "8e311ffad5590fcd1d39629acd7f2654eb9c9b5d273e35b796258c81b885a9f1"],
      ["assets/sfx/voice-input-send.wav", "0d39157c88e9789a686e209028a11ac94998dd185bb0b79f7ed3ed89c321058e"],
    ]) {
      const wav = await readFile(path.join(cwd, filePath));
      assert.equal(createHash("sha256").update(wav).digest("hex"), adoptedHash, "exact adopted audition, independent of preview files");
      assert.deepEqual(wav, await readFile(path.join(repoRoot, "expo", filePath)), "production asset matches its generator");
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt16LE(20), 1, "PCM");
      assert.equal(wav.readUInt16LE(22), 1, "mono");
      assert.equal(wav.readUInt32LE(24), 44100);
      assert.equal(wav.readUInt16LE(34), 16);
      const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
      assert.equal(samples.length, 18522, "420 ms cue");
      assert.ok(Math.max(...samples.map(Math.abs)) < 0.65, "headroom without clipping");
      assert.equal(samples[0], 0, "silent onset boundary");
      assert.equal(samples.at(-1), 0, "silent final boundary");
      const rms = (startMs, endMs) => {
        const window = samples.slice(Math.round(startMs * 44.1), Math.round(endMs * 44.1));
        return Math.sqrt(window.reduce((energy, sample) => energy + sample * sample, 0) / window.length);
      };
      // Both dry notes end by 221 ms. These later windows contain successive echoes only.
      const firstTail = rms(225, 250), secondTail = rms(280, 305), thirdTail = rms(335, 360);
      assert.ok(firstTail > secondTail && secondTail > thirdTail && thirdTail > 0.0005, "three fading echo tails survive after the dry notes");
      assert.equal(rms(400, 420), 0, "echoes settle before the cue ends");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("theme and reset cue regeneration remains unchanged", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bitty-other-sfx-"));
  try {
    for (const flag of ["--themes-only", "--voice-reset-only"]) {
      execFileSync(process.execPath, [generator, flag], { cwd });
    }
    for (const filePath of [
      "assets/themes/cyberpunk/sfx/popup-open.wav",
      "assets/themes/cyberpunk/sfx/popup-close.wav",
      "assets/sfx/voice-reset-confirmation.wav",
    ]) {
      assert.deepEqual(await readFile(path.join(cwd, filePath)), await readFile(path.join(repoRoot, "expo", filePath)), filePath);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
