import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { v2 as speech } from "@google-cloud/speech";
import {
  SAMPLE_RATE, BYTES_PER_SECOND, MAX_FRAME_BYTES, MAX_PENDING_BYTES, MAX_DURATION_SECONDS,
  validStart, validStop, validAudioFrame,
} from "./streaming-stt-protocol.mjs";

const GOOGLE_CHUNK_BYTES = 15_360;
const MAX_AUDIO_BYTES = BYTES_PER_SECOND * MAX_DURATION_SECONDS;
export const STREAM_STT_MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES;

export function normalizeStreamingResults(results) {
  let finalAppend = "";
  let interimReplacement = "";
  let interimStability = 0;
  for (const result of Array.isArray(results) ? results : []) {
    const text = String(result?.alternatives?.[0]?.transcript || "");
    if (result?.isFinal) {
      finalAppend += text;
    } else {
      interimReplacement += text;
      interimStability = Number.isFinite(Number(result?.stability)) ? Number(result.stability) : interimStability;
    }
  }
  return { finalAppend, interimReplacement, interimStability };
}

function publicUsage(snapshot) {
  return {
    usedSeconds: snapshot.usedSeconds,
    limitSeconds: snapshot.limitSeconds,
    remainingSeconds: snapshot.remainingSeconds,
    monthUtc: snapshot.monthUtc,
    resetAt: snapshot.resetAt,
  };
}

function usageMessage(snapshot) {
  return { type: "usage", ...publicUsage(snapshot) };
}

function safeGoogleError(error, settings) {
  const code = Number(error?.code);
  const providerError = error?.response?.data?.error;
  const details = [
    error,
    error?.errorInfo,
    providerError,
    ...(Array.isArray(error?.statusDetails) ? error.statusDetails : []),
    ...(Array.isArray(providerError?.details) ? providerError.details : []),
  ];
  const reason = String(details.map((detail) => detail?.reason || detail?.errorInfo?.reason).find(Boolean) || "").toUpperCase();
  if (["SERVICE_DISABLED", "API_DISABLED", "ACCESS_NOT_CONFIGURED"].includes(reason)) {
    return { code: "speech_api_disabled", message: "Google Cloud Speech-to-Text API is not enabled", retryable: false };
  }
  if (["BILLING_DISABLED", "BILLING_NOT_ACTIVE", "PROJECT_BILLING_DISABLED"].includes(reason)) {
    return { code: "billing_disabled", message: "Google Cloud billing is not enabled", retryable: false };
  }
  if (code === 16 || Number(error?.response?.status) === 401
    || /invalid_grant|invalid_rapt|reauth|revoked/i.test(String(error?.message || ""))) {
    return { code: "credentials_revoked", message: "Google Cloud authentication has expired", retryable: false };
  }
  if (code === 7) {
    return { code: "permission_denied", message: "Google Cloud Speech permissions are missing", retryable: false };
  }
  if (code === 8) {
    return { code: "google_quota_exceeded", message: "Google Cloud Speech quota was exceeded", retryable: true };
  }
  if (code === 4 || code === 14) {
    return { code: "google_unavailable", message: "Google Cloud Speech is temporarily unavailable", retryable: true };
  }
  if (code === 3 || code === 5 || code === 9) {
    const selection = settings?.sttModel && settings?.sttRegion
      ? ` (${settings.sttModel} / ${settings.sttRegion})`
      : "";
    return {
      code: "google_stream_invalid",
      message: `Google Cloud Speech rejected the selected model or region${selection}`,
      retryable: false,
    };
  }
  return { code: "google_stream_failed", message: "Google Cloud Speech streaming failed", retryable: true };
}

function safeFailureDetail(error, source) {
  return {
    source,
    grpcCode: Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code : null,
    nodeCode: error?.code === "ERR_STREAM_WRITE_AFTER_END" ? error.code : null,
  };
}

async function writeGrpc(stream, request) {
  if (!stream.write(request)) await once(stream, "drain");
}

export function createGoogleStreamingSttHandler({
  googleCloudService,
  usageLedger,
  speechClientFactory = (options) => new speech.SpeechClient(options),
  now = () => new Date(),
  log = console,
  finalizationTimeoutMs = 15_000,
}) {
  return (ws) => {
    let phase = "awaiting_start";
    let googleStream = null;
    let speechClient = null;
    let settings = null;
    let usage = null;
    let sentBytes = 0;
    let reservedSeconds = 0;
    let pendingBytes = 0;
    let speechBegan = false;
    let finalHadText = false;
    let endReason = "";
    let terminal = false;
    let inputEnded = false;
    let googleStreamEnded = false;
    let failureDetail = null;
    let localEndRequest = null;
    let stopRequestedMs = null;
    let googleEndObservedMs = null;
    let errorState = null;
    let work = Promise.resolve();
    let maxDurationTimer = null;
    let finalizationTimer = null;
    let sessionLogged = false;
    const startedAt = now().toISOString();
    const sessionStartMs = performance.now();
    const elapsedMs = () => Math.round(performance.now() - sessionStartMs);
    const timing = {
      firstAudioReceivedMs: null,
      firstGrpcAudioWriteMs: null,
      lastGrpcAudioWriteMs: null,
      firstSpeechBeginMs: null,
      firstSpeechEndMs: null,
      lastSpeechEndMs: null,
      firstInterimMs: null,
      firstFinalMs: null,
      lastFinalMs: null,
      interimCount: 0,
      finalCount: 0,
      maxReserveWaitMs: 0,
    };

    const send = (message) => {
      if (terminal || ws.readyState !== 1) return;
      ws.send(JSON.stringify(message));
    };

    const closeGoogle = async () => {
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
      googleStream?.destroy();
      await speechClient?.close?.().catch(() => {});
    };

    const logSessionFinished = (outcome, reason) => {
      if (sessionLogged) return;
      sessionLogged = true;
      log.info?.("[stream-stt] session_finished", {
        startedAt,
        finishedAt: now().toISOString(),
        projectId: settings?.projectId || "",
        region: settings?.sttRegion || null,
        model: settings?.sttModel || null,
        outcome,
        reason,
        failureDetail,
        localEndRequest,
        stopRequestedMs,
        googleEndObservedMs,
        errorState,
        addedSeconds: reservedSeconds,
        reservedSeconds,
        usedSeconds: Number.isSafeInteger(usage?.usedSeconds) ? usage.usedSeconds : null,
        timing: { ...timing },
      });
    };

    const finishError = (code, message, retryable, detail = failureDetail) => {
      if (terminal) return;
      failureDetail = detail;
      errorState = { phase, inputEnded, pendingBytes };
      terminal = true;
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
      logSessionFinished("error", code);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "error", code, message, retryable }));
        ws.close(1000);
      }
      void closeGoogle();
    };

    const finishDone = async () => {
      if (terminal) return;
      try {
        usage = await usageLedger.get(settings.projectId);
      } catch {
        finishError("usage_store_failed", "Speech usage could not be saved", true);
        return;
      }
      if (terminal) {
        await closeGoogle();
        return;
      }
      const reason = endReason || (speechBegan ? "speech_end_timeout" : "no_speech_timeout");
      terminal = true;
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
      const finalUsage = publicUsage(usage);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "usage", ...finalUsage }));
        ws.send(JSON.stringify({ type: "done", reason, hasSpeech: finalHadText, usage: finalUsage }));
        ws.close(1000);
      }
      logSessionFinished("done", reason);
      await closeGoogle();
    };

    const endInput = (reason = "", closeGoogleInput = true) => {
      if (inputEnded || terminal) return;
      localEndRequest = { reason: reason || "closed_write_race", atMs: elapsedMs(), closeGoogleInput };
      inputEnded = true;
      phase = "finalizing";
      endReason = reason || endReason;
      clearTimeout(maxDurationTimer);
      finalizationTimer = setTimeout(() => {
        finishError("finalization_timeout", "Google Cloud Speech did not finish the session", true);
      }, finalizationTimeoutMs);
      finalizationTimer.unref?.();
      if (closeGoogleInput) googleStream.end();
    };

    const recoverClosedWrite = (error, source) => {
      if (error?.code !== "ERR_STREAM_WRITE_AFTER_END" || !finalHadText || timing.firstSpeechEndMs === null) return false;
      failureDetail = safeFailureDetail(error, source);
      endInput("", false);
      return true;
    };

    const onGoogleData = (response) => {
      if (terminal) return;
      if (response?.speechEventType === 2 || response?.speechEventType === "SPEECH_ACTIVITY_BEGIN") {
        speechBegan = true;
        timing.firstSpeechBeginMs ??= elapsedMs();
        send({ type: "speech_activity_begin" });
      } else if (response?.speechEventType === 3 || response?.speechEventType === "SPEECH_ACTIVITY_END") {
        const atMs = elapsedMs();
        timing.firstSpeechEndMs ??= atMs;
        timing.lastSpeechEndMs = atMs;
        send({ type: "speech_activity_end" });
      }
      const normalized = normalizeStreamingResults(response?.results);
      if (normalized.finalAppend) {
        const atMs = elapsedMs();
        timing.firstFinalMs ??= atMs;
        timing.lastFinalMs = atMs;
        timing.finalCount += 1;
        if (normalized.finalAppend.trim()) finalHadText = true;
        send({ type: "transcript", text: normalized.finalAppend, isFinal: true, stability: 1 });
      }
      if (normalized.interimReplacement) {
        timing.firstInterimMs ??= elapsedMs();
        timing.interimCount += 1;
        send({
          type: "transcript",
          text: normalized.interimReplacement,
          isFinal: false,
          stability: normalized.interimStability,
        });
      }
    };

    const start = async (payload) => {
      if (!validStart(payload)) {
        finishError("invalid_start", "Expected start with sampleRate 16000", false);
        return;
      }
      phase = "starting";
      try {
        const credentials = await googleCloudService.credentials();
        if (terminal) return;
        settings = {
          projectId: credentials.projectId,
          sttRegion: credentials.sttRegion,
          sttModel: credentials.sttModel,
        };
        await googleCloudService.accessToken(credentials);
        if (terminal) return;
        usage = await usageLedger.get(settings.projectId);
        if (terminal) return;
        if (usage.remainingSeconds <= 0) {
          finishError("usage_limit_reached", "The monthly speech usage limit has been reached", false);
          return;
        }
        speechClient = speechClientFactory({
          apiEndpoint: `${settings.sttRegion}-speech.googleapis.com`,
          projectId: credentials.projectId,
          quotaProjectId: credentials.projectId,
          keyFilename: credentials.keyFilename,
        });
        if (terminal) {
          await closeGoogle();
          return;
        }
        googleStream = speechClient._streamingRecognize();
        googleStream.on("data", onGoogleData);
        googleStream.on("error", (error) => {
          if (terminal) return;
          if (googleStreamEnded && error?.code === "ERR_STREAM_WRITE_AFTER_END") return;
          if (recoverClosedWrite(error, "google_stream")) return;
          const safe = safeGoogleError(error, settings);
          finishError(safe.code, safe.message, safe.retryable, safeFailureDetail(error, "google_stream"));
        });
        googleStream.once("end", () => {
          googleStreamEnded = true;
          googleEndObservedMs = elapsedMs();
          inputEnded = true;
          phase = "finalizing";
          void finishDone();
        });
        await writeGrpc(googleStream, {
          recognizer: `projects/${credentials.projectId}/locations/${settings.sttRegion}/recognizers/_`,
          streamingConfig: {
            config: {
              explicitDecodingConfig: {
                encoding: "LINEAR16",
                sampleRateHertz: SAMPLE_RATE,
                audioChannelCount: 1,
              },
              languageCodes: ["ja-JP"],
              model: settings.sttModel,
              features: { enableAutomaticPunctuation: true },
            },
            streamingFeatures: {
              interimResults: true,
              enableVoiceActivityEvents: true,
              voiceActivityTimeout: {
                speechStartTimeout: { seconds: 55 },
                speechEndTimeout: { nanos: 850_000_000 },
              },
            },
          },
        });
        if (googleStreamEnded) return;
        if (terminal) {
          await closeGoogle();
          return;
        }
        phase = "ready";
        send({ type: "ready" });
        send(usageMessage(usage));
        maxDurationTimer = setTimeout(() => endInput("max_duration"), MAX_DURATION_SECONDS * 1000);
        maxDurationTimer.unref?.();
      } catch (error) {
        if (terminal) {
          await closeGoogle();
          return;
        }
        const safe = safeGoogleError(error, settings);
        const code = /not connected|not configured|permissions/i.test(String(error?.message || ""))
          ? "google_not_connected"
          : safe.code;
        finishError(code, code === "google_not_connected" ? "Google Cloud is not connected" : safe.message, false,
          safeFailureDetail(error, "start"));
      }
    };

    const processAudio = async (buffer) => {
      let offset = 0;
      while (offset < buffer.length && !terminal && !inputEnded) {
        if (sentBytes >= MAX_AUDIO_BYTES) {
          endInput("max_duration");
          return;
        }
        if (sentBytes >= reservedSeconds * BYTES_PER_SECOND) {
          const reserveStartedMs = performance.now();
          let reservation;
          try {
            reservation = await usageLedger.reserve(settings.projectId, 1);
          } catch (error) {
            finishError("usage_store_failed", "Speech usage could not be saved", true,
              safeFailureDetail(error, "usage_store"));
            return;
          }
          const reserveWaitMs = Math.round(performance.now() - reserveStartedMs);
          timing.maxReserveWaitMs = Math.max(timing.maxReserveWaitMs, reserveWaitMs);
          usage = reservation;
          if (!reservation.reserved) {
            endInput("limit_reached");
            return;
          }
          reservedSeconds += 1;
          send(usageMessage(usage));
        }
        if (terminal || inputEnded || googleStreamEnded) return;
        const reservedBytesRemaining = reservedSeconds * BYTES_PER_SECOND - sentBytes;
        const durationBytesRemaining = MAX_AUDIO_BYTES - sentBytes;
        const size = Math.min(GOOGLE_CHUNK_BYTES, buffer.length - offset, reservedBytesRemaining, durationBytesRemaining);
        const atMs = elapsedMs();
        timing.firstGrpcAudioWriteMs ??= atMs;
        timing.lastGrpcAudioWriteMs = atMs;
        await writeGrpc(googleStream, { audio: buffer.subarray(offset, offset + size) });
        sentBytes += size;
        offset += size;
      }
      if (sentBytes >= MAX_AUDIO_BYTES) endInput("max_duration");
    };

    ws.on("message", (raw, isBinary) => {
      if (terminal || inputEnded || googleStreamEnded) return;
      if (isBinary) {
        if (phase !== "ready") {
          finishError("protocol_order", "Audio is only accepted after ready", false);
          return;
        }
        const buffer = Buffer.from(raw);
        if (!validAudioFrame(buffer)) {
          finishError("invalid_audio_frame", "PCM audio frames must be even-sized and no larger than 65536 bytes", false);
          return;
        }
        timing.firstAudioReceivedMs ??= elapsedMs();
        pendingBytes += buffer.length;
        if (pendingBytes > MAX_PENDING_BYTES) {
          finishError("backpressure_exceeded", "Speech audio could not be processed quickly enough", true);
          return;
        }
        work = work.then(() => processAudio(buffer))
          .catch((error) => {
            if (terminal || googleStreamEnded || recoverClosedWrite(error, "audio_write")) return;
            const safe = safeGoogleError(error, settings);
            finishError(safe.code, safe.message, safe.retryable, safeFailureDetail(error, "audio_write"));
          })
          .finally(() => { pendingBytes -= buffer.length; });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(String(raw || ""));
      } catch {
        finishError("invalid_json", "Control messages must be valid JSON", false);
        return;
      }
      if (phase === "awaiting_start") {
        void start(payload);
        return;
      }
      if (phase === "ready" && validStop(payload)) {
        stopRequestedMs ??= elapsedMs();
        work = work.then(() => endInput("user_stop"));
        return;
      }
      finishError("protocol_order", "Unexpected speech stream control message", false);
    });

    ws.on("close", () => {
      if (terminal) return;
      terminal = true;
      clearTimeout(maxDurationTimer);
      clearTimeout(finalizationTimer);
      googleStream?.destroy();
      void speechClient?.close?.().catch(() => {});
      logSessionFinished("disconnected", "client_disconnect");
    });
  };
}

export const __TESTING__ = {
  SAMPLE_RATE,
  GOOGLE_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  MAX_PENDING_BYTES,
  MAX_DURATION_SECONDS,
  publicUsage,
  usageMessage,
};
