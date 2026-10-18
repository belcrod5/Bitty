import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTranscriptInactivityTimer } from "./stt-transcript-inactivity.mjs";
import {
  BYTES_PER_SECOND, MAX_DURATION_SECONDS, MAX_PENDING_BYTES,
  validAudioFrame, validStart, validStop,
} from "./streaming-stt-protocol.mjs";

const execFileAsync = promisify(execFile);
const BUILD_SCRIPT = fileURLToPath(new URL("../scripts/build-macos-stt-helper.sh", import.meta.url));
const HELPER = fileURLToPath(new URL("../.native-build/BittyMacStt.app/Contents/MacOS/BittyMacStt", import.meta.url));
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * MAX_DURATION_SECONDS;
const VAD_THRESHOLD = 0.005;
const VAD_START_MS = 120;
const VAD_END_MS = 1_250;
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

const NATIVE_ERROR_DOMAINS = new Set([
  "kAFAssistantErrorDomain", "kLSRErrorDomain", "SFSpeechErrorDomain",
  "NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSOSStatusErrorDomain",
  "NSURLErrorDomain", "AVFoundationErrorDomain",
]);

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
  log = console,
  finalizationTimeoutMs = 15_000,
  startupTimeoutMs = 120_000,
  noSpeechTimeoutMs = 55_000,
} = {}) {
  return (ws, { continuation = false } = {}) => {
    let phase = "awaiting_start";
    let child;
    let helperGeneration = 0;
    let readySent = false;
    let turnHasSpeech = false;
    let lastRecognizedText = "";
    let revision = 0;
    let candidate = null;
    let pendingCommit = null;
    let commitTimer;
    let restartRequested = false;
    let stopRequested = false;
    let handoff = [];
    let handoffBytes = 0;
    let terminal = false;
    let inputEnded = false;
    let endReason = "";
    let sentBytes = 0;
    let pendingBytes = 0;
    let speechBegan = false;
    let finalHadText = false;
    let finalChars = 0;
    let lastPartialText = "";
    let inputEndedAt = null;
    let loudMs = 0;
    let silentMs = 0;
    let lastRms = null;
    let maxSilentRms = 0;
    const streamId = randomUUID();
    const startedAt = performance.now();
    let readyAt = null;
    let firstAudioAt = null;
    let lastAudioAt = null;
    let maxRms = 0;
    const diagnose = (event, details = {}) => {
      const now = performance.now();
      log.info?.(`[stream-stt] ${event}`, {
        streamId, helperPid: child?.pid ?? null, phase,
        elapsedMs: Math.round(now - startedAt),
        audioMs: Math.round(sentBytes / BYTES_PER_SECOND * 1000),
        pendingAudioMs: Math.round(pendingBytes / BYTES_PER_SECOND * 1000),
        firstAudioAfterReadyMs: firstAudioAt === null || readyAt === null ? null : Math.round(firstAudioAt - readyAt),
        lastAudioAgoMs: lastAudioAt === null ? null : Math.round(now - lastAudioAt),
        inputEnded, endReason, speechBegan, finalHadText, finalChars,
        lastPartialChars: lastPartialText.length,
        finalizationMs: inputEndedAt === null ? null : Math.round(now - inputEndedAt),
        maxRms: Number(maxRms.toFixed(4)),
        ...details,
      });
    };
    let output = "";
    let work = Promise.resolve();
    let startupTimer;
    let noSpeechTimer;
    let maxDurationTimer;
    let finalizationTimer;
    const inactivityExpired = () => {
      send({ type: "speech_activity_end" });
      endInput("speech_end_timeout", "transcript_inactivity");
    };
    let transcriptInactivity = createTranscriptInactivityTimer(inactivityExpired);

    const clearTimers = () => {
      transcriptInactivity.stop();
      clearTimeout(startupTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
      clearTimeout(commitTimer);
    };
    const send = (message) => {
      if (!terminal && ws.readyState === 1) ws.send(JSON.stringify(message));
    };
    const closeChild = () => {
      const previous = child;
      child = undefined;
      helperGeneration += 1;
      previous?.stdin.destroy();
      previous?.kill();
    };
    const finishError = (code, message, retryable = false, nativeDetails = {}) => {
      if (terminal) return;
      diagnose("macos_failed", { code, retryable, ...nativeDetails });
      send({ type: "error", code, message, retryable });
      terminal = true;
      clearTimers();
      if (ws.readyState === 1) ws.close(1000);
      closeChild();
    };
    const finishDone = () => {
      if (terminal) return;
      if (!finalHadText && lastPartialText) {
        finalHadText = true;
        finalChars = lastPartialText.length;
        diagnose("macos_partial_fallback", { chars: finalChars });
        send({ type: "transcript", text: lastPartialText, isFinal: true, stability: 1 });
      }
      turnHasSpeech ||= finalHadText;
      if (continuation && ["speech_end_timeout", "recognition_segment_end", "no_speech_timeout"].includes(endReason)
        && turnHasSpeech) {
        inputEnded = true;
        transcriptInactivity.stop();
        clearTimeout(finalizationTimer);
        clearTimeout(noSpeechTimer);
        closeChild();
        if (restartRequested) {
          void startSegment();
        } else {
          phase = "candidate";
          candidate = ++revision;
          diagnose("macos_candidate", { revision: candidate });
          send({ type: "candidate", revision: candidate });
        }
        return;
      }
      diagnose("macos_done_attempted", {
        reason: endReason || (speechBegan ? "speech_end_timeout" : "no_speech_timeout"),
        hasSpeech: finalHadText,
        socketOpen: ws.readyState === 1,
      });
      send({ type: "done", reason: endReason || (speechBegan ? "speech_end_timeout" : "no_speech_timeout"), hasSpeech: finalHadText });
      terminal = true;
      clearTimers();
      if (ws.readyState === 1) ws.close(1000);
      closeChild();
    };
    const endInput = (reason, trigger = reason) => {
      if (terminal || inputEnded) return;
      inputEnded = true;
      transcriptInactivity.stop();
      inputEndedAt = performance.now();
      endReason = reason;
      phase = "finalizing";
      diagnose("macos_input_ended", {
        trigger,
        silentMs: Math.round(silentMs),
        lastRms: lastRms === null ? null : Number(lastRms.toFixed(4)),
        maxSilentRms: Number(maxSilentRms.toFixed(4)),
        vadThreshold: VAD_THRESHOLD,
        vadEndMs: VAD_END_MS,
      });
      clearTimeout(noSpeechTimer);
      if (!continuation) clearTimeout(maxDurationTimer);
      child?.stdin.end();
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
      if (message.type === "audio_summary") {
        const details = {};
        for (const key of ["appendedFrames", "appendedBuffers"]) {
          if (Number.isSafeInteger(message[key]) && message[key] >= 0) details[key] = message[key];
        }
        if (["starting", "running", "finishing", "canceling", "completed", "unknown"].includes(message.taskState)) {
          details.taskState = message.taskState;
        }
        if (["audio_progress", "input_ended", "final", "error"].includes(message.trigger)) details.trigger = message.trigger;
        if (Object.keys(details).length) diagnose("macos_audio_summary", details);
        return;
      }
      if (message.type === "ready" && phase === "starting") {
        clearTimeout(startupTimer);
        phase = "ready";
        readyAt = performance.now();
        diagnose("macos_ready");
        send({ type: readySent ? "segment_start" : "ready" });
        readySent = true;
        if (continuation && turnHasSpeech) transcriptInactivity.update(lastRecognizedText);
        noSpeechTimer = setTimeout(() => endInput("no_speech_timeout"), noSpeechTimeoutMs);
        noSpeechTimer.unref?.();
        maxDurationTimer ??= setTimeout(() => {
          if (continuation && (inputEnded || phase === "starting")) {
            endReason = "max_duration";
            finishDone();
          } else endInput("max_duration");
        }, MAX_DURATION_SECONDS * 1000);
        maxDurationTimer.unref?.();
        if (continuation) {
          work = work.then(async () => {
            await drainHandoff();
            if (stopRequested) endInput("user_stop");
          }).catch(() => finishError("macos_audio_write_failed", "Macの音声認識へ音声を送れませんでした。", true));
        }
        return;
      }
      if (message.type === "transcript" && (phase === "ready" || phase === "finalizing")
        && typeof message.text === "string" && typeof message.isFinal === "boolean") {
        const nativeHadText = !!message.text.trim();
        if (nativeHadText) {
          lastRecognizedText = message.text;
          beginSpeech();
        }
        if (!message.isFinal && nativeHadText) lastPartialText = message.text;
        transcriptInactivity.update(message.text);
        if (message.isFinal) {
          if (nativeHadText) {
            finalHadText = true;
            finalChars += message.text.length;
          }
          diagnose("macos_final_transcript", {
            chars: message.text.length, nativeHadText, cumulativeChars: finalChars,
          });
        }
        if (nativeHadText) {
          send({ type: "transcript", text: message.text, isFinal: message.isFinal, stability: message.isFinal ? 1 : 0 });
        }
        if (message.isFinal && !inputEnded) {
          send({ type: "speech_activity_end" });
          endInput("recognition_segment_end", "apple_final");
        }
        return;
      }
      if (message.type === "error" && typeof message.code === "string") {
        if (!Object.hasOwn(NATIVE_ERRORS, message.code)) {
          finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true);
          return;
        }
        const nativeDetails = {};
        for (const prefix of ["native", "underlying"]) {
          const domain = message[`${prefix}ErrorDomain`];
          const code = message[`${prefix}ErrorCode`];
          if (typeof domain === "string" && Number.isSafeInteger(code)) {
            nativeDetails[`${prefix}ErrorDomain`] = NATIVE_ERROR_DOMAINS.has(domain) ? domain : "unknown";
            nativeDetails[`${prefix}ErrorCode`] = code;
          }
        }
        if (typeof message.recognizerAvailable === "boolean") nativeDetails.recognizerAvailable = message.recognizerAvailable;
        if (message.code === "macos_recognition_failed" && (phase === "ready" || phase === "finalizing")
          && nativeDetails.nativeErrorDomain === "kAFAssistantErrorDomain" && nativeDetails.nativeErrorCode === 1110
          && !finalHadText) {
          diagnose("macos_no_speech_error", nativeDetails);
          if (lastPartialText) endReason ||= "recognition_segment_end";
          else if (continuation && turnHasSpeech) endReason ||= "no_speech_timeout";
          finishDone();
          return;
        }
        finishError(message.code, NATIVE_ERRORS[message.code],
          message.code === "macos_recognition_failed", nativeDetails);
        return;
      }
      finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true);
    };
    const startSegment = async () => {
      inputEnded = false;
      endReason = "";
      speechBegan = false;
      finalHadText = false;
      finalChars = 0;
      lastPartialText = "";
      loudMs = 0;
      silentMs = 0;
      output = "";
      restartRequested = false;
      transcriptInactivity = createTranscriptInactivityTimer(inactivityExpired);
      const generation = ++helperGeneration;
      phase = "starting";
      diagnose("macos_starting");
      startupTimer = setTimeout(() => finishError("macos_start_timeout", "Macの音声認識を開始できませんでした。", true), startupTimeoutMs);
      startupTimer.unref?.();
      try {
        const helper = await startHelper();
        if (terminal || generation !== helperGeneration) { helper.stdin.destroy(); helper.kill(); return; }
        child = helper;
        helper.stdout.on("data", (chunk) => {
          if (terminal || generation !== helperGeneration) return;
          output += chunk.toString("utf8");
          if (output.length > 1024 * 1024) {
            finishError("macos_helper_protocol", "Macの音声認識から大きすぎる応答を受信しました。", true);
            return;
          }
          let newline;
          while (generation === helperGeneration && (newline = output.indexOf("\n")) !== -1 && !terminal) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            try { onHelperMessage(JSON.parse(line)); }
            catch { finishError("macos_helper_protocol", "Macの音声認識から不正な応答を受信しました。", true); }
          }
        });
        helper.once("error", () => {
          if (generation === helperGeneration) finishError("macos_helper_failed", "Macの音声認識を起動できませんでした。", true);
        });
        helper.once("close", (code) => {
          if (terminal || generation !== helperGeneration) return;
          if (code === 0 && phase === "finalizing") finishDone();
          else finishError("macos_helper_failed", "Macの音声認識が予期せず終了しました。", true);
        });
      } catch (error) {
        if (terminal || generation !== helperGeneration) return;
        finishError("macos_helper_unavailable", error?.message === "unsupported_platform"
          ? "macOS標準の音声認識にはMac上のPrivate Runnerが必要です。"
          : "Runner Macで音声認識の準備に失敗しました。Xcodeを確認してください。", false);
      }
    };
    const drainHandoff = async () => {
      const buffered = handoff;
      handoff = [];
      handoffBytes = 0;
      for (const audio of buffered) await processQueuedAudio(audio, false);
    };
    const processAudio = async (buffer, countBytes = true) => {
      if (terminal || inputEnded) return;
      const audio = countBytes ? buffer.subarray(0, MAX_AUDIO_BYTES - sentBytes) : buffer;
      if (!audio.length) {
        endInput("max_duration");
        return;
      }
      await new Promise((resolve, reject) => child.stdin.write(audio, (error) => error ? reject(error) : resolve()));
      if (countBytes) sentBytes += audio.length;
      const now = performance.now();
      firstAudioAt ??= now;
      lastAudioAt = now;
      if (terminal || inputEnded) return;
      const durationMs = audio.length / BYTES_PER_SECOND * 1000;
      lastRms = audioLevel(audio);
      maxRms = Math.max(maxRms, lastRms);
      if (lastRms >= VAD_THRESHOLD) {
        loudMs += durationMs;
        silentMs = 0;
        maxSilentRms = 0;
        if (loudMs >= VAD_START_MS) beginSpeech();
      } else {
        loudMs = 0;
        if (speechBegan) {
          silentMs += durationMs;
          maxSilentRms = Math.max(maxSilentRms, lastRms);
          if (silentMs >= VAD_END_MS) {
            send({ type: "speech_activity_end" });
            endInput("speech_end_timeout", "pcm_silence");
          }
        }
      }
      if (sentBytes >= MAX_AUDIO_BYTES) endInput("max_duration");
    };

    const commit = () => {
      if (!pendingCommit || terminal) return;
      if (candidate === pendingCommit && loudMs > 0 && loudMs < VAD_START_MS) return;
      const requested = pendingCommit;
      pendingCommit = null;
      clearTimeout(commitTimer);
      const accepted = candidate === requested && !restartRequested && phase === "candidate";
      diagnose("macos_candidate_commit", { revision: requested, accepted });
      send({ type: "committed", revision: requested, accepted });
      if (accepted) {
        terminal = true;
        clearTimers();
        closeChild();
        handoff = [];
        handoffBytes = 0;
        if (ws.readyState === 1) ws.close(1000);
      }
    };
    const processQueuedAudio = async (buffer, countBytes = true) => {
      if (phase === "ready" && handoff.length) await drainHandoff();
      if (terminal) return;
      if (continuation && readySent && (inputEnded || phase === "starting")) {
        if (countBytes) {
          if (sentBytes + buffer.length >= MAX_AUDIO_BYTES) { endReason = "max_duration"; finishDone(); return; }
          sentBytes += buffer.length;
        }
        if (phase === "starting") {
          handoff.push(buffer);
          handoffBytes += buffer.length;
          return;
        }
        const rms = audioLevel(buffer);
        loudMs = rms >= VAD_THRESHOLD ? loudMs + buffer.length / BYTES_PER_SECOND * 1000 : 0;
        if (loudMs > 0 || restartRequested) {
          handoff.push(buffer);
          handoffBytes += buffer.length;
          if (pendingBytes + handoffBytes - buffer.length > MAX_PENDING_BYTES) {
            finishError("backpressure_exceeded", "Speech audio could not be processed quickly enough", true);
            return;
          }
        } else { handoff = []; handoffBytes = 0; }
        if (loudMs >= VAD_START_MS && !restartRequested) {
          restartRequested = true;
          const invalidated = candidate;
          candidate = null;
          if (invalidated !== null) {
            diagnose("macos_candidate_invalidated", { revision: invalidated });
            send({ type: "candidate_invalidated", revision: invalidated });
          }
          if (phase === "candidate") void startSegment();
        }
        commit();
        return;
      }
      if (phase !== "ready") {
        finishError("protocol_order", "Audio is only accepted after ready");
        return;
      }
      await processAudio(buffer, countBytes);
    };
    const enqueueAudio = (buffer, countBytes = true) => {
      pendingBytes += buffer.length;
      if (pendingBytes + handoffBytes > MAX_PENDING_BYTES) {
        finishError("backpressure_exceeded", "Speech audio could not be processed quickly enough", true);
        return;
      }
      work = work.then(() => processQueuedAudio(buffer, countBytes)).catch(() => finishError("macos_audio_write_failed", "Macの音声認識へ音声を送れませんでした。", true))
        .finally(() => { pendingBytes -= buffer.length; });
    };
    ws.on("message", (raw, isBinary) => {
      if (terminal || (inputEnded && !continuation)) return;
      if (isBinary) {
        const buffer = Buffer.from(raw);
        if (!validAudioFrame(buffer)) {
          finishError("invalid_audio_frame", "PCM audio frames must be even-sized and no larger than 65536 bytes");
          return;
        }
        enqueueAudio(buffer);
        return;
      }
      let payload;
      try { payload = JSON.parse(String(raw || "")); }
      catch { finishError("invalid_json", "Control messages must be valid JSON"); return; }
      if (phase === "awaiting_start") {
        if (!validStart(payload)) { finishError("invalid_start", "Expected start with sampleRate 16000"); return; }
        void startSegment();
        return;
      }
      if (continuation && payload?.type === "commit" && Object.keys(payload).length === 2
        && Number.isSafeInteger(payload.revision) && payload.revision > 0) {
        work = work.then(() => {
          if (terminal) return;
          if (pendingCommit) { finishError("protocol_order", "A commit is already pending"); return; }
          pendingCommit = payload.revision;
          commitTimer = setTimeout(() => finishError("macos_commit_timeout", "音声入力の確定に失敗しました。", true), finalizationTimeoutMs);
          commitTimer.unref?.();
          commit();
        });
        return;
      }
      if (validStop(payload) && (phase === "ready" || continuation)) {
        work = work.then(() => {
          if (terminal) return;
          stopRequested = true;
          if (phase === "starting") return;
          if (inputEnded) { endReason = "user_stop"; finishDone(); }
          else endInput("user_stop");
        });
        return;
      }
      finishError("protocol_order", "Unexpected speech stream control message");
    });
    ws.on("close", () => {
      if (terminal) return;
      diagnose("macos_closed_before_done");
      terminal = true;
      clearTimers();
      closeChild();
    });
  };
}
