import { act, cleanup, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { CONTINUOUS_DICTATION_IDLE_MS, REPLY_CYCLE_START_TIMEOUT_MS, TTS_START_GRACE_MS, useStreamingStt } from "./useStreamingStt";
import { playVoiceSound } from "../app/voiceSounds";
import type { StreamingSttTransportCallbacks } from "./streamingSttTransport";
import { correctSttTranscript, type SttCorrectionContext } from "./sttSettingsClient";
import { recordHttpNetworkUsage, subscribeNetworkUsageIdleObservations, updateNetworkUsageObservationAppState,
  type NetworkUsageIdleObservation } from "../ws/networkUsageMetrics";

const mockSessions: MockSession[] = [];
const mockConnect = jest.fn((_url: string, _token: string, callbacks: StreamingSttTransportCallbacks) => {
  const session = new MockSession(callbacks);
  mockSessions.push(session);
  return session;
});

class MockSession {
  playReadyCue = (signal?: AbortSignal) => playVoiceSound("ready", signal);
  setInputMuted = jest.fn<Promise<void>, [boolean]>().mockResolvedValue(undefined);
  stop = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  abort = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  constructor(readonly callbacks: StreamingSttTransportCallbacks) {}
  emit(message: Record<string, unknown>) {
    this.callbacks.onMessage(JSON.stringify(message));
  }
}

jest.mock("../app/voiceSounds", () => ({ playVoiceSound: jest.fn(async () => {}) }));
jest.mock("./useStreamingSttTransport", () => ({
  useStreamingSttTransport: () => ({ supported: true, connect: mockConnect }),
}));
jest.mock("./sttSettingsClient", () => ({
  correctSttTranscript: jest.fn(async (_url: string, _token: string, text: string) => ({ changed: false, text })),
}));

const usage = {
  usedSeconds: 1,
  limitSeconds: 3600,
  remainingSeconds: 3599,
  monthUtc: "2026-09",
  resetAt: "2026-10-01T00:00:00.000Z",
};

function createOptions() {
  return {
    runnerUrl: "http://runner.test",
    runnerToken: "token",
    transcript: "",
    autoReplyAfterStt: true,
    correctionContext: [] as SttCorrectionContext[],
    correctionIdentity: "session-1",
    setTranscript: jest.fn(),
    sendTranscript: jest.fn(async (_text: string, onAccepted: () => void) => onAccepted()),
    onUsage: jest.fn(),
    onSample: jest.fn(),
    onError: jest.fn(),
    onDiagnostic: jest.fn(),
    canStart: true,
    onSpeechBegin: jest.fn(),
    replyLoading: false,
    ttsPlaybackActive: false,
    voiceInputDuringTtsAllowed: false,
  };
}

type Options = ReturnType<typeof createOptions>;

async function advanceTimers(ms: number) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

async function emit(session: MockSession, message: Record<string, unknown>) {
  await act(async () => {
    session.emit(message);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openReady(result: { current: ReturnType<typeof useStreamingStt> }) {
  await act(async () => { result.current.start(); await Promise.resolve(); });
  expect(result.current.phase).toBe("connecting");
  expect(result.current.active).toBe(true);
  const session = mockSessions.at(-1)!;
  await emit(session, { type: "ready" });
  expect(result.current.phase).toBe("recording");
  return session;
}

async function finishSpeech(session: MockSession, text: string, reason = "speech_end_timeout") {
  await emit(session, { type: "transcript", text, isFinal: true });
  await emit(session, { type: "done", reason, hasSpeech: true, usage });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  AppState.currentState = "active";
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  jest.mocked(correctSttTranscript).mockImplementation(async (_url, _token, text) => ({ changed: false, text }));
  jest.mocked(playVoiceSound).mockImplementation(async () => {});
  mockSessions.length = 0;
});

afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
});

test("shows changed correction for three seconds, then sends exactly once", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  options.correctionContext = [{ role: "assistant", text: "直前の返答" }];
  const { result, rerender } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await finishSpeech(session, "元の文章");
  expect(correctSttTranscript).toHaveBeenCalledWith("http://runner.test", "token", "元の文章",
    options.correctionContext, expect.any(AbortSignal));
  expect(result.current.correctionPreview).toEqual({ text: "補正した文章",
    deadlineMs: Date.now() + 3000,
    editing: false,
    parts: expect.arrayContaining([
      { kind: "delete", text: "元の" }, { kind: "insert", text: "補正した" },
    ]) });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_correction_started", {
    version: 2, chars: 4, contextMessages: 1,
  });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_correction_result", {
    version: 2, changed: true, deletedChars: 2, insertedChars: 4,
  });
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("元の文章");
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("補正した文章");
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("直前の返答");
  const deadlineMs = result.current.correctionPreview!.deadlineMs;
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(2000);
  await act(async () => rerender(options));
  expect(result.current.correctionPreview?.deadlineMs).toBe(deadlineMs);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1000);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("補正した文章", expect.any(Function));
  await act(async () => result.current.sendCorrectionPreview());
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("starts the full send window after the preview commits even when rendering is delayed", async () => {
  let resolveCorrection!: (value: { changed: boolean; text: string }) => void;
  jest.mocked(correctSttTranscript).mockImplementation(() => new Promise((resolve) => {
    resolveCorrection = resolve;
  }));
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  expect(result.current.phase).toBe("correcting");
  await act(async () => {
    resolveCorrection({ changed: true, text: "補正した文章" });
    await Promise.resolve();
    jest.setSystemTime(Date.now() + 800);
  });
  expect(result.current.correctionPreview?.deadlineMs).toBe(Date.now() + 3000);
  await advanceTimers(2999);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("tap sends immediately and cancel leaves corrected draft editable", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await act(async () => result.current.cancelCorrection());
  expect(options.setTranscript).toHaveBeenCalledWith("補正した文章");
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await finishSpeech(await openReady(result), "次の文章");
  await act(async () => result.current.sendCorrectionPreview());
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("補正した文章", expect.any(Function));
  await advanceTimers(4000);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("editing in the preview stops automatic send and sends only the latest edited text once", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await advanceTimers(2999);
  await act(async () => result.current.beginCorrectionEdit());
  expect(result.current.correctionPreview).toMatchObject({ editing: true, deadlineMs: null,
    text: "補正した文章" });
  await act(async () => result.current.setCorrectionText("編集した文章"));
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(result.current.correctionPreview?.text).toBe("編集した文章");
  await act(async () => { result.current.sendCorrectionPreview(); result.current.sendCorrectionPreview(); });
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("編集した文章", expect.any(Function));
});

test("discarding an edited correction restores the original draft without sending or retrying correction", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await advanceTimers(2999);
  await act(async () => result.current.beginCorrectionEdit());
  await act(async () => result.current.setCorrectionText("編集した文章"));
  await act(async () => { result.current.discardCorrection(); result.current.discardCorrection(); });
  expect(result.current.correctionPreview).toBeNull();
  expect(options.setTranscript).toHaveBeenLastCalledWith("元の文章");
  expect(options.setTranscript).not.toHaveBeenCalledWith("編集した文章");
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(correctSttTranscript).toHaveBeenCalledTimes(1);
  await act(async () => result.current.sendManualTranscript("元の文章を手で修正", () => true));
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("元の文章を手で修正", expect.any(Function));
  expect(correctSttTranscript).toHaveBeenCalledTimes(1);
});

test("empty inline edit stays in the card and cannot send", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await act(async () => result.current.beginCorrectionEdit());
  await act(async () => result.current.setCorrectionText("   "));
  await act(async () => result.current.sendCorrectionPreview());
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(result.current.correctionPreview).toMatchObject({ editing: true, text: "   " });
});

test("canceling an inline edit preserves its latest text as the draft", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await act(async () => result.current.beginCorrectionEdit());
  await act(async () => result.current.setCorrectionText("書き直した文章"));
  await act(async () => result.current.cancelCorrection());
  expect(options.setTranscript).toHaveBeenCalledWith("書き直した文章");
  expect(result.current.correctionPreview).toBeNull();
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("a session switch discards an inline edit and its old timer", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result, rerender } = await renderHook((props: Options) => useStreamingStt(props),
    { initialProps: options });
  await finishSpeech(await openReady(result), "元の文章");
  await act(async () => result.current.beginCorrectionEdit());
  await act(async () => result.current.setCorrectionText("書き直した文章"));
  await act(async () => rerender({ ...options, correctionIdentity: "session-2" }));
  expect(result.current.correctionPreview).toBeNull();
  expect(options.setTranscript).not.toHaveBeenCalledWith("書き直した文章");
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("manual Enter during preview cancels the timer before sending the draft", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await act(async () => result.current.sendManualTranscript("元の文章", () => true));
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("元の文章", expect.any(Function));
  await advanceTimers(4000);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("manual Enter cannot dispatch again after the preview timer claims send", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  let resolveSend = () => {};
  let acceptSend = () => {};
  const options = createOptions();
  options.sendTranscript.mockImplementation((_text, onAccepted) => new Promise<void>((resolve) => {
    acceptSend = onAccepted;
    resolveSend = resolve;
  }));
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  await advanceTimers(3000);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  await act(async () => result.current.sendManualTranscript("元の文章", () => true));
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  await act(async () => { acceptSend(); resolveSend(); });
  expect(options.setTranscript).toHaveBeenCalledWith("");
  expect(result.current.phase).toBe("connecting");
});

test("session switch discards a pending correction without overwriting its draft", async () => {
  let resolveCorrection!: (value: { changed: boolean; text: string }) => void;
  jest.mocked(correctSttTranscript).mockImplementation(() => new Promise((resolve) => {
    resolveCorrection = resolve;
  }));
  const options = createOptions();
  const { result, rerender } = await renderHook((props: Options) => useStreamingStt(props),
    { initialProps: options });
  await finishSpeech(await openReady(result), "古い会話");
  expect(result.current.phase).toBe("correcting");
  await act(async () => rerender({ ...options, correctionIdentity: "session-2" }));
  await act(async () => resolveCorrection({ changed: true, text: "古い会話の補正" }));
  await advanceTimers(4000);
  expect(result.current.correctionPreview).toBeNull();
  expect(options.setTranscript).not.toHaveBeenCalledWith("古い会話の補正");
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("session switch after dispatch ignores late acceptance from the old send", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  let acceptOld = () => {};
  let resolveOld = () => {};
  const old = createOptions();
  old.sendTranscript.mockImplementation((_text, onAccepted) => new Promise<void>((resolve) => {
    acceptOld = onAccepted;
    resolveOld = resolve;
  }));
  const { result, rerender } = await renderHook((props: Options) => useStreamingStt(props),
    { initialProps: old });
  await finishSpeech(await openReady(result), "古い会話");
  await act(async () => result.current.sendCorrectionPreview());
  const next = { ...old, correctionIdentity: "session-2", setTranscript: jest.fn() };
  await act(async () => rerender(next));
  await act(async () => { acceptOld(); resolveOld(); });
  expect(next.setTranscript).not.toHaveBeenCalled();
  expect(result.current.correctionPreview).toBeNull();
});

test("an unresolved old send cannot prevent canceling a new session preview", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
  const options = createOptions();
  options.sendTranscript.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const { result, rerender } = await renderHook((props: Options) => useStreamingStt(props),
    { initialProps: options });
  await finishSpeech(await openReady(result), "古い会話");
  await act(async () => result.current.sendCorrectionPreview());
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  await act(async () => rerender({ ...options, correctionIdentity: "session-2" }));
  await finishSpeech(await openReady(result), "新しい会話");
  expect(result.current.correctionPreview).not.toBeNull();
  await act(async () => result.current.cancelCorrection());
  expect(result.current.correctionPreview).toBeNull();
  await advanceTimers(4000);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("correction failure preserves the transcript and never auto sends", async () => {
  jest.mocked(correctSttTranscript).mockRejectedValue(Object.assign(new Error("correction failed"), { status: 502 }));
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "元の文章");
  expect(options.setTranscript).toHaveBeenCalledWith("元の文章");
  expect(options.onError).toHaveBeenCalledWith(expect.stringContaining("手動で送信"));
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_correction_failed", {
    version: 2, errorName: "Error", httpStatus: 502,
  });
  await advanceTimers(4000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("starts without an optional eligibility gate", async () => {
  const { canStart: _canStart, ...options } = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));

  await act(async () => { result.current.start(); await Promise.resolve(); });

  expect(mockSessions).toHaveLength(1);
  expect(options.onError).not.toHaveBeenCalled();
});

test("guards double start and ignores stale events after auto rearm", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await act(async () => {
    result.current.start();
    result.current.start();
    await Promise.resolve();
  });
  expect(mockSessions).toHaveLength(1);
  const first = mockSessions[0];
  await emit(first, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
  await emit(first, { type: "transcript", text: "stale", isFinal: true });
  expect(options.setTranscript).not.toHaveBeenCalledWith("stale");
});

test("repeated empty Mac sessions restart beyond the error retry limit and still recognize speech", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  for (let index = 0; index < 6; index += 1) {
    const session = mockSessions.at(-1)!;
    await emit(session, { type: "speech_activity_begin" });
    await emit(session, { type: "speech_activity_end" });
    await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: false });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.current.isArmed()).toBe(true);
    await advanceTimers(250);
    expect(mockSessions).toHaveLength(index + 2);
    await emit(mockSessions.at(-1)!, { type: "ready" });
    expect(result.current.phase).toBe("recording");
  }
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(options.onError.mock.calls).toEqual(Array.from({ length: 6 }, () => [""]));
  expect(options.onDiagnostic.mock.calls.some(([event]) => event === "stt_error_retry")).toBe(false);
  await finishSpeech(mockSessions.at(-1)!, "再開後の音声");
  expect(options.sendTranscript).toHaveBeenCalledWith("再開後の音声", expect.any(Function));
});

test("Mac dictation keeps speech across a pause and sends only on explicit manual send", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "前の文章", isFinal: false });
  await emit(first, { type: "transcript", text: "前の文章", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章");
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(correctSttTranscript).not.toHaveBeenCalled();
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await emit(second, { type: "transcript", text: "続き", isFinal: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章 続き");
  await emit(second, { type: "done", reason: "recognition_segment_end", hasSpeech: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章 続き");
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await emit(mockSessions.at(-1)!, { type: "transcript", text: "さらに", isFinal: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章 続き さらに");
  await act(async () => result.current.stop());
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await act(async () => result.current.sendManualTranscript("前の文章 続き さらに", () => true));
  expect(options.sendTranscript).toHaveBeenCalledWith("前の文章 続き さらに", expect.any(Function));
});

test.each([1, 2])("Mac dictation sends the accumulated draft after %i segment(s) and a long idle", async (segments) => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  for (let index = 0; index < segments; index += 1) {
    const session = mockSessions.at(-1)!;
    await emit(session, { type: "transcript", text: `文${index + 1}`, isFinal: true });
    await emit(session, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await advanceTimers(250);
    await emit(mockSessions.at(-1)!, { type: "ready" });
  }
  const draft = segments === 1 ? "文1" : "文1 文2";
  await emit(mockSessions.at(-1)!, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(correctSttTranscript).toHaveBeenCalledWith("http://runner.test", "token", draft,
    [], expect.any(AbortSignal));
  expect(options.sendTranscript).toHaveBeenCalledWith(draft, expect.any(Function));
  expect(options.setTranscript).toHaveBeenLastCalledWith("");
});

test("empty recognition segments cannot postpone the last dictated text's idle completion", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "最初の文章", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  for (let index = 0; index < 2; index += 1) {
    await advanceTimers(800);
    await emit(mockSessions.at(-1)!, { type: "done", reason: "recognition_segment_end", hasSpeech: false });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await advanceTimers(250);
    await emit(mockSessions.at(-1)!, { type: "ready" });
  }
  await advanceTimers(399);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  const activeSession = mockSessions.at(-1)!;
  await advanceTimers(1);
  expect(activeSession.abort).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("最初の文章", expect.any(Function));
});

test("dictation waits for two ready seconds after delayed finalization and reconnect", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "前半", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await emit(second, { type: "transcript", text: "後半", isFinal: false });
  await emit(second, { type: "speech_activity_end" });
  await advanceTimers(5_000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await emit(second, { type: "done", reason: "recognition_segment_end", hasSpeech: false });
  await advanceTimers(250);
  await advanceTimers(5_000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS - 1);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
});

test("false speech activity preserves earlier ready time without sending during recognition", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "残る文章", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await advanceTimers(800);
  await emit(second, { type: "speech_activity_begin" });
  await advanceTimers(5_000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await emit(second, { type: "speech_activity_end" });
  await emit(second, { type: "done", reason: "recognition_segment_end", hasSpeech: false });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await advanceTimers(1_199);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("残る文章", expect.any(Function));
});

test("new dictated text extends the cross-segment idle deadline", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "前半", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS / 2);
  await emit(second, { type: "transcript", text: "後半", isFinal: false });
  await emit(second, { type: "transcript", text: "後半", isFinal: true });
  await emit(second, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS - 1);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
});

test("repeated unchanged partials do not extend the idle deadline", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "前半", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS / 2);
  await emit(second, { type: "transcript", text: "後半", isFinal: false });
  await advanceTimers(1_500);
  await emit(second, { type: "transcript", text: "後半", isFinal: false });
  await emit(second, { type: "transcript", text: "後半 ", isFinal: false });
  await advanceTimers(499);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
});

test("cross-segment idle leaves the draft editable when auto reply is disabled", async () => {
  const options = { ...createOptions(), continuousDictation: true, autoReplyAfterStt: false };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "残す文章", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS);
  expect(result.current.phase).toBe("idle");
  expect(result.current.isArmed()).toBe(false);
  expect(options.setTranscript).toHaveBeenLastCalledWith("残す文章");
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("a Google session without a Mac segment marker does not acquire the cross-segment timer", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "途中結果", isFinal: false });
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS + 1);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe("recording");
});

test("manual stop cancels cross-segment completion after the draft is sent", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "手動で送る", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await act(async () => result.current.stop());
  await act(async () => result.current.sendManualTranscript("手動で送る", () => true));
  await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS + 1);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("手動で送る", expect.any(Function));
});

test("Mac dictation stops with the accumulated draft when auto reply is disabled", async () => {
  const options = { ...createOptions(), continuousDictation: true, autoReplyAfterStt: false };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "残す文章", isFinal: true });
  await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await emit(mockSessions.at(-1)!, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(result.current.phase).toBe("idle");
  expect(result.current.isArmed()).toBe(false);
  expect(options.setTranscript).toHaveBeenLastCalledWith("残す文章");
  expect(correctSttTranscript).not.toHaveBeenCalled();
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
});

test("Mac dictation retries an initial empty session without sending a typed draft", async () => {
  const options = { ...createOptions(), continuousDictation: true, transcript: "入力済み" };
  const { result } = await renderHook(() => useStreamingStt(options));
  await emit(await openReady(result), { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("入力済み");
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(correctSttTranscript).not.toHaveBeenCalled();
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
  expect(result.current.isArmed()).toBe(true);
});

test.each([
  { priorSpeech: false, final: "" },
  { priorSpeech: false, final: " " },
  { priorSpeech: true, final: "" },
])("an empty final preserves the latest partial after long idle (prior speech: $priorSpeech, final: '$final')", async ({ priorSpeech, final }) => {
  const options = { ...createOptions(), continuousDictation: true, transcript: "入力済み" };
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  if (priorSpeech) {
    await emit(mockSessions.at(-1)!, { type: "transcript", text: "確定済み", isFinal: true });
    await emit(mockSessions.at(-1)!, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
    await advanceTimers(250);
    await emit(mockSessions.at(-1)!, { type: "ready" });
  }
  await emit(mockSessions.at(-1)!, { type: "transcript", text: "残す途中結果", isFinal: false });
  await emit(mockSessions.at(-1)!, { type: "transcript", text: final, isFinal: true });
  await emit(mockSessions.at(-1)!, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  const expected = priorSpeech
    ? "入力済み 確定済み 残す途中結果"
    : "入力済み 残す途中結果";
  expect(options.setTranscript).toHaveBeenCalledWith(expected);
  if (priorSpeech) {
    expect(options.sendTranscript).toHaveBeenCalledWith(expected, expect.any(Function));
  } else {
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(options.setTranscript).toHaveBeenLastCalledWith(expected);
  }
});

test("speech conversation still auto sends a completed Mac recognition segment", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "話した内容", "recognition_segment_end");
  expect(options.sendTranscript).toHaveBeenCalledWith("話した内容", expect.any(Function));
});

test("retry preserves the partial text already shown in the draft", async () => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "前の文章", isFinal: false });
  await emit(first, { type: "error", code: "macos_recognition_failed", message: "retry", retryable: true });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章");
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await emit(mockSessions.at(-1)!, { type: "transcript", text: "続き", isFinal: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("前の文章 続き");
});

test.each([
  "macos_recognition_failed",
  "backpressure_exceeded",
  "google_unavailable",
])("%s retry followed by long idle sends its visible dictated text", async (code) => {
  const options = { ...createOptions(), continuousDictation: true };
  const { result } = await renderHook(() => useStreamingStt(options));
  const first = await openReady(result);
  await emit(first, { type: "transcript", text: "表示済みの途中結果", isFinal: false });
  await emit(first, { type: "error", code, message: "retry", retryable: true });
  expect(options.setTranscript).toHaveBeenLastCalledWith("表示済みの途中結果");
  await advanceTimers(250);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "ready" });
  await emit(second, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(correctSttTranscript).toHaveBeenCalledWith("http://runner.test", "token",
    "表示済みの途中結果", [], expect.any(AbortSignal));
  expect(options.sendTranscript).toHaveBeenCalledWith("表示済みの途中結果", expect.any(Function));
});

test.each(["stop", "abort", "unmount"])("%s cancels empty-session restart during cleanup or its delay", async (action) => {
  for (const timing of ["cleanup", "delay"]) {
    const options = createOptions();
    const hook = await renderHook(() => useStreamingStt(options));
    const before = mockSessions.length;
    const session = await openReady(hook.result);
    let resolveAbort = () => {};
    if (timing === "cleanup") session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
    await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: false });
    let abort: Promise<void> | undefined;
    if (action === "unmount") await hook.unmount();
    else await act(async () => {
      if (action === "stop") hook.result.current.stop();
      else abort = hook.result.current.abort();
    });
    await act(async () => { resolveAbort(); await abort; });
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(before + 1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).not.toHaveBeenCalled();
    if (action !== "unmount") await hook.unmount();
  }
});

test("waits for native abort before restarting after stop while connecting", async () => {
  let resolveAbort = () => {};
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await act(async () => { result.current.start(); await Promise.resolve(); });
  mockSessions[0].abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await act(async () => { result.current.stop(); });
  expect(result.current.phase).toBe("idle");
  await act(async () => { result.current.start(); await Promise.resolve(); });
  expect(mockSessions).toHaveLength(1);
  await act(async () => { resolveAbort(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockSessions).toHaveLength(2);
  await emit(mockSessions[1], { type: "ready" });
  expect(result.current.phase).toBe("recording");
});

test("stop aborts once, keeps visible speech as a draft, and ignores late results", async () => {
  const options = { ...createOptions(), transcript: "earlier" };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "partial", isFinal: false });
  const transcriptCalls = options.setTranscript.mock.calls.length;
  await act(async () => { result.current.stop(); result.current.stop(); });
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(session.stop).not.toHaveBeenCalled();
  expect(options.setTranscript).toHaveBeenLastCalledWith("earlier partial");
  expect(options.setTranscript).toHaveBeenCalledTimes(transcriptCalls + 1);
  expect(result.current.phase).toBe("idle");
  expect(result.current.isArmed()).toBe(false);
  await finishSpeech(session, "late final");
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(options.setTranscript).toHaveBeenCalledTimes(transcriptCalls + 1);
  expect(options.onError).not.toHaveBeenCalled();
});

test("manual voice send reuses the reply cycle, while later edits do not rearm capture", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  await emit(session, { type: "transcript", text: "heard", isFinal: false });
  await act(async () => { hook.result.current.stop(); });
  const callsAfterStop = options.setTranscript.mock.calls.length;
  await emit(session, { type: "transcript", text: "late speech", isFinal: true });
  expect(options.setTranscript).toHaveBeenCalledTimes(callsAfterStop);

  await act(async () => { await hook.result.current.sendManualTranscript("edited", () => true); });
  expect(options.sendTranscript).toHaveBeenCalledWith("edited", expect.any(Function));
  expect(hook.result.current.phase).toBe("connecting");
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  options = { ...options, replyLoading: false };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(2);

  await act(async () => { hook.result.current.stop(); });
  const sessionCount = mockSessions.length;
  await act(async () => { await hook.result.current.sendManualTranscript("older", () => false); });
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(sessionCount);
  expect(hook.result.current.phase).toBe("idle");
});

test("manual send resumes after a fast reply and disarms after a failed reply", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  await act(async () => { result.current.stop(); });
  await act(async () => { await result.current.sendManualTranscript("typed", () => true); });
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(2);

  await act(async () => { result.current.stop(); });
  options.sendTranscript.mockImplementationOnce(async (_text, onAccepted) => {
    onAccepted();
    throw new Error("send failed");
  });
  let sendError: unknown;
  await act(async () => {
    try { await result.current.sendManualTranscript("retry", () => true); }
    catch (error) { sendError = error; }
  });
  expect(sendError).toEqual(new Error("send failed"));
  expect(result.current.phase).toBe("idle");
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(2);
});

test("late auto-send acceptance after edit focus cannot clear the draft", async () => {
  let accept: (() => void) | undefined;
  const options = createOptions();
  options.sendTranscript.mockImplementationOnce((_text, onAccepted) => {
    accept = onAccepted;
    return new Promise<void>(() => undefined);
  });
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "heard");
  await act(async () => { result.current.stop(); });
  const callsAfterStop = options.setTranscript.mock.calls.length;
  await act(async () => { accept?.(); });
  expect(options.setTranscript).toHaveBeenCalledTimes(callsAfterStop);
  expect(result.current.phase).toBe("idle");
});

test("stop during done teardown prevents the pending send", async () => {
  let resolveAbort = () => {};
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await emit(session, { type: "transcript", text: "recognized", isFinal: true });
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: true, usage });
  await act(async () => { result.current.stop(); });
  expect(result.current.phase).toBe("idle");
  expect(options.setTranscript).toHaveBeenLastCalledWith("recognized");
  await act(async () => { resolveAbort(); await Promise.resolve(); });
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_done_superseded", expect.any(Object));
});

test("diagnostics distinguish interim-only completion from accepted auto-send without transcript content", async () => {
  const interimOptions = createOptions();
  const interim = await renderHook(() => useStreamingStt(interimOptions));
  const interimSession = await openReady(interim.result);
  await emit(interimSession, { type: "transcript", text: "partial secret", isFinal: false });
  await emit(interimSession, { type: "done", reason: "speech_end_timeout", hasSpeech: true, usage });
  expect(interimOptions.sendTranscript).not.toHaveBeenCalled();
  expect(interimOptions.onDiagnostic).toHaveBeenCalledWith("stt_auto_send_skipped", expect.objectContaining({
    reason: "client_no_final_speech", finalChars: 0, interimChars: 14,
  }));
  expect(JSON.stringify(interimOptions.onDiagnostic.mock.calls)).not.toContain("partial secret");

  const finalOptions = createOptions();
  const final = await renderHook(() => useStreamingStt(finalOptions));
  await finishSpeech(await openReady(final.result), "final secret");
  expect(finalOptions.onDiagnostic).toHaveBeenCalledWith("stt_auto_send_dispatch", expect.objectContaining({ chars: 12 }));
  expect(finalOptions.onDiagnostic).toHaveBeenCalledWith("stt_auto_send_accepted", expect.objectContaining({ current: true }));
  expect(JSON.stringify(finalOptions.onDiagnostic.mock.calls)).not.toContain("final secret");
});

test("diagnostics retain nonempty partial length after an empty Apple final", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "秘密の途中結果", isFinal: false });
  await emit(session, { type: "transcript", text: "", isFinal: true });
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: false, usage });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_partial_transcript_received", expect.objectContaining({
    chars: "秘密の途中結果".length,
  }));
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_final_transcript_received", expect.objectContaining({
    chars: 0, lastPartialChars: "秘密の途中結果".length,
  }));
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_done_received", expect.objectContaining({
    hasSpeech: false, lastPartialChars: "秘密の途中結果".length,
  }));
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("秘密の途中結果");
});

test("diagnostics record an auto-send rejection", async () => {
  const options = createOptions();
  options.sendTranscript.mockRejectedValueOnce(new Error("private send failure"));
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "speech");
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_auto_send_failed", expect.objectContaining({ current: true }));
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("private send failure");
});

test("abort during terminal teardown does not send a stale final or rearm", async () => {
  let resolveAbort = () => {};
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await emit(session, { type: "transcript", text: "stale", isFinal: true });
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: true, usage });
  let abortPromise: Promise<void> = Promise.resolve();
  await act(async () => { abortPromise = result.current.abort(); });
  await act(async () => { resolveAbort(); await abortPromise; });
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(1);
});

test("unmounting an active recording logs the interruption without transcript content", async () => {
  const options = createOptions();
  const hook = await renderHook(() => useStreamingStt(options));
  const session = await openReady(hook.result);
  await emit(session, { type: "transcript", text: "private words", isFinal: false });
  await hook.unmount();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_unmounted", expect.objectContaining({
    sessionOpen: true, listening: true,
  }));
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("private words");
});

test("Runner error is terminal even if a late done arrives", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "画面に見えた文章", isFinal: false });
  await emit(session, { type: "error", code: "cloud_failed", message: "認識できません", retryable: false });
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  expect(options.setTranscript).toHaveBeenLastCalledWith("画面に見えた文章");
  expect(options.onError).toHaveBeenCalledTimes(1);
  expect(options.onUsage).not.toHaveBeenCalled();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_runner_error", expect.any(Object));
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("認識できません");
  expect(result.current.active).toBe(false);
});

test("retryable Runner failure waits for cleanup, preserves the draft, and ignores stale callbacks", async () => {
  let resolveAbort = () => {};
  const options = { ...createOptions(), transcript: "draft" };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "final", isFinal: true });
  await emit(session, { type: "transcript", text: "private partial", isFinal: false });
  session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await emit(session, { type: "error", code: "macos_recognition_failed", message: "private failure", retryable: true });
  expect(result.current.phase).toBe("connecting");
  expect(result.current.isArmed()).toBe(true);
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(options.setTranscript).toHaveBeenLastCalledWith("draft finalprivate partial");
  await act(async () => { session.callbacks.onClose(); session.callbacks.onError("late error"); });
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(1);
  await act(async () => { resolveAbort(); });
  await advanceTimers(249);
  expect(mockSessions).toHaveLength(1);
  await advanceTimers(1);
  expect(mockSessions).toHaveLength(2);
  const retry = mockSessions[1];
  await emit(retry, { type: "ready" });
  expect(result.current.phase).toBe("recording");
  await emit(retry, { type: "transcript", text: "next", isFinal: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("draft finalprivate partial next");
  expect(options.onError).not.toHaveBeenCalled();
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_runner_error", {
    version: 1, code: "macos_recognition_failed", retryable: true, retries: 0,
  });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_error_retry", expect.objectContaining({
    version: 2, attempt: 1, cause: "runner_error", candidateRevision: null, committing: false,
  }));
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toMatch(/private partial|private failure/);
});

test.each(["stop", "abort", "unmount"])("%s during retry cleanup prevents reconnection", async (action) => {
  let resolveAbort = () => {};
  const options = createOptions();
  const hook = await renderHook(() => useStreamingStt(options));
  const session = await openReady(hook.result);
  session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await emit(session, { type: "error", code: "macos_recognition_failed", message: "failed", retryable: true });
  let abort: Promise<void> | undefined;
  if (action === "unmount") await hook.unmount();
  else await act(async () => {
    if (action === "stop") hook.result.current.stop();
    else abort = hook.result.current.abort();
  });
  await act(async () => { resolveAbort(); await abort; });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(1);
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(options.onError).not.toHaveBeenCalled();
});

test("stop cancels a scheduled error retry and manual start gets a new session", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "error", code: "google_unavailable", message: "failed", retryable: true });
  await act(async () => { result.current.stop(); });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(1);
  expect(result.current.isArmed()).toBe(false);
  await openReady(result);
  expect(mockSessions).toHaveLength(2);
});

test("retries are bounded across ready messages and manual start resets the budget", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  for (const delay of [250, 500, 1_000]) {
    await emit(mockSessions.at(-1)!, { type: "error", code: "macos_recognition_failed", message: "failed", retryable: true });
    const sessions = mockSessions.length;
    await advanceTimers(delay - 1);
    expect(mockSessions).toHaveLength(sessions);
    await advanceTimers(1);
    expect(mockSessions).toHaveLength(sessions + 1);
    await emit(mockSessions.at(-1)!, { type: "ready" });
  }
  await emit(mockSessions.at(-1)!, { type: "error", code: "macos_recognition_failed", message: "failed", retryable: true });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(4);
  expect(result.current.phase).toBe("idle");
  expect(options.onError).toHaveBeenCalledTimes(1);
  await openReady(result);
  await emit(mockSessions.at(-1)!, { type: "error", code: "google_unavailable", message: "failed", retryable: true });
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(6);
});

test("successful no-speech completion resets the error retry budget", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  await emit(mockSessions.at(-1)!, { type: "error", code: "google_unavailable", message: "failed", retryable: true });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  await emit(mockSessions.at(-1)!, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "error", code: "google_unavailable", message: "failed", retryable: true });
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(4);
  expect(options.onDiagnostic).toHaveBeenLastCalledWith("stt_session_connect", expect.any(Object));
  expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_error_retry")
    .map(([, payload]) => ({ version: payload.version, attempt: payload.attempt }))).toEqual([
    { version: 2, attempt: 1 }, { version: 6, attempt: 1 },
  ]);
});

test("retryable startup failure respects availability before reconnecting", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  await act(async () => { hook.result.current.start(); });
  options = { ...options, canStart: false };
  await hook.rerender(options);
  await emit(mockSessions[0], { type: "error", code: "macos_start_timeout", message: "failed", retryable: true });
  await advanceTimers(1_000);
  expect(mockSessions).toHaveLength(1);
  options = { ...options, canStart: true };
  await hook.rerender(options);
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
  await emit(mockSessions[1], { type: "ready" });
  expect(hook.result.current.phase).toBe("recording");
});

test.each(["close", "error"])("transport %s retries with the shared budget and retains finalized text", async (failure) => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "確定済み", isFinal: true });
  await act(async () => {
    if (failure === "close") session.callbacks.onClose();
    else session.callbacks.onError("private connection details");
  });
  await advanceTimers(250);
  const resumed = mockSessions.at(-1)!;
  await emit(resumed, { type: "ready" });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_recovery_ready", { version: 3, attempt: 1 });
  await emit(resumed, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(options.sendTranscript).toHaveBeenCalledWith("確定済み", expect.any(Function));
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toMatch(/確定済み|private connection details/);
});

test("transport failures share one bounded retry budget and permission denial never retries", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  for (const delay of [250, 500, 1000]) {
    await act(async () => { mockSessions.at(-1)!.callbacks.onError("offline"); });
    await advanceTimers(delay);
    await emit(mockSessions.at(-1)!, { type: "ready" });
  }
  await act(async () => { mockSessions.at(-1)!.callbacks.onClose(); });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(4);
  expect(result.current.isArmed()).toBe(false);
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_recovery_exhausted", { cause: "transport_close", retries: 3 });
  const denied = await openReady(result);
  await act(async () => { denied.callbacks.onError("permission denied", false); });
  await advanceTimers(10_000);
  expect(mockSessions).toHaveLength(5);
  expect(result.current.isArmed()).toBe(false);
  expect(options.onError).toHaveBeenLastCalledWith("permission denied");
});

test("delivers volume samples and handles transport errors, close, and invalid JSON", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await act(async () => { session.callbacks.onSample(0.4); });
  expect(options.onSample).toHaveBeenCalledWith(0.4);
  await act(async () => { session.callbacks.onError("backpressure_exceeded"); });
  expect(options.onError).not.toHaveBeenCalled();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_transport_error", expect.any(Object));
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(result.current.phase).toBe("connecting");

  const other = createOptions();
  const second = await renderHook(() => useStreamingStt(other));
  const secondSession = await openReady(second.result);
  await act(async () => { secondSession.callbacks.onClose(); });
  expect(other.onError).not.toHaveBeenCalled();
  expect(second.result.current.phase).toBe("connecting");
  expect(other.onDiagnostic).toHaveBeenCalledWith("stt_transport_closed_before_done", expect.any(Object));

  const thirdOptions = createOptions();
  const third = await renderHook(() => useStreamingStt(thirdOptions));
  const thirdSession = await openReady(third.result);
  await act(async () => { thirdSession.callbacks.onMessage("bad json"); });
  expect(thirdOptions.onError).toHaveBeenCalledWith(expect.stringContaining("不正な音声認識応答"));
  expect(thirdOptions.onDiagnostic).toHaveBeenCalledWith("stt_invalid_runner_response", expect.any(Object));
  await emit(thirdSession, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(5);
});

test("resets transcript across auto-reply and no-speech retries", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  await finishSpeech(await openReady(hook.result), "A");
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  options = { ...options, replyLoading: false };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  const second = mockSessions.at(-1)!;
  await emit(second, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  await advanceTimers(250);
  await finishSpeech(mockSessions.at(-1)!, "B");
  expect(options.sendTranscript).toHaveBeenLastCalledWith("B", expect.any(Function));
  expect(options.setTranscript).not.toHaveBeenCalledWith("A B");
});

test("rearms after an accepted turn finishes before replyLoading can render", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "fast terminal turn");
  expect(options.sendTranscript).toHaveBeenCalledWith("fast terminal turn", expect.any(Function));
  expect(result.current.phase).toBe("connecting");
  expect(mockSessions).toHaveLength(1);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(2);
  expect(options.onError).not.toHaveBeenCalled();
});

test("a later chat loading state cancels the early-completion grace wait", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  await finishSpeech(await openReady(hook.result), "chat turn");
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(1);
  options = { ...options, replyLoading: false };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(2);
});

test("rechecks voice input availability before each automatic retry", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  options = { ...options, canStart: false };
  await hook.rerender(options);
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  await advanceTimers(250 * 5);
  expect(mockSessions).toHaveLength(1);
  options = { ...options, canStart: true };
  await hook.rerender(options);
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
});

test("relistens during eligible TTS and waits for playback end otherwise", async () => {
  let options = { ...createOptions(), voiceInputDuringTtsAllowed: true };
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  await finishSpeech(await openReady(hook.result), "hello");
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  options = { ...options, replyLoading: false, ttsPlaybackActive: true };
  await hook.rerender(options);
  expect(mockSessions).toHaveLength(2);

  const ineligible = { ...createOptions(), voiceInputDuringTtsAllowed: false };
  const second = await renderHook((props: Options) => useStreamingStt(props), { initialProps: ineligible });
  await finishSpeech(await openReady(second.result), "world");
  await second.rerender({ ...ineligible, replyLoading: true });
  await second.rerender({ ...ineligible, replyLoading: false, ttsPlaybackActive: true });
  const count = mockSessions.length;
  await second.rerender({ ...ineligible, replyLoading: false, ttsPlaybackActive: false });
  expect(mockSessions).toHaveLength(count + 1);
});

test.each([false, true])("stop ends voice mode while waiting for reply (reply loading: %s)", async (replyLoading) => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  await finishSpeech(session, "hello");
  expect(options.sendTranscript).toHaveBeenCalledWith("hello", expect.any(Function));
  expect(hook.result.current.isArmed()).toBe(true);
  expect(hook.result.current.phase).toBe("connecting");

  if (replyLoading) {
    options = { ...options, replyLoading: true };
    await hook.rerender(options);
  }
  await act(async () => { hook.result.current.stop(); });
  expect(hook.result.current.phase).toBe("idle");
  expect(hook.result.current.isArmed()).toBe(false);
  expect(session.abort).toHaveBeenCalledTimes(1);

  options = { ...options, replyLoading: false, ttsPlaybackActive: true };
  await hook.rerender(options);
  options = { ...options, ttsPlaybackActive: false };
  await hook.rerender(options);
  await advanceTimers(REPLY_CYCLE_START_TIMEOUT_MS + TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(1);
  expect(options.onError).not.toHaveBeenCalled();
});

test("late send rejection after Stop leaves a new voice session intact", async () => {
  let rejectSend: (reason?: unknown) => void = () => {};
  let options = createOptions();
  options.sendTranscript.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
    rejectSend = reject;
  }));
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  await finishSpeech(await openReady(hook.result), "first turn");
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);

  await act(async () => { hook.result.current.stop(); });
  options = { ...options, transcript: "new draft" };
  await hook.rerender(options);
  const nextSession = await openReady(hook.result);
  const transcriptCalls = options.setTranscript.mock.calls.length;

  await act(async () => { rejectSend(new Error("late rejection")); await Promise.resolve(); });
  expect(options.onError).not.toHaveBeenCalled();
  expect(options.setTranscript).toHaveBeenCalledTimes(transcriptCalls);
  expect(nextSession.abort).not.toHaveBeenCalled();
  expect(hook.result.current.phase).toBe("recording");
});

test("reply timeout and rejected send settle without reopening", async () => {
  const options = createOptions();
  options.sendTranscript.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const { result } = await renderHook(() => useStreamingStt(options));
  await finishSpeech(await openReady(result), "hello");
  await advanceTimers(REPLY_CYCLE_START_TIMEOUT_MS);
  expect(result.current.active).toBe(false);
  expect(result.current.isArmed()).toBe(false);

  const rejected = createOptions();
  rejected.sendTranscript.mockRejectedValueOnce(new Error("not accepted"));
  const second = await renderHook(() => useStreamingStt(rejected));
  await finishSpeech(await openReady(second.result), "hello");
  expect(rejected.onError).toHaveBeenCalledWith("文字起こし結果を送信できませんでした。");
  expect(second.result.current.active).toBe(false);
});

test("limit reached keeps final text but does not rearm", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  await finishSpeech(session, "final", "limit_reached");
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  options = { ...options, replyLoading: false };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(options.sendTranscript).toHaveBeenCalledWith("final", expect.any(Function));
  expect(hook.result.current.active).toBe(false);
  expect(session.abort).toHaveBeenCalledTimes(1);
});

describe("recording across app state changes", () => {
  let onAppStateChange: (state: AppStateStatus) => void;
  const changeAppState = async (state: AppStateStatus) => {
    await act(async () => { onAppStateChange(state); });
  };

  beforeEach(() => {
    jest.replaceProperty(AppState, "currentState", "active");
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      onAppStateChange = listener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test("suspends once, preserves the visible draft, and resumes after old capture cleanup", async () => {
    const options = createOptions();
    const { result } = await renderHook(() => useStreamingStt(options));
    const session = await openReady(result);
    await emit(session, { type: "transcript", text: "背景前の途中結果", isFinal: false });
    let resolveAbort = () => {};
    session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
    await changeAppState("inactive");
    await changeAppState("background");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.current.isCapturing()).toBe(false);
    expect(result.current.isArmed()).toBe(true);
    expect(options.setTranscript).toHaveBeenLastCalledWith("背景前の途中結果");
    await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
    await act(async () => {
      session.callbacks.onError("stale transport failure");
      session.callbacks.onClose();
    });
    await advanceTimers(5 * 60_000);
    expect(mockSessions).toHaveLength(1);
    await changeAppState("active");
    await changeAppState("active");
    expect(mockSessions).toHaveLength(1);
    await act(async () => { resolveAbort(); });
    expect(mockSessions).toHaveLength(2);
    const resumed = mockSessions[1];
    await emit(resumed, { type: "ready" });
    expect(result.current.phase).toBe("recording");
    await emit(session, { type: "transcript", text: "late result", isFinal: true });
    await emit(resumed, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await advanceTimers(250);
    await emit(mockSessions.at(-1)!, { type: "ready" });
    await finishSpeech(mockSessions.at(-1)!, "復帰後の認識");
    expect(options.sendTranscript).toHaveBeenCalledWith("背景前の途中結果 復帰後の認識", expect.any(Function));
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_background_suspend")).toHaveLength(1);
    expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_foreground_resume")).toHaveLength(1);
    expect(JSON.stringify(options.onDiagnostic.mock.calls)).not.toContain("背景前の途中結果");
  });

  test("long idle after a backgrounded partial sends the preserved dictation", async () => {
    const options = { ...createOptions(), continuousDictation: true };
    const { result } = await renderHook(() => useStreamingStt(options));
    const first = await openReady(result);
    await emit(first, { type: "transcript", text: "背景前の音声", isFinal: false });
    await changeAppState("background");
    expect(options.setTranscript).toHaveBeenLastCalledWith("背景前の音声");
    await changeAppState("active");
    expect(mockSessions).toHaveLength(2);
    await emit(mockSessions[1], { type: "ready" });
    await emit(mockSessions[1], { type: "done", reason: "no_speech_timeout", hasSpeech: false });
    expect(options.sendTranscript).toHaveBeenCalledWith("背景前の音声", expect.any(Function));
  });

  test("cross-segment idle pauses in the background and resumes on foreground", async () => {
    const options = { ...createOptions(), continuousDictation: true };
    const { result } = await renderHook(() => useStreamingStt(options));
    const first = await openReady(result);
    await emit(first, { type: "transcript", text: "背景前の文章", isFinal: true });
    await emit(first, { type: "done", reason: "recognition_segment_end", hasSpeech: true });
    await changeAppState("background");
    await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS + 1);
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await changeAppState("active");
    await emit(mockSessions.at(-1)!, { type: "ready" });
    await advanceTimers(CONTINUOUS_DICTATION_IDLE_MS - 1);
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await advanceTimers(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("背景前の文章", expect.any(Function));
  });

  test("returning to background cancels a pending foreground connection", async () => {
    const { result } = await renderHook(() => useStreamingStt(createOptions()));
    const session = await openReady(result);
    let resolveAbort = () => {};
    session.abort.mockImplementation(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
    await changeAppState("background");
    await changeAppState("active");
    await changeAppState("inactive");
    await act(async () => { resolveAbort(); });
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(1);
    await changeAppState("active");
    expect(mockSessions).toHaveLength(2);
    await emit(mockSessions[1], { type: "ready" });
    expect(result.current.phase).toBe("recording");
  });

  test.each(["stop", "abort", "unmount", "failure"])("%s prevents foreground reactivation", async (action) => {
    const options = createOptions();
    const hook = await renderHook(() => useStreamingStt(options));
    const session = await openReady(hook.result);
    if (action === "failure") {
      await emit(session, { type: "error", code: "permission_denied", message: "denied", retryable: false });
    }
    await changeAppState("background");
    if (action === "unmount") await hook.unmount();
    else await act(async () => {
      if (action === "stop") hook.result.current.stop();
      else if (action === "abort") await hook.result.current.abort();
    });
    await changeAppState("active");
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(1);
    expect(hook.result.current.isArmed()).toBe(false);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).not.toHaveBeenCalled();
  });

  test.each(["no_speech", "error", "unavailable"])("suspends a scheduled %s restart until active and available", async (outcome) => {
    let options = createOptions();
    const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
    const session = await openReady(hook.result);
    if (outcome === "unavailable") {
      options = { ...options, canStart: false };
      await hook.rerender(options);
    }
    await emit(session, outcome === "error"
      ? { type: "error", code: "macos_recognition_failed", message: "failed", retryable: true }
      : { type: "done", reason: "no_speech_timeout", hasSpeech: false });
    await changeAppState("background");
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(1);
    await changeAppState("active");
    if (outcome === "unavailable") {
      await advanceTimers(1_000);
      expect(mockSessions).toHaveLength(1);
      options = { ...options, canStart: true };
      await hook.rerender(options);
      await advanceTimers(250);
    }
    expect(mockSessions).toHaveLength(2);
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("an initially backgrounded hook only starts on foreground after an explicit request", async () => {
    jest.replaceProperty(AppState, "currentState", "background");
    const { result } = await renderHook(() => useStreamingStt(createOptions()));
    await changeAppState("active");
    expect(mockSessions).toHaveLength(0);
    await changeAppState("background");
    await act(async () => result.current.start());
    expect(result.current.phase).toBe("connecting");
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(0);
    await changeAppState("active");
    expect(mockSessions).toHaveLength(1);
  });

  test("foreground respects reply and TTS waits, including a reply that settles in background", async () => {
    let options = createOptions();
    const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
    await finishSpeech(await openReady(hook.result), "送信済み");
    options = { ...options, replyLoading: true };
    await hook.rerender(options);
    await changeAppState("background");
    await changeAppState("active");
    expect(mockSessions).toHaveLength(1);
    options = { ...options, replyLoading: false, ttsPlaybackActive: true };
    await hook.rerender(options);
    expect(mockSessions).toHaveLength(1);
    await changeAppState("background");
    options = { ...options, ttsPlaybackActive: false };
    await hook.rerender(options);
    await advanceTimers(2_000);
    expect(mockSessions).toHaveLength(1);
    await changeAppState("active");
    expect(mockSessions).toHaveLength(2);
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.onError).not.toHaveBeenCalled();
  });
});

test("backgrounding an inline edit restores its latest text and stops sending", async () => {
  let onAppStateChange: ((state: AppStateStatus) => void) | undefined;
  const subscription = jest.spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      onAppStateChange = listener as typeof onAppStateChange;
      return { remove: jest.fn() };
    });
  try {
    jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正した文章" });
    const options = createOptions();
    const { result } = await renderHook(() => useStreamingStt(options));
    await finishSpeech(await openReady(result), "元の文章");
    await act(async () => result.current.beginCorrectionEdit());
    await act(async () => result.current.setCorrectionText("背景で残す文章"));
    await act(async () => onAppStateChange?.("background"));
    expect(result.current.correctionPreview).toBeNull();
    expect(options.setTranscript).toHaveBeenCalledWith("背景で残す文章");
    await advanceTimers(4000);
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await act(async () => onAppStateChange?.("active"));
    expect(mockSessions).toHaveLength(1);
    expect(result.current.isArmed()).toBe(false);
  } finally {
    cleanup();
    subscription.mockRestore();
  }
});

test("reports start gate wait once across polls, then its elapsed time when resolved", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  options = { ...options, canStart: false };
  await hook.rerender(options);
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  await advanceTimers(250);
  const since = Date.now();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_start_wait_started", {
    version: 2, reason: "can_start_false", since,
  });
  await advanceTimers(5000);
  expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_start_wait_started")).toHaveLength(1);
  options = { ...options, canStart: true };
  await hook.rerender(options);
  await advanceTimers(250);
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_start_wait_ended", {
    version: 2, reason: "can_start_false", since, durationMs: 5250, outcome: "resolved",
  });
  expect(mockSessions).toHaveLength(2);
});

test("reports cancellation of a blocked start", async () => {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  options = { ...options, canStart: false };
  await hook.rerender(options);
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  await advanceTimers(1250);
  await act(async () => { hook.result.current.stop(); });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_start_wait_ended", expect.objectContaining({
    reason: "can_start_false", durationMs: 1000, outcome: "cancelled",
  }));
});

test("shows abort stalls and completion duration before the next connect", async () => {
  const options = createOptions();
  const hook = await renderHook(() => useStreamingStt(options));
  const session = await openReady(hook.result);
  let resolveAbort!: () => void;
  session.abort.mockReturnValue(new Promise<void>((resolve) => { resolveAbort = resolve; }));
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_abort_started", expect.objectContaining({ queuedMs: 0 }));
  await advanceTimers(5000);
  expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_abort_completed")).toHaveLength(0);
  expect(mockSessions).toHaveLength(1);
  await act(async () => { resolveAbort(); await Promise.resolve(); });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_abort_completed", expect.objectContaining({ durationMs: 5000 }));
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(2);
});

test("attaches the current hook version to capture diagnostics and ignores retired sessions", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  const payload = { sessionId: "a1234567-1234-4567-89ab-0123456789ab", stage: "first_tap", elapsedMs: 25, capturedFrames: 4096 };
  session.callbacks.onDiagnostic?.(payload);
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_capture_diagnostic", { ...payload, version: 1 });
  await act(async () => { await result.current.abort(); });
  options.onDiagnostic.mockClear();
  session.callbacks.onDiagnostic?.(payload);
  expect(options.onDiagnostic).not.toHaveBeenCalled();
});

test.each([false, true])("empty partials and finals preserve the manual-stop draft (continuous: %s)", async (continuousDictation) => {
  const options = { ...createOptions(), continuousDictation, autoReplyAfterStt: false, transcript: "入力済み" };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "残す文章", isFinal: false });
  await emit(session, { type: "transcript", text: "", isFinal: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("入力済み 残す文章");
  await emit(session, { type: "transcript", text: " \t", isFinal: true });
  await act(async () => result.current.stop());
  expect(options.setTranscript).toHaveBeenLastCalledWith("入力済み 残す文章");
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  expect(options.setTranscript).toHaveBeenLastCalledWith("入力済み 残す文章");
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test.each([false, true])("a provider correction after empty results sends only the final text (continuous: %s)", async (continuousDictation) => {
  const options = { ...createOptions(), continuousDictation };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "未訂正", isFinal: false });
  await emit(session, { type: "transcript", text: "", isFinal: false });
  await emit(session, { type: "transcript", text: "", isFinal: true });
  await emit(session, { type: "speech_activity_end" });
  await advanceTimers(5_000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
  await finishSpeech(session, "訂正後");
  expect(correctSttTranscript).toHaveBeenCalledWith("http://runner.test", "token", "訂正後", [], expect.any(AbortSignal));
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("訂正後", expect.any(Function));
  expect(mockSessions).toHaveLength(1);
});

test("dictation finishes a Runner-confirmed two-second idle without reconnecting or waiting another two seconds", async () => {
  const options = { ...createOptions(), continuousDictation: true, autoReplyAfterStt: false };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "残す文章", isFinal: false });
  await advanceTimers(2_000);
  await emit(session, { type: "speech_activity_end" });
  expect(result.current.phase).toBe("recording");
  await emit(session, { type: "transcript", text: "残す文章", isFinal: true });
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: true });
  expect(result.current.phase).toBe("idle");
  expect(result.current.isArmed()).toBe(false);
  expect(options.setTranscript).toHaveBeenLastCalledWith("残す文章");
  await advanceTimers(2_000);
  expect(mockSessions).toHaveLength(1);
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("interim-only completion after an empty final keeps the draft without auto sending", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "残す途中結果", isFinal: false });
  await emit(session, { type: "transcript", text: "", isFinal: true });
  await emit(session, { type: "done", reason: "speech_end_timeout", hasSpeech: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("残す途中結果");
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

describe("continuing capture during correction", () => {
  async function openCandidate() {
    const options = { ...createOptions(), continuousDictation: true };
    const hook = await renderHook(() => useStreamingStt(options));
    const session = await openReady(hook.result);
    const commit = jest.fn<Promise<boolean>, [number]>().mockResolvedValue(true);
    Object.assign(session, { commit });
    await emit(session, { type: "transcript", text: "前半", isFinal: true });
    return { options, hook, session, commit };
  }

  test("quiet correction commits immediately without adding a silence timer, then sends once", async () => {
    const { options, hook, session, commit } = await openCandidate();
    await emit(session, { type: "candidate", revision: 1 });
    expect(session.callbacks.continueDuringCorrection).toBe(true);
    expect(commit).toHaveBeenCalledWith(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("前半", expect.any(Function));
    expect(options.onError).not.toHaveBeenCalled();
    expect(hook.result.current.isCapturing()).toBe(false);
  });

  test("resumed speech invalidates stale correction and appends in the same capture session", async () => {
    let resolveOld!: (value: { changed: boolean; text: string }) => void;
    jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { options, hook, session, commit } = await openCandidate();
    await emit(session, { type: "candidate", revision: 1 });
    const oldSignal = jest.mocked(correctSttTranscript).mock.calls.at(-1)![4]!;
    expect(hook.result.current.isCapturing()).toBe(true);
    expect(session.abort).not.toHaveBeenCalled();
    await emit(session, { type: "candidate_invalidated", revision: 1 });
    expect(oldSignal.aborted).toBe(false);
    await emit(session, { type: "segment_start" });
    await emit(session, { type: "transcript", text: "後半", isFinal: false });
    expect(oldSignal.aborted).toBe(true);
    await emit(session, { type: "transcript", text: "", isFinal: true });
    await act(async () => { resolveOld({ changed: true, text: "古い補正" }); });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(hook.result.current.correctionPreview).toBeNull();
    await emit(session, { type: "candidate", revision: 2 });
    expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(2);
    expect(mockSessions).toHaveLength(1);
  });

  test("resumed speech discards the old preview and its automatic send timer", async () => {
    jest.mocked(correctSttTranscript).mockResolvedValueOnce({ changed: true, text: "補正前半" });
    const { options, hook, session, commit } = await openCandidate();
    await emit(session, { type: "candidate", revision: 1 });
    expect(hook.result.current.correctionPreview).not.toBeNull();
    await emit(session, { type: "candidate_invalidated", revision: 1 });
    await emit(session, { type: "segment_start" });
    await advanceTimers(3000);
    expect(hook.result.current.correctionPreview).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(options.sendTranscript).not.toHaveBeenCalled();
  });

  test.each(["stop", "identity", "abort"])("%s while committing prevents stale auto-send", async (action) => {
    const { options, hook, session, commit } = await openCandidate();
    let resolveCommit!: (accepted: boolean) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => { resolveCommit = resolve; }));
    await emit(session, { type: "candidate", revision: 1 });
    expect(hook.result.current.phase).toBe("correcting");
    const manualAccepted = jest.fn(() => true);
    await act(async () => { await hook.result.current.sendManualTranscript("手動", manualAccepted); });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await act(async () => {
      if (action === "stop") hook.result.current.stop();
      else if (action === "abort") await hook.result.current.abort();
      else { options.correctionIdentity = "other"; hook.rerender({}); }
    });
    await act(async () => { resolveCommit(true); await Promise.resolve(); });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isCapturing()).toBe(false);
  });

  test.each(["before", "after"])("resumed speech invalidation arriving %s a rejected commit appends and sends once", async (order) => {
    const { options, hook, session, commit } = await openCandidate();
    let resolveCommit!: (accepted: boolean) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => { resolveCommit = resolve; }));
    await emit(session, { type: "candidate", revision: 1 });
    if (order === "before") await emit(session, { type: "candidate_invalidated", revision: 1 });
    await act(async () => { resolveCommit(false); });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("recording");
    expect(hook.result.current.isCapturing()).toBe(true);
    if (order === "after") await emit(session, { type: "candidate_invalidated", revision: 1 });
    await emit(session, { type: "segment_start" });
    await emit(session, { type: "transcript", text: "後半", isFinal: true });
    await emit(session, { type: "candidate", revision: 2 });
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
    expect(commit.mock.calls).toEqual([[1], [2]]);
    expect(mockSessions).toHaveLength(1);
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("an old rejected commit cannot clear a newer candidate while its correction is pending", async () => {
    const { options, hook, session, commit } = await openCandidate();
    let resolveCommit!: (accepted: boolean) => void;
    commit.mockImplementationOnce(() => new Promise((resolve) => { resolveCommit = resolve; }));
    await emit(session, { type: "candidate", revision: 1 });
    await emit(session, { type: "candidate_invalidated", revision: 1 });
    await emit(session, { type: "segment_start" });
    await emit(session, { type: "transcript", text: "後半", isFinal: true });
    let resolveCorrection!: (value: { changed: boolean; text: string }) => void;
    jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise((resolve) => { resolveCorrection = resolve; }));
    await emit(session, { type: "candidate", revision: 2 });
    await act(async () => { resolveCommit(false); });
    expect(hook.result.current.phase).toBe("correcting");
    expect(session.abort).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    await act(async () => { resolveCorrection({ changed: false, text: "前半 後半" }); });
    expect(commit.mock.calls).toEqual([[1], [2]]);
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("前半 後半", expect.any(Function));
  });

  test("editing a preview stops capture and sends the edited draft without committing old audio", async () => {
    jest.mocked(correctSttTranscript).mockResolvedValueOnce({ changed: true, text: "補正前半" });
    const { options, hook, session, commit } = await openCandidate();
    await emit(session, { type: "candidate", revision: 1 });
    await act(async () => { hook.result.current.beginCorrectionEdit(); });
    await act(async () => { hook.result.current.setCorrectionText("手編集"); });
    await emit(session, { type: "candidate_invalidated", revision: 1 });
    expect(hook.result.current.correctionPreview?.text).toBe("手編集");
    expect(session.abort).toHaveBeenCalledTimes(1);
    await act(async () => { hook.result.current.sendCorrectionPreview(); });
    expect(options.sendTranscript).toHaveBeenCalledWith("手編集", expect.any(Function));
    expect(commit).not.toHaveBeenCalled();
  });

  test.each(["close", "commit error"])("%s preserves the draft and reconnects without replaying a send", async (failure) => {
    const { options, hook, session, commit } = await openCandidate();
    if (failure === "commit error") commit.mockRejectedValueOnce(new Error("invalid ACK"));
    else jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise(() => {}));
    await emit(session, { type: "candidate", revision: 1 });
    if (failure === "close") await act(async () => { session.callbacks.onClose(); });
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(options.setTranscript).toHaveBeenLastCalledWith("前半");
    expect(options.onError).not.toHaveBeenCalled();
    expect(hook.result.current.isCapturing()).toBe(false);
    expect(hook.result.current.phase).toBe("connecting");
    await advanceTimers(250);
    expect(mockSessions).toHaveLength(2);
    const resumed = mockSessions[1];
    await emit(resumed, { type: "ready" });
    await emit(resumed, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("前半", expect.any(Function));
  });

  test("lost commit acknowledgement preserves correction and ignores its late rejection while continuation resumes", async () => {
    jest.mocked(correctSttTranscript).mockResolvedValueOnce({ changed: true, text: "補正された前半" });
    const { options, hook, session, commit } = await openCandidate();
    let rejectCommit!: (error: Error) => void;
    commit.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCommit = reject; }));
    await emit(session, { type: "candidate", revision: 1 });
    await act(async () => { hook.result.current.sendCorrectionPreview(); });
    await act(async () => { session.callbacks.onError("lost acknowledgement"); });
    expect(options.setTranscript).toHaveBeenLastCalledWith("補正された前半");
    expect(options.sendTranscript).not.toHaveBeenCalled();
    await advanceTimers(250);
    const resumed = mockSessions.at(-1)!;
    await emit(resumed, { type: "ready" });
    await emit(resumed, { type: "transcript", text: "続き", isFinal: true });
    await act(async () => { rejectCommit(new Error("late rejection")); });
    expect(hook.result.current.phase).toBe("recording");
    await emit(resumed, { type: "done", reason: "speech_end_timeout", hasSpeech: true });
    expect(options.sendTranscript).toHaveBeenCalledTimes(1);
    expect(options.sendTranscript).toHaveBeenCalledWith("補正された前半 続き", expect.any(Function));
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("failed capture release after accepted commit preserves text and never sends or reconnects", async () => {
    const { options, hook, session } = await openCandidate();
    session.abort.mockRejectedValueOnce(new Error("release failed"));
    await emit(session, { type: "candidate", revision: 1 });
    await advanceTimers(10_000);
    expect(options.sendTranscript).not.toHaveBeenCalled();
    expect(options.setTranscript).toHaveBeenLastCalledWith("前半");
    expect(options.onError).toHaveBeenCalledWith("マイクの停止を確認できませんでした。");
    expect(hook.result.current.isArmed()).toBe(false);
    expect(mockSessions).toHaveLength(1);
  });
});

// A VAD onset can be noise. Reuse one correction request while the actual draft is unchanged.
test.each(["pending", "resolved"])("noise leaves the %s correction and original candidate intact", async (state) => {
  let resolveCorrection!: (value: { changed: boolean; text: string }) => void;
  jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise((resolve) => { resolveCorrection = resolve; }));
  const options = { ...createOptions(), continuousDictation: true };
  const hook = await renderHook(() => useStreamingStt(options));
  const session = await openReady(hook.result);
  const commit = jest.fn<Promise<boolean>, [number]>().mockResolvedValue(true);
  Object.assign(session, { commit });
  await emit(session, { type: "transcript", text: "同じ文章", isFinal: true });
  await emit(session, { type: "candidate", revision: 1 });
  if (state === "resolved") await act(async () => { resolveCorrection({ changed: true, text: "補正文章" }); });
  await emit(session, { type: "speech_activity_begin" });
  await emit(session, { type: "speech_activity_end" });
  if (state === "pending") await act(async () => { resolveCorrection({ changed: true, text: "補正文章" }); });
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(jest.mocked(correctSttTranscript)).toHaveBeenCalledTimes(1);
  expect(hook.result.current.correctionPreview?.text).toBe("補正文章");
  await act(async () => { hook.result.current.sendCorrectionPreview(); });
  expect(commit).toHaveBeenCalledWith(1);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
});

test("repeated noise retains the existing preview deadline instead of restarting the three-second countdown", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "補正文章" });
  const options = { ...createOptions(), continuousDictation: true };
  const hook = await renderHook(() => useStreamingStt(options));
  const session = await openReady(hook.result);
  const commit = jest.fn<Promise<boolean>, [number]>().mockResolvedValue(true);
  Object.assign(session, { commit });
  await emit(session, { type: "transcript", text: "同じ文章", isFinal: true });
  await emit(session, { type: "candidate", revision: 1 });
  const deadline = hook.result.current.correctionPreview!.deadlineMs;
  await advanceTimers(1000);
  await emit(session, { type: "speech_activity_begin" });
  await emit(session, { type: "speech_activity_end" });
  await advanceTimers(500);
  expect(hook.result.current.correctionPreview!.deadlineMs).toBe(deadline);
  await advanceTimers(500);
  await emit(session, { type: "speech_activity_begin" });
  await emit(session, { type: "speech_activity_end" });
  expect(hook.result.current.correctionPreview?.deadlineMs).toBe(deadline);
  await advanceTimers(1000);
  expect(commit).toHaveBeenCalledWith(1);
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(correctSttTranscript).toHaveBeenCalledTimes(1);
});

test.each(["no_speech_timeout", "max_duration"])("voice conversation completes recognized segments on %s without a new final", async (reason) => {
  jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise(() => {}));
  const options = { ...createOptions(), transcript: "入力済み" };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  Object.assign(session, { commit: jest.fn(async () => true) });
  await emit(session, { type: "transcript", text: "前半", isFinal: true });
  await emit(session, { type: "candidate", revision: 1 });
  await emit(session, { type: "candidate_invalidated", revision: 1 });
  await emit(session, { type: "segment_start" });
  await emit(session, { type: "done", reason, hasSpeech: false });
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("入力済み 前半", expect.any(Function));
});

test("duration completion during a noise probe keeps the original recognized candidate sendable", async () => {
  jest.mocked(correctSttTranscript).mockImplementationOnce(() => new Promise(() => {}));
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  Object.assign(session, { commit: jest.fn(async () => true) });
  await emit(session, { type: "transcript", text: "確定済み", isFinal: true });
  await emit(session, { type: "candidate", revision: 1 });
  await emit(session, { type: "speech_activity_begin" });
  await emit(session, { type: "done", reason: "max_duration", hasSpeech: false });
  expect(options.sendTranscript).toHaveBeenCalledTimes(1);
  expect(options.sendTranscript).toHaveBeenCalledWith("確定済み", expect.any(Function));
});

test.each(["no_speech_timeout", "max_duration"])("an initial typed draft is never automatically sent on %s", async (reason) => {
  const options = { ...createOptions(), transcript: "手入力" };
  const { result } = await renderHook(() => useStreamingStt(options));
  await emit(await openReady(result), { type: "done", reason, hasSpeech: false });
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("partial-only recognition followed by a legacy retry and no speech does not become an accepted segment", async () => {
  const options = { ...createOptions(), transcript: "手入力" };
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "transcript", text: "途中だけ", isFinal: false });
  await emit(session, { type: "error", code: "macos_recognition_failed", message: "retry", retryable: true });
  await advanceTimers(250);
  const retried = mockSessions.at(-1)!;
  await emit(retried, { type: "ready" });
  await emit(retried, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  expect(options.setTranscript).toHaveBeenLastCalledWith("手入力 途中だけ");
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("disarm distinguishes connecting native session from recording and awaits shutdown", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await act(async () => { await result.current.start(); });
  expect(result.current.getSnapshot()).toEqual({ desired: "listening", observed: "starting" });
  expect(result.current.isCapturing()).toBe(false);
  expect(result.current.isSessionOpen()).toBe(true);
  const session = mockSessions[0];
  let release!: () => void;
  session.abort.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  let stopped = false;
  await act(async () => { void result.current.disarm().then(() => { stopped = true; }); await Promise.resolve(); });
  expect(result.current.isArmed()).toBe(false);
  expect(stopped).toBe(false);
  await emit(session, { type: "ready" });
  expect(result.current.isCapturing()).toBe(false);
  await act(async () => { release(); await Promise.resolve(); });
  expect(stopped).toBe(true);
});

test("failed native release propagates and reports unknown instead of stopped", async () => {
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  const session = await openReady(result);
  session.abort.mockRejectedValue(new Error("native_release_failed"));
  await act(async () => { await expect(result.current.disarm()).rejects.toThrow("native_release_failed"); });
  expect(result.current.getSnapshot()).toEqual({ desired: "stopped", observed: "unknown" });
  await act(async () => { await expect(result.current.disarm()).rejects.toThrow("native_release_failed"); });
  expect(session.abort).toHaveBeenCalledTimes(1);
});

test("disarm preserves an edited correction draft synchronously for handoff preflight", async () => {
  jest.mocked(correctSttTranscript).mockResolvedValue({ changed: true, text: "corrected speech" });
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await finishSpeech(session, "spoken text");
  await act(async () => { result.current.beginCorrectionEdit(); result.current.setCorrectionText("my edited text"); });
  await act(async () => { await result.current.disarm(); });
  expect(result.current.getDraft()).toBe("my edited text");
  expect(options.setTranscript).toHaveBeenLastCalledWith("my edited text");
  await advanceTimers(30_000);
  expect(options.sendTranscript).not.toHaveBeenCalled();
});

test("stop while idle invalidates delayed manual acceptance and never rearms after its reply", async () => {
  const options = createOptions();
  let accept!: () => void;
  let finish!: () => void;
  options.sendTranscript.mockImplementationOnce((_text, onAccepted) => {
    accept = onAccepted;
    return new Promise((resolve) => { finish = resolve; });
  });
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  let sending!: Promise<void>;
  await act(async () => { sending = hook.result.current.sendManualTranscript("typed edit", () => true); });
  expect(hook.result.current.phase).toBe("idle");
  await act(async () => { await hook.result.current.disarm(); });
  await act(async () => { accept(); finish(); await sending; });
  await hook.rerender({ ...options, replyLoading: true });
  await hook.rerender({ ...options, replyLoading: false });
  await advanceTimers(REPLY_CYCLE_START_TIMEOUT_MS + TTS_START_GRACE_MS);
  expect(mockSessions).toHaveLength(0);
  expect(hook.result.current.isArmed()).toBe(false);
  expect(hook.result.current.phase).toBe("idle");
});

test("new speech clears the previous error before delivering its transcript", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  expect(options.onError).not.toHaveBeenCalled();
  await emit(session, { type: "speech_activity_begin" });
  expect(options.onError).toHaveBeenCalledWith("");
  expect(options.onSpeechBegin).toHaveBeenCalledTimes(1);
  await emit(session, { type: "transcript", text: "次の発話", isFinal: false });
  expect(options.setTranscript).toHaveBeenCalledWith("次の発話");
  expect(result.current.phase).toBe("recording");
});

// Cue timing belongs to the capture lifecycle, including retries and manual starts.
test("ready cue waits for native readiness, mutes capture, and ignores duplicate ready", async () => {
  let finishCue!: () => void;
  jest.mocked(playVoiceSound).mockImplementationOnce(() => new Promise((resolve) => { finishCue = resolve; }));
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  await act(async () => { await result.current.start(); });
  expect(playVoiceSound).not.toHaveBeenCalled();
  const session = mockSessions[0];
  await emit(session, { type: "ready" });
  expect(session.setInputMuted.mock.calls).toEqual([[true]]);
  expect(result.current.getSnapshot().observed).toBe("starting");
  await emit(session, { type: "ready" });
  expect(playVoiceSound).toHaveBeenCalledTimes(1);
  await act(async () => { finishCue(); });
  expect(session.setInputMuted.mock.calls).toEqual([[true], [false]]);
  expect(result.current.getSnapshot().observed).toBe("recording");
  await emit(session, { type: "ready" });
  expect(playVoiceSound).toHaveBeenCalledTimes(1);
});

test("stopping during the ready cue cancels playback and never unmutes or revives the old session", async () => {
  let finishCue!: () => void;
  jest.mocked(playVoiceSound).mockImplementationOnce(() => new Promise((resolve) => { finishCue = resolve; }));
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  await act(async () => { await result.current.start(); });
  const session = mockSessions[0];
  await emit(session, { type: "ready" });
  const signal = jest.mocked(playVoiceSound).mock.calls[0][1]!;
  await act(async () => { await result.current.disarm(); });
  expect(signal.aborted).toBe(true);
  await act(async () => { finishCue(); });
  expect(session.setInputMuted.mock.calls).toEqual([[true]]);
  expect(result.current.getSnapshot()).toEqual({ desired: "stopped", observed: "stopped" });
  await openReady(result);
  expect(playVoiceSound).toHaveBeenCalledTimes(2);
  expect(session.setInputMuted.mock.calls).toEqual([[true]]);
});

test("ready playback failure still unmutes input; mute failure safely disarms", async () => {
  jest.mocked(playVoiceSound).mockRejectedValueOnce(new Error("speaker unavailable"));
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  expect(session.setInputMuted.mock.calls).toEqual([[true], [false]]);
  expect(options.onError).not.toHaveBeenCalled();
  await act(async () => { await result.current.disarm(); await result.current.start(); });
  const retry = mockSessions.at(-1)!;
  retry.setInputMuted.mockRejectedValueOnce(new Error("mute failed"));
  await emit(retry, { type: "ready" });
  expect(result.current.isArmed()).toBe(false);
  expect(retry.abort).toHaveBeenCalledTimes(1);
  expect(playVoiceSound).toHaveBeenCalledTimes(1);
});

test("old native capture without muting remains usable and skips unsafe ready playback", async () => {
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  await act(async () => { await result.current.start(); });
  const session = mockSessions[0];
  Object.assign(session, { setInputMuted: undefined });
  await emit(session, { type: "ready" });
  expect(result.current.isCapturing()).toBe(true);
  expect(playVoiceSound).not.toHaveBeenCalled();
});

test("automatic send cue occurs once after accepted dispatch and capture release", async () => {
  let accept!: () => void;
  const options = createOptions();
  options.sendTranscript.mockImplementation(async (_text, onAccepted) => { accept = onAccepted; });
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await finishSpeech(session, "送信する文章");
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(playVoiceSound).toHaveBeenCalledTimes(1);
  await act(async () => { accept(); accept(); });
  expect(jest.mocked(playVoiceSound).mock.calls.map(([key]) => key)).toEqual(["ready", "send"]);
});

test("manual send releases capture before dispatch and plays only when accepted", async () => {
  let release!: () => void;
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  session.abort.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendManualTranscript("手動送信", () => true); });
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(playVoiceSound).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await sent; });
  expect(jest.mocked(playVoiceSound).mock.calls.map(([key]) => key)).toEqual(["ready", "send"]);
});

test("empty, failed, and stale manual sends never announce a send", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  await act(async () => { await result.current.sendManualTranscript(" ", () => true); });
  await act(async () => { await result.current.sendManualTranscript("stale", () => false); });
  options.sendTranscript.mockRejectedValueOnce(new Error("dispatch failed"));
  await act(async () => { await expect(result.current.sendManualTranscript("failed", () => true)).rejects.toThrow("dispatch failed"); });
  expect(playVoiceSound).not.toHaveBeenCalled();
});

test("no-speech retries announce each new ready capture and never announce a send", async () => {
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  const session = await openReady(result);
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false });
  await advanceTimers(250);
  await emit(mockSessions.at(-1)!, { type: "ready" });
  expect(jest.mocked(playVoiceSound).mock.calls.map(([key]) => key)).toEqual(["ready", "ready"]);
});

test("manual chat sends can keep listening stopped while using the same send cue", async () => {
  const options = createOptions();
  options.autoReplyAfterStt = false;
  const { result } = await renderHook(() => useStreamingStt(options));
  await act(async () => { await result.current.sendManualTranscript("手動送信", () => true, false); });
  expect(playVoiceSound).toHaveBeenCalledWith("send");
  expect(result.current.isArmed()).toBe(false);
  expect(result.current.phase).toBe("idle");
  await advanceTimers(1_000);
  expect(mockSessions).toHaveLength(0);
});

test("a manual dispatch rejected before acceptance leaves released input stopped and silent", async () => {
  const options = createOptions();
  options.sendTranscript.mockImplementation(async () => {});
  const { result } = await renderHook(() => useStreamingStt(options));
  await openReady(result);
  await act(async () => { await result.current.sendManualTranscript("blocked", () => true); });
  expect(result.current.getSnapshot()).toEqual({ desired: "stopped", observed: "stopped" });
  expect(jest.mocked(playVoiceSound).mock.calls.map(([key]) => key)).toEqual(["ready"]);
});


test("a fast reply cannot reopen capture until the send cue releases audio", async () => {
  const options = createOptions();
  const hook = await renderHook((current: Options) => useStreamingStt(current), { initialProps: options });
  const session = await openReady(hook.result);
  let releaseCue!: () => void;
  jest.mocked(playVoiceSound).mockImplementationOnce(() => new Promise((resolve) => { releaseCue = resolve; }));
  await finishSpeech(session, "すぐに返答される文章");
  await hook.rerender({ ...options, replyLoading: true });
  await hook.rerender({ ...options, replyLoading: false });
  await advanceTimers(TTS_START_GRACE_MS + 1);
  expect(mockSessions).toHaveLength(1);
  await act(async () => { releaseCue(); });
  expect(mockSessions).toHaveLength(2);
});

test("handoff release also waits for the pending send cue", async () => {
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  const session = await openReady(result);
  let releaseCue!: () => void;
  jest.mocked(playVoiceSound).mockImplementationOnce(() => new Promise((resolve) => { releaseCue = resolve; }));
  await finishSpeech(session, "切り替える前の文章");
  let released = false;
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.disarm().then(() => { released = true; }); });
  expect(released).toBe(false);
  await act(async () => { releaseCue(); await pending; });
  expect(released).toBe(true);
});

test("an unsafe send sound release blocks the next microphone start", async () => {
  const options = createOptions();
  const hook = await renderHook((current: Options) => useStreamingStt(current), { initialProps: options });
  const session = await openReady(hook.result);
  jest.mocked(playVoiceSound).mockRejectedValueOnce(new Error("voice_input_sound_release_failed"));
  await finishSpeech(session, "送信後に再生停止が失敗する文章");
  await hook.rerender({ ...options, replyLoading: true });
  await hook.rerender({ ...options, replyLoading: false });
  await advanceTimers(TTS_START_GRACE_MS + 1);
  expect(mockSessions).toHaveLength(1);
  expect(hook.result.current.isArmed()).toBe(false);
  expect(hook.result.current.getSnapshot().observed).toBe("unknown");
});


test("an unsafe ready sound release stops capture instead of unmuting it", async () => {
  const { result } = await renderHook(() => useStreamingStt(createOptions()));
  await act(async () => { await result.current.start(); });
  const session = mockSessions[0];
  jest.mocked(playVoiceSound).mockRejectedValueOnce(new Error("voice_input_sound_release_failed"));
  await emit(session, { type: "ready" });
  expect(session.setInputMuted.mock.calls).toEqual([[true]]);
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(result.current.isArmed()).toBe(false);
});

test("speech input closes idle measurement before either voice screen's speech callback can request data", async () => {
  updateNetworkUsageObservationAppState("active");
  updateNetworkUsageObservationAppState("background");
  updateNetworkUsageObservationAppState("active");
  const observations: NetworkUsageIdleObservation[] = [];
  const unsubscribe = subscribeNetworkUsageIdleObservations((value) => observations.push(value));
  observations.length = 0;
  const options = createOptions();
  options.onSpeechBegin.mockImplementation(() => {
    expect(observations[0]).toMatchObject({ endReason: "voice_input", comparisonEligible: false,
      usage: { totalReceivedBytes: 10 } });
    recordHttpNetworkUsage("https://runner/session-messages", 0, 1000);
  });
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  recordHttpNetworkUsage("https://runner/client-state", 0, 10);
  await emit(session, { type: "speech_activity_begin" });
  expect(options.onSpeechBegin).toHaveBeenCalledTimes(1);
  expect(observations[0].usage.totalReceivedBytes).toBe(10);
  unsubscribe();
});
