import { act, renderHook } from "@testing-library/react-native";
import { useStreamingSttTransport } from "./useStreamingSttTransport";

const mockListeners = new Map<string, (event: any) => void>();
const mockNative = {
  start: jest.fn<Promise<void>, [string, Record<string, string>]>().mockResolvedValue(undefined),
  stop: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  abort: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  addListener: jest.fn((name: string, listener: (event: any) => void) => {
    mockListeners.set(name, listener);
    return { remove: () => mockListeners.delete(name) };
  }),
};
const mockCloudflareHeaders = jest.fn((_url: string) => ({} as Record<string, string>));

jest.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => mockNative,
}));
jest.mock("../app/utils/cloudflareAccessFetch", () => ({
  getCloudflareAccessHeadersForUrl: (url: string) => mockCloudflareHeaders(url),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  delete (mockNative as typeof mockNative & { captureDiagnosticsVersion?: number }).captureDiagnosticsVersion;
  mockNative.start.mockResolvedValue(undefined);
  mockNative.stop.mockResolvedValue(undefined);
  mockNative.abort.mockResolvedValue(undefined);
  mockCloudflareHeaders.mockReturnValue({});
});

test("starts a single native socket with bearer and matching Cloudflare headers", async () => {
  mockCloudflareHeaders.mockReturnValue({
    "CF-Access-Client-Id": "id",
    "CF-Access-Client-Secret": "secret",
  });
  const callbacks = { onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example/base?x=1", " token ", callbacks);

  expect(mockNative.start).toHaveBeenCalledWith("wss://runner.example/stream-stt", {
    Authorization: "Bearer token",
    "CF-Access-Client-Id": "id",
    "CF-Access-Client-Secret": "secret",
  });
  expect(mockCloudflareHeaders).toHaveBeenCalledWith("wss://runner.example/stream-stt");
  mockListeners.get("BittyStreamingSttMessage")?.({ data: '{"type":"ready"}' });
  mockListeners.get("BittyStreamingSttSample")?.({ rms: 0.25 });
  expect(callbacks.onMessage).toHaveBeenCalledWith('{"type":"ready"}');
  expect(callbacks.onSample).toHaveBeenCalledWith(0.25);
  await act(async () => { await session.stop(); });
  expect(mockNative.stop).toHaveBeenCalledTimes(1);
  expect(mockNative.abort).not.toHaveBeenCalled();
  await act(async () => { await session.abort(); });
  expect(mockNative.abort).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(0);
});

test("rejects missing runner token before opening and ignores events after abort", async () => {
  const callbacks = { onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
  const { result } = await renderHook(() => useStreamingSttTransport());
  expect(() => result.current.connect("http://127.0.0.1:8788", " ", callbacks)).toThrow("runner_token_required");
  expect(mockNative.start).not.toHaveBeenCalled();
  const session = result.current.connect("http://127.0.0.1:8788", "token", callbacks);
  expect(mockNative.start).toHaveBeenCalledWith("ws://127.0.0.1:8788/stream-stt", { Authorization: "Bearer token" });
  const messageListener = mockListeners.get("BittyStreamingSttMessage")!;
  await act(async () => { await session.abort(); });
  messageListener({ data: "stale" });
  expect(callbacks.onMessage).not.toHaveBeenCalled();
});

test("forwards native start rejection and terminal events", async () => {
  mockNative.start.mockRejectedValueOnce(new Error("connect failed"));
  const callbacks = { onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "token", callbacks);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(callbacks.onError).toHaveBeenCalledWith("connect failed");
  mockListeners.get("BittyStreamingSttError")?.({ message: "native failure" });
  mockListeners.get("BittyStreamingSttClose")?.({});
  expect(callbacks.onError).toHaveBeenCalledWith("native failure");
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  await act(async () => { await session.abort(); });
});

const captureSessionId = "a1234567-1234-4567-89ab-0123456789ab";
const otherCaptureSessionId = "b1234567-1234-4567-89ab-0123456789ab";
const diagnosticNative = mockNative as typeof mockNative & { captureDiagnosticsVersion?: number };
function captureDiagnostic(stage: string, details: Record<string, unknown> = {}) {
  return { sessionId: captureSessionId, stage, elapsedMs: 25, ...details };
}
function diagnosticCallbacks() {
  return { onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn(), onDiagnostic: jest.fn() };
}

test("forwards capture milestones with safe fields only, once per stage", async () => {
  diagnosticNative.captureDiagnosticsVersion = 1;
  const callbacks = diagnosticCallbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "private-token", callbacks);
  const diagnostic = mockListeners.get("BittyStreamingSttDiagnostic")!;
  diagnostic(captureDiagnostic("session_started"));
  const metrics = {
    permissionGranted: true, ready: true, stopping: false, engineRunning: false,
    capturedBuffers: 2, capturedFrames: 8192, convertedFrames: 3200,
    queuedAudioBytes: 6400, startedAudioBytes: 6400, sentAudioBytes: 3200,
    pendingAudioBytes: 3200, partialAudioBytes: 128, inputSampleRate: 48000, inputChannels: 1,
  };
  diagnostic(captureDiagnostic("permission_result", {
    ...metrics, transcript: "private speech", audio: "private audio", message: "private error", url: "private-url",
    headers: { Authorization: "private-token" }, routeName: "private device",
  }));
  for (let i = 0; i < 100; i += 1) diagnostic(captureDiagnostic("first_audio_sent", { sentAudioBytes: i * 3200 }));
  expect(callbacks.onDiagnostic).toHaveBeenCalledTimes(3);
  expect(callbacks.onDiagnostic).toHaveBeenNthCalledWith(2, captureDiagnostic("permission_result", metrics));
  expect(JSON.stringify(callbacks.onDiagnostic.mock.calls)).not.toContain("private");
  expect(callbacks.onMessage).not.toHaveBeenCalled();
  await session.abort();
});

test("rejects unknown stages and invalid required fields, and omits invalid optional metrics", async () => {
  diagnosticNative.captureDiagnosticsVersion = 1;
  const callbacks = diagnosticCallbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "token", callbacks);
  const diagnostic = mockListeners.get("BittyStreamingSttDiagnostic")!;
  for (const invalid of [
    null, "secret", {}, captureDiagnostic("private stage"),
    captureDiagnostic("session_started", { sessionId: "private-session" }),
    ...[-1, 1.5, NaN, Infinity, "25"].map((elapsedMs) => captureDiagnostic("session_started", { elapsedMs })),
    captureDiagnostic("first_tap"),
  ]) diagnostic(invalid);
  expect(callbacks.onDiagnostic).not.toHaveBeenCalled();
  diagnostic(captureDiagnostic("session_started"));
  diagnostic(captureDiagnostic("first_tap", {
    capturedBuffers: Infinity, capturedFrames: -1, convertedFrames: NaN, queuedAudioBytes: 1.1,
    startedAudioBytes: Number.MAX_SAFE_INTEGER + 1, sentAudioBytes: "3200", pendingAudioBytes: 0,
    partialAudioBytes: true, inputSampleRate: 48000, inputChannels: -1, ready: "true", permissionGranted: 1,
  }));
  expect(callbacks.onDiagnostic).toHaveBeenLastCalledWith(captureDiagnostic("first_tap", { pendingAudioBytes: 0, inputSampleRate: 48000 }));
  await session.abort();
});

test("ignores another capture identity and callbacks retained after abort", async () => {
  diagnosticNative.captureDiagnosticsVersion = 1;
  const callbacks = diagnosticCallbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const first = result.current.connect("https://runner.example", "token", callbacks);
  const oldDiagnostic = mockListeners.get("BittyStreamingSttDiagnostic")!;
  oldDiagnostic(captureDiagnostic("session_started"));
  oldDiagnostic(captureDiagnostic("first_tap", { sessionId: otherCaptureSessionId }));
  await first.abort();
  const second = result.current.connect("https://runner.example", "token", callbacks);
  const diagnostic = mockListeners.get("BittyStreamingSttDiagnostic")!;
  diagnostic(captureDiagnostic("session_started", { sessionId: otherCaptureSessionId }));
  diagnostic(captureDiagnostic("first_tap"));
  oldDiagnostic(captureDiagnostic("first_pcm"));
  diagnostic(captureDiagnostic("first_tap", { sessionId: otherCaptureSessionId }));
  expect(callbacks.onDiagnostic).toHaveBeenCalledTimes(3);
  expect(callbacks.onDiagnostic).toHaveBeenLastCalledWith(captureDiagnostic("first_tap", { sessionId: otherCaptureSessionId }));
  await second.abort();
});

test("preserves the old event contract when native diagnostics or the consumer is absent", async () => {
  delete diagnosticNative.captureDiagnosticsVersion;
  const callbacks = diagnosticCallbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "token", callbacks);
  expect(mockListeners.has("BittyStreamingSttDiagnostic")).toBe(false);
  mockListeners.get("BittyStreamingSttMessage")!({ data: '{"type":"ready"}' });
  expect(callbacks.onMessage).toHaveBeenCalledWith('{"type":"ready"}');
  await session.stop();
  await session.abort();
  diagnosticNative.captureDiagnosticsVersion = 1;
  const { onDiagnostic: _unused, ...withoutDiagnostics } = callbacks;
  const other = result.current.connect("https://runner.example", "token", withoutDiagnostics);
  expect(mockListeners.has("BittyStreamingSttDiagnostic")).toBe(false);
  await other.abort();
});

test("still starts recording if optional diagnostic listener registration fails", async () => {
  diagnosticNative.captureDiagnosticsVersion = 1;
  const regularImplementation = mockNative.addListener.getMockImplementation()!;
  mockNative.addListener.mockImplementation((name, listener) => {
    if (name === "BittyStreamingSttDiagnostic") throw new Error("unsupported event");
    return regularImplementation(name, listener);
  });
  const callbacks = diagnosticCallbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "token", callbacks);
  expect(mockNative.start).toHaveBeenCalledTimes(1);
  mockListeners.get("BittyStreamingSttMessage")!({ data: '{"type":"ready"}' });
  expect(callbacks.onMessage).toHaveBeenCalledWith('{"type":"ready"}');
  await session.abort();
  mockNative.addListener.mockImplementation(regularImplementation);
});


test("diagnostic consumer failures do not interrupt ordinary native events", async () => {
  diagnosticNative.captureDiagnosticsVersion = 1;
  const callbacks = diagnosticCallbacks();
  callbacks.onDiagnostic.mockImplementation(() => { throw new Error("log unavailable"); });
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("https://runner.example", "token", callbacks);
  expect(() => mockListeners.get("BittyStreamingSttDiagnostic")!(captureDiagnostic("session_started"))).not.toThrow();
  mockListeners.get("BittyStreamingSttMessage")!({ data: '{"type":"ready"}' });
  mockListeners.get("BittyStreamingSttSample")!({ rms: 0.25 });
  expect(callbacks.onMessage).toHaveBeenCalledWith('{"type":"ready"}');
  expect(callbacks.onSample).toHaveBeenCalledWith(0.25);
  await session.stop();
  await session.abort();
});

test("continuation is enabled only for an opted-in client with a compatible native capture barrier", async () => {
  const native = mockNative as typeof mockNative & { continuationVersion?: number; commit?: jest.Mock };
  const callbacks = { continueDuringCorrection: true, onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
  const { result } = await renderHook(() => useStreamingSttTransport());
  try {
    const legacy = result.current.connect("http://runner.test", "token", callbacks);
    expect(legacy.commit).toBeUndefined();
    expect(mockNative.start).toHaveBeenLastCalledWith("ws://runner.test/stream-stt", expect.any(Object));
    await legacy.abort();
    native.continuationVersion = 1;
    native.commit = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const current = result.current.connect("http://runner.test", "token", callbacks);
    expect(mockNative.start).toHaveBeenLastCalledWith("ws://runner.test/stream-stt?continuation=1", expect.any(Object));
    await expect(current.commit!(1)).resolves.toBe(false);
    await expect(current.commit!(2)).resolves.toBe(true);
    expect(mockNative.abort).toHaveBeenCalledTimes(1);
    await current.abort();
    const disabled = result.current.connect("http://runner.test", "token", { ...callbacks, continueDuringCorrection: false });
    expect(disabled.commit).toBeUndefined();
    expect(mockNative.start).toHaveBeenLastCalledWith("ws://runner.test/stream-stt", expect.any(Object));
    await disabled.abort();
  } finally {
    delete native.continuationVersion;
    delete native.commit;
  }
});
