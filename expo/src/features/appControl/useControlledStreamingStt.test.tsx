import { useState } from "react";
import { AppState } from "react-native";
import { act, renderHook } from "@testing-library/react-native";
import { useControlledStreamingStt } from "./useControlledStreamingStt";
import { getVoiceControl, type VoiceTarget } from "./voiceControl";
import type { StreamingSttTransportCallbacks } from "../stt/streamingSttTransport";
import type { RunnerWsMessage } from "../runnerWs/types";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";

let mockReceive: (message: RunnerWsMessage) => void;
const mockSent: RunnerWsMessage[] = [];
const mockManager = {
  getSnapshot: () => ({ connected: true, appState: "active", generation: 1, clientInstanceId: "device" }),
  subscribeSnapshot: () => () => {},
  subscribe: (_filter: unknown, receive: typeof mockReceive) => { mockReceive = receive; return () => {}; },
  request: async () => ({ op: "app.control.register.result", payload: { version: 1, connectionGeneration: "connection" } }),
  send: (message: RunnerWsMessage) => { mockSent.push(message); },
};
const mockSessions: Array<{ callbacks: StreamingSttTransportCallbacks; abort: jest.Mock; setInputMuted: jest.Mock }> = [];
jest.mock("../runnerWs/RunnerWebSocketContext", () => ({ useRunnerWebSocketManager: () => mockManager }));
jest.mock("../stt/useStreamingSttTransport", () => ({
  useStreamingSttTransport: () => ({ supported: true, controlVersion: 1, hasPermission: async () => true,
    connect: (_url: string, _token: string, callbacks: StreamingSttTransportCallbacks) => {
      const session = { callbacks, abort: jest.fn(async () => {}), setInputMuted: jest.fn(async () => {}), stop: jest.fn() };
      mockSessions.push(session); return session;
    } }),
}));
jest.mock("../stt/sttSettingsClient", () => ({ correctSttTranscript: async (_u: string, _t: string, text: string) => ({ text, changed: false }) }));
const a: VoiceTarget = { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: "chat-a" }, cwd: "/work" };
const b: VoiceTarget = { kind: "orchestrator", orchestratorId: "main" };
function useSurface(target: VoiceTarget, send: jest.Mock, busy = false) {
  const [transcript, setTranscript] = useState("");
  return useControlledStreamingStt({ target, panelId: target.kind === "session" ? "popup" : undefined, busy,
    runnerUrl: "http://runner.invalid", runnerToken: "test-token", transcript, setTranscript, autoReplyAfterStt: true,
    correctionContext: [], correctionIdentity: JSON.stringify(target), sendTranscript: async (text, accepted) => { send(text); accepted(); },
    onError: jest.fn(), onUsage: jest.fn(), onSample: jest.fn(), onSpeechBegin: jest.fn(),
    replyLoading: busy, ttsPlaybackActive: false, voiceInputDuringTtsAllowed: false, canStart: !busy,
  });
}
const emit = async (index: number, payload: Record<string, unknown>) => {
  await act(async () => { mockSessions[index].callbacks.onMessage(JSON.stringify(payload)); await Promise.resolve(); });
};
const advance = async (ms = 0) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { AppState.currentState = "active"; jest.useFakeTimers(); mockSessions.length = 0; mockSent.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("normal A to orchestrator B: real shared hooks release A, announce B, confirm native ready, mute cue, then send only to B", async () => {
  const control = getVoiceControl(mockManager as unknown as RunnerWebSocketManager);
  const announcement = jest.fn(async () => {});
  const cue = jest.fn(async () => {});
  control.configure({ preflight: async () => null, open: async () => ({}), announce: announcement, readyCue: cue });
  const stopRoot = control.start(); await advance();
  const sendA = jest.fn(); const sendB = jest.fn();
  const source = await renderHook(() => useSurface(a, sendA));
  const destination = await renderHook(() => useSurface(b, sendB));
  await act(async () => { source.result.current.start(); });
  expect(mockSessions).toHaveLength(1);
  await emit(0, { type: "ready" });
  const origin = control.origin("popup", a)!;
  expect(origin).toBeDefined();
  const id = "epoch.handoff";
  await act(async () => { mockReceive({ channel: "control", op: "app.control.execute", operationId: id, payload: {
    action: "handoff", surfaceId: origin.surfaceId, expectedGeneration: origin.ownerGeneration,
    connectionGeneration: "connection", expiresAt: new Date(Date.now() + 1_000).toISOString(), target: b,
  } }); });
  await advance(75);
  expect(mockSessions[0].abort).toHaveBeenCalledTimes(1);
  expect(mockSessions).toHaveLength(2);
  expect(announcement).toHaveBeenCalledWith(b, undefined, expect.anything());
  expect(cue).not.toHaveBeenCalled();
  expect(mockSent.some((m) => m.op === "app.control.result" && m.operationId === id)).toBe(false);
  // A's delayed native callback cannot become B's input.
  await emit(0, { type: "transcript", text: "late source", isFinal: true });
  await emit(1, { type: "ready" }); await advance(30);
  expect(cue).toHaveBeenCalledTimes(1);
  expect(mockSessions[1].setInputMuted.mock.calls).toEqual([[true], [false]]);
  expect(mockSent.find((m) => m.op === "app.control.result" && m.operationId === id)?.payload)
    .toMatchObject({ status: "applied", desired: "listening", observed: "recording", target: b });
  await emit(1, { type: "transcript", text: "Bへの相談", isFinal: true });
  await emit(1, { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  expect(sendB).toHaveBeenCalledWith("Bへの相談");
  expect(sendA).not.toHaveBeenCalled();
  await source.unmount(); await destination.unmount(); stopRoot();
});

test("manual B start uses the same lease; reply/TTS completion on A cannot restart or steal its microphone", async () => {
  const control = getVoiceControl(mockManager as unknown as RunnerWebSocketManager);
  const stopRoot = control.start(); await advance();
  const source = await renderHook(({ busy }: { busy: boolean }) => useSurface(a, jest.fn(), busy), { initialProps: { busy: false } });
  const destination = await renderHook(() => useSurface(b, jest.fn()));
  await act(async () => { source.result.current.start(); }); await emit(0, { type: "ready" });
  await act(async () => { destination.result.current.start(); }); await emit(1, { type: "ready" });
  expect(mockSessions[0].abort).toHaveBeenCalledTimes(1);
  await source.rerender({ busy: true }); await source.rerender({ busy: false }); await advance(1_000);
  expect(mockSessions).toHaveLength(2);
  expect(source.result.current.isArmed()).toBe(false);
  expect(destination.result.current.getSnapshot().observed).toBe("recording");
  expect(source.result.current.allowsSpeech()).toBe(false);
  await source.unmount(); await destination.unmount(); stopRoot();
});
