import { useCallback } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";
import { getCloudflareAccessHeadersForUrl } from "../app/utils/cloudflareAccessFetch";
import { streamSttUrl } from "./streamingSttClient";
import type { StreamingSttSession, StreamingSttTransportCallbacks } from "./streamingSttTransport";

type Subscription = { remove(): void };
type NativeStreamingStt = {
  captureDiagnosticsVersion?: number;
  controlVersion?: number;
  hasPermission?: () => Promise<boolean>;
  setInputMuted?: (muted: boolean) => Promise<void>;
  continuationVersion?: number;
  commit?: (revision: number) => Promise<boolean>;
  start(url: string, headers: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  addListener(name: string, listener: (event: any) => void): Subscription;
};

const CAPTURE_STAGES = new Set([
  "session_started", "socket_opened", "ready_received", "permission_requested", "permission_result",
  "audio_session_configuring", "audio_session_active", "engine_starting", "engine_started",
  "first_tap", "first_pcm", "first_audio_queued", "first_audio_send_started", "first_audio_sent",
  "stop_requested", "runner_done", "runner_error", "socket_closed", "aborted", "failed",
]);
const CAPTURE_COUNTS = [
  "capturedBuffers", "capturedFrames", "convertedFrames", "queuedAudioBytes", "startedAudioBytes",
  "sentAudioBytes", "pendingAudioBytes", "partialAudioBytes", "inputSampleRate", "inputChannels",
];

export function useStreamingSttTransport() {
  const connect = useCallback((runnerUrl: string, runnerToken: string, callbacks: StreamingSttTransportCallbacks): StreamingSttSession => {
    const token = runnerToken.trim();
    if (!token) throw new Error("runner_token_required");
    const native = requireOptionalNativeModule<NativeStreamingStt>("BittyStreamingStt");
    if (!native) throw new Error("native_stt_unavailable");
    const continuation = callbacks.continueDuringCorrection === true
      && native.continuationVersion === 1 && typeof native.commit === "function";
    const url = streamSttUrl(runnerUrl, continuation);
    const headers = {
      ...getCloudflareAccessHeadersForUrl(url),
      Authorization: `Bearer ${token}`,
    };
    let active = true;
    const subscriptions = [
      native.addListener("BittyStreamingSttMessage", ({ data }: { data: string }) => {
        if (active) callbacks.onMessage(data);
      }),
      native.addListener("BittyStreamingSttSample", ({ rms }: { rms: number }) => {
        if (active && typeof rms === "number" && Number.isFinite(rms)) callbacks.onSample(rms);
      }),
      native.addListener("BittyStreamingSttError", ({ message }: { message: string }) => {
        if (active) callbacks.onError(message);
      }),
      native.addListener("BittyStreamingSttClose", () => {
        if (active) callbacks.onClose();
      }),
    ];
    // Old native builds do not declare this event; leave their listener contract unchanged.
    if (native.captureDiagnosticsVersion === 1 && callbacks.onDiagnostic) {
      let sessionId: string | undefined;
      const stages = new Set<string>();
      try {
        subscriptions.push(native.addListener("BittyStreamingSttDiagnostic", (event: unknown) => {
          if (!active || !event || typeof event !== "object") return;
          const value = event as Record<string, unknown>;
          if (typeof value.sessionId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.sessionId)
            || typeof value.stage !== "string" || !CAPTURE_STAGES.has(value.stage)
            || !Number.isSafeInteger(value.elapsedMs) || (value.elapsedMs as number) < 0) return;
          if (!sessionId && value.stage === "session_started") sessionId = value.sessionId;
          if (sessionId !== value.sessionId || stages.has(value.stage)) return;
          const payload: Record<string, unknown> = { sessionId, stage: value.stage, elapsedMs: value.elapsedMs };
          for (const key of CAPTURE_COUNTS) {
            if (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) payload[key] = value[key];
          }
          for (const key of ["ready", "stopping", "engineRunning", "permissionGranted"]) {
            if (typeof value[key] === "boolean") payload[key] = value[key];
          }
          stages.add(value.stage);
          try { callbacks.onDiagnostic?.(payload); } catch { /* Diagnostics must not interrupt recording. */ }
        }));
      } catch {
        // Optional diagnostics must never prevent recording on an older native build.
      }
    }
    const abort = async () => {
      if (!active) return;
      active = false;
      subscriptions.forEach((subscription) => subscription.remove());
      await native.abort();
    };
    try {
      void native.start(url, headers).catch((error: unknown) => {
        if (active) callbacks.onError(error instanceof Error ? error.message : "native_stt_start_failed");
      });
    } catch (error) {
      void abort();
      throw error;
    }
    return {
      ...(continuation ? { commit: (revision: number) => active ? native.commit!(revision) : Promise.reject(new Error("native_stt_inactive")) } : {}),
      setInputMuted: (muted: boolean) => active && native.setInputMuted ? native.setInputMuted(muted) : Promise.reject(new Error("native_stt_mute_unsupported")),
      stop: () => active ? native.stop() : Promise.resolve(),
      abort,
    };
  }, []);

  const native = requireOptionalNativeModule<NativeStreamingStt>("BittyStreamingStt");
  return { supported: true, controlVersion: native?.controlVersion ?? 0,
    hasPermission: () => native?.hasPermission?.() ?? Promise.resolve(false), connect };
}
