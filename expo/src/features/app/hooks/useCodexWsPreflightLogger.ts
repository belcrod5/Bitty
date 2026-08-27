import type { MutableRefObject } from "react";
import { Platform } from "react-native";
import type { AppScreen, AutoClientLogEntry } from "../types/appTypes";
import {
  deriveRunnerBaseUrlFromCodexWsUrl,
  diagErrorMessage,
  postJsonWithTimeout,
} from "../utils/codexDiagnostics";

type UploadCodexWsPreflightLogOptions = {
  phase: string;
  targetWsUrl: string;
  targetWsToken: string;
  extra?: Record<string, unknown>;
};

type UseCodexWsPreflightLoggerOptions = {
  nearUnlimitedTimeoutMs: number;
  executionEnvironment: string;
  isExpoGo: boolean;
  runnerToken: string;
  activeScreen: AppScreen;
  autoRecordingState: string;
  autoLastEvent: string;
  ttsLoading: boolean;
  autoClientSessionIdRef: MutableRefObject<string>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  baseUrl: () => string;
};

export function useCodexWsPreflightLogger({
  nearUnlimitedTimeoutMs,
  executionEnvironment,
  isExpoGo,
  runnerToken,
  activeScreen,
  autoRecordingState,
  autoLastEvent,
  ttsLoading,
  autoClientSessionIdRef,
  autoRecordingEnabledRef,
  ttsPlayingRef,
  replyLoadingRef,
  baseUrl,
}: UseCodexWsPreflightLoggerOptions) {
  async function uploadCodexWsPreflightLog(options: UploadCodexWsPreflightLogOptions) {
    const runnerBase = baseUrl();
    const runnerAuth = runnerToken.trim();
    const fallbackRunnerBase = deriveRunnerBaseUrlFromCodexWsUrl(options.targetWsUrl);
    const uploadCandidates = Array.from(new Set(
      [runnerBase, fallbackRunnerBase]
        .map((raw) => String(raw || "").trim().replace(/\/$/, ""))
        .filter(Boolean)
    ));
    if (!runnerAuth || uploadCandidates.length === 0) {
      return "skipped:no_runner_auth_or_base";
    }

    const sessionId = `${autoClientSessionIdRef.current}:codex-preflight:${Date.now()}`;
    const event: AutoClientLogEntry = {
      sessionId,
      seq: 1,
      at: new Date().toISOString(),
      event: "codex_ws_preflight",
      payload: {
        phase: options.phase,
        wsUrl: options.targetWsUrl,
        tokenEnabled: Boolean(options.targetWsToken),
        executionEnvironment,
        expoGo: isExpoGo,
        activeScreen,
        ...(options.extra || {}),
      },
      screen: activeScreen,
      autoEnabled: autoRecordingEnabledRef.current,
      autoState: autoRecordingState,
      autoEvent: autoLastEvent,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
    };

    let lastError = "";
    for (const candidate of uploadCandidates) {
      try {
        const { response, data } = await postJsonWithTimeout(
          `${candidate}/client-logs`,
          {
            source: "codex_ws_preflight",
            sessionId,
            device: `${Platform.OS}:${String(Platform.Version)}`,
            events: [event],
          },
          {
            "content-type": "application/json",
            authorization: `Bearer ${runnerAuth}`,
          },
          nearUnlimitedTimeoutMs
        );
        if (!response.ok) {
          throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
        }
        return `uploaded:1@${candidate}`;
      } catch (error) {
        lastError = diagErrorMessage(error);
      }
    }
    return `upload_error:${lastError || "unknown_error"}`;
  }

  return { uploadCodexWsPreflightLog };
}
