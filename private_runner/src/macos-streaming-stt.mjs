import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BYTES_PER_SECOND, MAX_DURATION_SECONDS, MAX_PENDING_BYTES,
  validAudioFrame, validStart, validStop,
} from "./streaming-stt-protocol.mjs";

const execFileAsync = promisify(execFile);
const BUILD_SCRIPT = fileURLToPath(new URL("../scripts/build-macos-stt-helper.sh", import.meta.url));
const HELPER = fileURLToPath(new URL("../.native-build/BittyMacStt.app/Contents/MacOS/BittyMacStt", import.meta.url));
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * MAX_DURATION_SECONDS;
const VAD_THRESHOLD = 0.015;
const VAD_START_MS = 120;
const VAD_END_MS = 850;
let buildPromise;

async function launchHelper() {
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  buildPromise ??= execFileAsync(BUILD_SCRIPT, { timeout: 120_000 }).catch((error) => {
    buildPromise = undefined;
    throw error;
  });
  await buildPromise;
  return spawn(HELPER, [], { stdio: ["pipe", "pipe", "ignore"] });
}

function audioLevel(buffer) {
  let squareSum = 0;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / (buffer.length / 2));
}

const NATIVE_ERRORS = {
  macos_locale_unavailable: "このMacでは日本語の音声認識を利用できません。",
  macos_on_device_unavailable: "このMacでは日本語のオンデバイス音声認識を利用できません。",
  macos_speech_permission_denied: "Runner Macのシステム設定でBitty Private Runner Speechの音声認識を許可してください。",
  macos_recognizer_unavailable: "Macの音声認識を現在利用できません。",
  macos_audio_format_unavailable: "Macの音声認識に必要な音声形式を作成できません。",
  macos_invalid_audio: "Macの音声認識に不正な音声データが届きました。",
  macos_recognition_failed: "Macの音声認識に失敗しました。",
};

export function createMacosStreamingSttHandler({
  startHelper = launchHelper,
  finalizationTimeoutMs = 15_000,
  startupTimeoutMs = 120_000,
  noSpeechTimeoutMs = 55_000,
} = {}) {
  return (ws) => {
    let phase = "awaiting_start";
    let child;
    let terminal = false;
    let inputEnded = false;
    let endReason = "";
    let sentBytes = 0;
    let pendingBytes = 0;
    let speechBegan = false;
    let finalHadText = false;
    let loudMs = 0;
    let silentMs = 0;
    let output = "";
    let work = Promise.resolve();
    let startupTimer;
    let noSpeechTimer;
    let maxDurationTimer;
    let finalizationTimer;

    const clearTimers = () => {
      clearTimeout(startupTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
    };
    const send = (message) => {
      if (!terminal && ws.readyState === 1) ws.send(JSON.stringify(message));
    };
    const closeChild = () => {
      child?.stdin.destroy();
      child?.kill();
    };
    const finishError = (code, message, retryable = false) => {
      if (terminal) return;
      send({ type: "error", code, message, retryable });
      terminal = true;
      clearTimers();
      if (ws.readyState === 1) ws.close(1000);
      closeChild();
    };
    const finishDone = () => {
      if (terminal) return;
      send({ type: "done", reason: endReason || (speechBegan ? "speech_end_timeout" : "no_speech_timeout"), hasSpeech: finalHadText });
      terminal = true;
      clearTimers();
      if (ws.readyState === 1) ws.close(1000);
      closeChild();
    };
    const endInput = (reason) => {
      if (terminal || inputEnded) return;
      inputEnded = true;
      endReason = reason;
      phase = "finalizing";
      clearTimeout(noSpeechTimer);
      clearTimeout(maxDurationTimer);
      child.stdin.end();
      finalizationTimer = setTimeout(() => {
        if (reason === "no_speech_timeout" && !speechBegan) finishDone();
        else finishError("macos_finalization_timeout", "Macの音声認識が終了しませんでした。", true);
      }, finalizationTimeoutMs);
      finalizationTimer.unref?.();
    };
    const beginSpeech = () => {
      if (speechBegan) return;
      speechBegan = true;
      clearTimeout(noSpeechTimer);
      send({ type: "speech_activity_begin" });
    };
    const onHelperMessage = (message) => {
      if (terminal || !message || typeof message !== "object") return;
      if (message.type === "ready" && phase === "starting") {
        clearTimeout(startupTimer);
        phase = "ready";
        send({ type: "ready" });
        noSpeechTimer = setTimeout(() => endInput("no_speech_timeout"), noSpeechTimeoutMs);
        noSpeechTimer.unref?.();
        maxDurationTimer = setTimeout(() => endInput("max_duration"), MAX_DURATION_SECONDS * 1000);
        maxDurationTimer.unref?.();
        return;
      }
      if (message.type === "transcript" && (phase === "ready" || phase === "finalizing")
        && typeof message.text === "string" && typeof message.isFinal === "boolean") {
        if (message.text.trim()) beginSpeech();
        if (message.isFinal && message.text.trim()) finalHadText = true;
        send({ type: "transcript", text: message.text, isFinal: message.isFinal, stability: message.isFinal ? 1 : 0 });
        if (message.isFinal && !inputEnded) {
          send({ type: "speech_activity_end" });
          endInput("speech_end_timeout");
        }
        return;
      }
      if (message.type === "error" && typeof message.code === "string") {
        if (!Object.hasOwn(NATIVE_ERRORS, message.code)) {
          finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true);
          return;
        }
        if (message.code === "macos_recognition_failed" && phase === "finalizing"
          && endReason === "no_speech_timeout" && !speechBegan) {
          finishDone();
          return;
        }
        finishError(message.code, NATIVE_ERRORS[message.code],
          message.code === "macos_recognition_failed");
        return;
      }
      finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true);
    };
    const start = async (payload) => {
      if (!validStart(payload)) {
        finishError("invalid_start", "Expected start with sampleRate 16000");
        return;
      }
      phase = "starting";
      startupTimer = setTimeout(() => finishError("macos_start_timeout", "Macの音声認識を開始できませんでした。", true), startupTimeoutMs);
      startupTimer.unref?.();
      try {
        child = await startHelper();
        if (terminal) { closeChild(); return; }
        child.stdout.on("data", (chunk) => {
          output += chunk.toString("utf8");
          if (output.length > 1024 * 1024) {
            finishError("macos_helper_protocol", "Macの音声認識から大きすぎる応答を受信しました。", true);
            return;
          }
          let newline;
          while ((newline = output.indexOf("\n")) !== -1 && !terminal) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            try { onHelperMessage(JSON.parse(line)); }
            catch { finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true); }
          }
        });
        child.once("error", () => finishError("macos_helper_failed", "Macの音声認識を起動できませんでした。", true));
        child.once("close", (code) => {
          if (terminal) return;
          if (code === 0 && phase === "finalizing") finishDone();
          else finishError("macos_helper_failed", "Macの音声認識が予期せず終了しました。", true);
        });
      } catch (error) {
        finishError("macos_helper_unavailable", error?.message === "unsupported_platform"
          ? "macOS標準の音声認識にはMac上のPrivate Runnerが必要です。"
          : "Runner Macで音声認識の準備に失敗しました。Xcodeを確認してください。", false);
      }
    };
    const processAudio = async (buffer) => {
      if (terminal || inputEnded) return;
      const audio = buffer.subarray(0, MAX_AUDIO_BYTES - sentBytes);
      if (!audio.length) {
        endInput("max_duration");
        return;
      }
      await new Promise((resolve, reject) => child.stdin.write(audio, (error) => error ? reject(error) : resolve()));
      sentBytes += audio.length;
      const durationMs = audio.length / BYTES_PER_SECOND * 1000;
      if (audioLevel(audio) >= VAD_THRESHOLD) {
        loudMs += durationMs;
        silentMs = 0;
        if (loudMs >= VAD_START_MS) beginSpeech();
      } else {
        loudMs = 0;
        if (speechBegan) {
          silentMs += durationMs;
          if (silentMs >= VAD_END_MS) {
            send({ type: "speech_activity_end" });
            endInput("speech_end_timeout");
          }
        }
      }
      if (sentBytes >= MAX_AUDIO_BYTES) endInput("max_duration");
    };

    ws.on("message", (raw, isBinary) => {
      if (terminal || inputEnded) return;
      if (isBinary) {
        if (phase !== "ready") {
          finishError("protocol_order", "Audio is only accepted after ready");
          return;
        }
        const buffer = Buffer.from(raw);
        if (!validAudioFrame(buffer)) {
          finishError("invalid_audio_frame", "PCM audio frames must be even-sized and no larger than 65536 bytes");
          return;
        }
        pendingBytes += buffer.length;
        if (pendingBytes > MAX_PENDING_BYTES) {
          finishError("backpressure_exceeded", "Speech audio could not be processed quickly enough", true);
          return;
        }
        work = work.then(() => processAudio(buffer))
          .catch(() => finishError("macos_audio_write_failed", "Macの音声認識へ音声を送れませんでした。", true))
          .finally(() => { pendingBytes -= buffer.length; });
        return;
      }
      let payload;
      try { payload = JSON.parse(String(raw || "")); }
      catch { finishError("invalid_json", "Control messages must be valid JSON"); return; }
      if (phase === "awaiting_start") { void start(payload); return; }
      if (phase === "ready" && validStop(payload)) {
        work = work.then(() => endInput("user_stop"));
        return;
      }
      finishError("protocol_order", "Unexpected speech stream control message");
    });
    ws.on("close", () => {
      if (terminal) return;
      terminal = true;
      clearTimers();
      closeChild();
    });
  };
}
