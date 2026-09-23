import { act, cleanup, renderHook } from "@testing-library/react-native";
import { REPLY_CYCLE_START_TIMEOUT_MS, TTS_START_GRACE_MS, useStreamingStt } from "./useStreamingStt";
import type { StreamingSttTransportCallbacks } from "./streamingSttTransport";

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
    setTranscript: jest.fn(),
    sendTranscript: jest.fn(async (_text: string, onAccepted: () => void) => onAccepted()),
    onUsage: jest.fn(),
    onSample: jest.fn(),
    onError: jest.fn(),
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
  mockSessions.length = 0;
});

afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
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

test("stop finalizes once and preserves the last transcript", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await act(async () => { result.current.stop(); result.current.stop(); });
  expect(result.current.phase).toBe("finalizing");
  expect(session.stop).toHaveBeenCalledTimes(1);
  await finishSpeech(session, "final after stop");
  expect(options.sendTranscript).toHaveBeenCalledWith("final after stop", expect.any(Function));
  expect(options.onError).not.toHaveBeenCalled();
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

test("Runner error is terminal even if a late done arrives", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await emit(session, { type: "error", code: "cloud_failed", message: "認識できません", retryable: false });
  await emit(session, { type: "done", reason: "no_speech_timeout", hasSpeech: false, usage });
  expect(options.onError).toHaveBeenCalledTimes(1);
  expect(options.onUsage).not.toHaveBeenCalled();
  expect(result.current.active).toBe(false);
});

test("delivers volume samples and handles transport errors, close, and invalid JSON", async () => {
  const options = createOptions();
  const { result } = await renderHook(() => useStreamingStt(options));
  const session = await openReady(result);
  await act(async () => { session.callbacks.onSample(0.4); });
  expect(options.onSample).toHaveBeenCalledWith(0.4);
  await act(async () => { session.callbacks.onError("backpressure_exceeded"); });
  expect(options.onError).toHaveBeenCalledWith("backpressure_exceeded");
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(result.current.active).toBe(false);

  const other = createOptions();
  const second = await renderHook(() => useStreamingStt(other));
  const secondSession = await openReady(second.result);
  await act(async () => { secondSession.callbacks.onClose(); });
  expect(other.onError).toHaveBeenCalledWith(expect.stringContaining("接続が終了"));

  const thirdOptions = createOptions();
  const third = await renderHook(() => useStreamingStt(thirdOptions));
  const thirdSession = await openReady(third.result);
  await act(async () => { thirdSession.callbacks.onMessage("bad json"); });
  expect(thirdOptions.onError).toHaveBeenCalledWith(expect.stringContaining("不正な音声認識応答"));
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

test("rechecks face eligibility before each automatic retry", async () => {
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

async function expectNoRearmAfterFinal(reason: "speech_end_timeout" | "limit_reached") {
  let options = createOptions();
  const hook = await renderHook((props: Options) => useStreamingStt(props), { initialProps: options });
  const session = await openReady(hook.result);
  if (reason === "speech_end_timeout") await act(async () => { hook.result.current.stop(); });
  await finishSpeech(session, "final", reason);
  options = { ...options, replyLoading: true };
  await hook.rerender(options);
  options = { ...options, replyLoading: false };
  await hook.rerender(options);
  await advanceTimers(TTS_START_GRACE_MS);
  expect(options.sendTranscript).toHaveBeenCalledWith("final", expect.any(Function));
  expect(hook.result.current.active).toBe(false);
  expect(session.abort).toHaveBeenCalledTimes(1);
}

test("user stop keeps final text but does not rearm", async () => {
  await expectNoRearmAfterFinal("speech_end_timeout");
});

test("limit reached keeps final text but does not rearm", async () => {
  await expectNoRearmAfterFinal("limit_reached");
});
