import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import type { StreamTtsControlState } from "../types/appTypes";
import { useAppStateAutoRecoveryController } from "./useAppStateAutoRecoveryController";

function ref<T>(current: T) {
  return { current };
}

test("leaves Runner-managed TTS active on resume when it has no standalone socket", async () => {
  let onAppStateChange: (state: AppStateStatus) => void = () => {};
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_event, listener) => {
    onAppStateChange = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  }) as typeof AppState.addEventListener);
  jest.spyOn(Date, "now").mockReturnValue(10_000);
  const recoverTtsStreamAfterResume = jest.fn();
  const managedStream: StreamTtsControlState = {
    operationId: "stream-1",
    requestId: "request-1",
    cleanup: jest.fn(),
  };
  const options = {
    appStateRef: ref<AppStateStatus>("inactive"),
    appStateChangedAtRef: ref(1_000),
    appStateLastNonActiveAtRef: ref(1_000),
    streamSocketRef: ref<WebSocket | null>(null),
    streamTtsControlRef: ref<StreamTtsControlState | null>(managedStream),
    replyLoadingRef: ref(true),
    logAuto: jest.fn(),
    logSessionDiag: jest.fn(),
    recoverTtsStreamAfterResume,
    flushAutoClientLogs: jest.fn(),
    flushSessionDiagClientLogs: jest.fn(),
    appResumeStreamRecoveryNonActiveMinMs: 2_500,
  };

  try {
    await renderHook(() => useAppStateAutoRecoveryController(options));
    await act(async () => onAppStateChange("active"));

    expect(recoverTtsStreamAfterResume).not.toHaveBeenCalled();
    expect(managedStream.cleanup).not.toHaveBeenCalled();
    expect(options.appStateRef.current).toBe("active");

    options.streamSocketRef.current = { readyState: WebSocket.CLOSED } as WebSocket;
    options.appStateRef.current = "inactive";
    options.appStateLastNonActiveAtRef.current = 9_000;
    await act(async () => onAppStateChange("active"));

    expect(recoverTtsStreamAfterResume).toHaveBeenCalledWith("resume_socket_not_open");
  } finally {
    jest.restoreAllMocks();
  }
});
