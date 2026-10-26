import { spawn } from "node:child_process";

export async function convertTtsAudioToMp3(audioBuffer, { audioQuality = "standard", inputFormat } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length <= 0) {
    throw new Error("TTS MP3 conversion input is empty");
  }

  const timeoutMs = 30000;
  const stderrMaxBytes = 8192;
  const chunks = [];
  let stderr = "";
  let resolved = false;

  const result = await new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(inputFormat ? ["-f", inputFormat] : []),
      "-i",
      "pipe:0",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      audioQuality === "lightweight" ? "32k" : "96k",
      ...(audioQuality === "lightweight" ? ["-ac", "1", "-ar", "24000"] : []),
      "-f",
      "mp3",
      "pipe:1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: -1, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < stderrMaxBytes) {
        const text = String(chunk || "");
        stderr += text.slice(0, Math.max(0, stderrMaxBytes - stderr.length));
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        exitCode: -1,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exitCode: Number.isFinite(Number(code)) ? Number(code) : -1,
        timedOut: false,
      });
    });

    child.stdin.end(audioBuffer);
  });

  const mp3Buffer = Buffer.concat(chunks);
  if (result?.timedOut) {
    throw new Error(`TTS MP3 conversion timed out after ${timeoutMs}ms`);
  }
  if (Number(result?.exitCode) !== 0) {
    const detail = String(result?.error || stderr || "ffmpeg exited without details").trim();
    throw new Error(`TTS MP3 conversion failed: ${detail}`);
  }
  if (!mp3Buffer.length) {
    throw new Error("TTS MP3 conversion returned empty audio");
  }
  return mp3Buffer;
}
