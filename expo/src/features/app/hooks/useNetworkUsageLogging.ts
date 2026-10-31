import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import {
  completeNetworkUsageIdleObservation,
  getNetworkUsageIdleObservationDeadline,
  getNetworkUsageSnapshot,
  subscribeNetworkUsageIdleObservations,
  updateNetworkUsageObservationAppState,
} from "../../ws/networkUsageMetrics";
import { getPendingHttpNetworkMeasurements } from "../utils/cloudflareAccessFetch";

const MEASUREMENTS = {
  ttsMediaMeasurement: "server_reported_estimate",
  runnerWsMeasurement: "decoded_payload_bytes",
  httpMeasurement: "content_length_or_decoded_body_bytes",
};

export function useNetworkUsageLogging(
  log: (event: string, payload: Record<string, unknown>, options: { throttleMs: number }) => void,
  manager: RunnerWebSocketManager,
) {
  const live = useRef({ log, manager });
  live.current = { log, manager };
  useEffect(() => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let lastLogged: ReturnType<typeof getNetworkUsageSnapshot> | null = null;
    const unsubscribe = subscribeNetworkUsageIdleObservations((observation, atBoundary) => {
      live.current.log("network_usage_idle_observation", {
        ...observation,
        ...MEASUREMENTS,
        responseAttribution: "recording_time_not_request_origin",
        pendingHttpMeasurementsAtEnd: atBoundary ? getPendingHttpNetworkMeasurements() : null,
        pendingRunnerWsRequestsAtEnd: atBoundary ? live.current.manager.getSnapshot().pendingRequestCount : null,
        inputCoverage: "root_responder_keyboard_text_change_voice_link_notification_app_control",
        unobservedNativeInputPossible: true,
      }, { throttleMs: 0 });
    });
    const scheduleDeadline = () => {
      clearTimeout(deadlineTimer);
      const deadline = getNetworkUsageIdleObservationDeadline();
      if (deadline !== null) deadlineTimer = setTimeout(completeNetworkUsageIdleObservation, Math.max(0, deadline - Date.now()));
    };
    const logUsage = () => {
      const snapshot = getNetworkUsageSnapshot();
      // Diagnostic uploads must not generate a new diagnostic upload each minute.
      const withoutLogs = (value: typeof snapshot) => value.totalSentBytes + value.totalReceivedBytes
        - value.httpByCategory["client-logs"].sentBytes - value.httpByCategory["client-logs"].receivedBytes;
      if (withoutLogs(snapshot) === 0 || (lastLogged?.sinceMs === snapshot.sinceMs && withoutLogs(lastLogged) === withoutLogs(snapshot))) return;
      lastLogged = snapshot;
      live.current.log("network_usage_snapshot", { ...snapshot, sampledAtMs: Date.now(), ...MEASUREMENTS }, { throttleMs: 0 });
    };
    updateNetworkUsageObservationAppState(AppState.currentState);
    scheduleDeadline();
    const timer = setInterval(logUsage, 60_000);
    const state = AppState.addEventListener("change", (next) => {
      updateNetworkUsageObservationAppState(next);
      scheduleDeadline();
      if (next !== "active") logUsage();
    });
    return () => {
      // Lifecycle changes while this observer is absent cannot be verified.
      updateNetworkUsageObservationAppState(null);
      clearTimeout(deadlineTimer);
      clearInterval(timer);
      state.remove();
      unsubscribe();
    };
  }, []);
}
