import { act, cleanup, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { REPLY_CYCLE_START_TIMEOUT_MS, TTS_START_GRACE_MS, useStreamingStt } from "./useStreamingStt";
import type { StreamingSttTransportCallbacks } from "./streamingSttTransport";
import { correctSttTranscript, type SttCorrectionContext } from "./sttSettingsClient";

const mockSessions: MockSession[] = [];
const mockConnect = jest.fn((_url: string, _token: string, callbacks: StreamingSttTransportCallbacks) => {
  const session = new MockSession(callbacks);
  mockSessions.push(session);
  return session;
});

class MockSession {
  stop = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  abort = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  constructor(readonly callbacks: StreamingSttTransportCallbacks) {}
  emit(message: Record<string, unknown>) {
    this.callbacks.onMessage(JSON.stringify(message));
  }
}

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
  jest.mocked(correctSttTranscript).mockImplementation(async (_url, _token, text) => ({ changed: false, text }));
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
  await emit(session, { type: "error", code: "cloud_failed", message: "認識できません", retryable: false });
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
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
  expect(options.setTranscript).toHaveBeenLastCalledWith("draft final");
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
  expect(options.setTranscript).toHaveBeenLastCalledWith("draft final next");
  expect(options.onError).not.toHaveBeenCalled();
  expect(options.sendTranscript).not.toHaveBeenCalled();
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_runner_error", {
    version: 1, code: "macos_recognition_failed", retryable: true, retries: 0,
  });
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_error_retry", { version: 2, attempt: 1 });
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
  expect(options.onDiagnostic).toHaveBeenLastCalledWith("stt_session_start", expect.any(Object));
  expect(options.onDiagnostic.mock.calls.filter(([event]) => event === "stt_error_retry")
    .map(([, payload]) => payload)).toEqual([
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

test("delivers volume samples and handles transport errors, close, and invalid JSON", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await act(async () => { session.callbacks.onSample(0.4); });
  expect(options.onSample).toHaveBeenCalledWith(0.4);
  await act(async () => { session.callbacks.onError("backpressure_exceeded"); });
  expect(options.onError).toHaveBeenCalledWith("backpressure_exceeded");
  expect(options.onDiagnostic).toHaveBeenCalledWith("stt_transport_error", expect.any(Object));
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(result.current.active).toBe(false);

  const other = createOptions();
  const second = await renderHook(() => useStreamingStt(other));
  const secondSession = await openReady(second.result);
  await act(async () => { secondSession.callbacks.onClose(); });
  expect(other.onError).toHaveBeenCalledWith(expect.stringContaining("接続が終了"));
  expect(other.onDiagnostic).toHaveBeenCalledWith("stt_transport_closed_before_done", expect.any(Object));

  const thirdOptions = createOptions();
  const third = await renderHook(() => useStreamingStt(thirdOptions));
  const thirdSession = await openReady(third.result);
  await act(async () => { thirdSession.callbacks.onMessage("bad json"); });
  expect(thirdOptions.onError).toHaveBeenCalledWith(expect.stringContaining("不正な音声認識応答"));
  expect(thirdOptions.onDiagnostic).toHaveBeenCalledWith("stt_invalid_runner_response", expect.any(Object));
  await emit(thirdSession, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  await advanceTimers(250);
  expect(mockSessions).toHaveLength(3);
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

test("backgrounding an inline edit restores its latest text and stops sending", async () => {
  let onAppStateChange: ((state: "background") => void) | undefined;
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
  } finally {
    cleanup();
    subscription.mockRestore();
  }
});
