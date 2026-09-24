import { act, renderHook } from "@testing-library/react-native";
import { useStreamingSttTransport } from "./useStreamingSttTransport.macos";

const mockCaptureStart = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
const mockCaptureStop = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
const mockSendPcm = jest.fn();
let mockPcmHandler: (pcm: Uint8Array) => void = () => {};
let mockCaptureError: (error: unknown) => void = () => {};

class MockSocket {
  readyState: number = WebSocket.OPEN;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = 3; });
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  emit(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const mockSockets: MockSocket[] = [];

jest.mock("./useLivePcmCapture.macos", () => ({
  LIVE_PCM_FORMAT: { sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
  useLivePcmCapture: (onPcm: typeof mockPcmHandler, onError: typeof mockCaptureError) => {
    mockPcmHandler = onPcm;
    mockCaptureError = onError;
    return { start: mockCaptureStart, stop: mockCaptureStop };
  },
}));

jest.mock("./streamingSttClient", () => {
  const actual = jest.requireActual("./streamingSttClient");
  return {
    ...actual,
    openStreamingSttSocket: () => {
      const socket = new MockSocket();
      mockSockets.push(socket);
      return socket;
    },
    sendPcm: (...args: unknown[]) => mockSendPcm(...args),
  };
});

function callbacks() {
  return { onMessage: jest.fn(), onSample: jest.fn(), onError: jest.fn(), onClose: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSockets.length = 0;
  mockCaptureStart.mockResolvedValue(undefined);
  mockCaptureStop.mockResolvedValue(undefined);
});

test("opens one Mac socket and starts capture only after ready", async () => {
  const handlers = callbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("http://runner.test", "token", handlers);
  const socket = mockSockets[0];
  expect(mockCaptureStart).not.toHaveBeenCalled();
  await act(async () => { socket.onopen?.(); });
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "start", sampleRate: 16_000 }));
  mockPcmHandler(new Uint8Array([0, 0]));
  expect(mockSendPcm).not.toHaveBeenCalled();
  await act(async () => { socket.emit({ type: "ready" }); await Promise.resolve(); });
  expect(mockCaptureStart).toHaveBeenCalledTimes(1);
  expect(handlers.onMessage).toHaveBeenCalledWith('{"type":"ready"}');
  await act(async () => { mockPcmHandler(new Uint8Array([0, 0])); });
  expect(mockSendPcm).toHaveBeenCalledTimes(1);
  expect(handlers.onSample).toHaveBeenCalledWith(0);
  await act(async () => { await session.abort(); });
  expect(socket.close).toHaveBeenCalledTimes(1);
});

test("waits for capture shutdown before sending one stop frame", async () => {
  let resolveStop = () => {};
  mockCaptureStop.mockImplementation(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("http://runner.test", "token", callbacks());
  const socket = mockSockets[0];
  await act(async () => { socket.emit({ type: "ready" }); await Promise.resolve(); });
  const stop = session.stop();
  expect(mockCaptureStop).toHaveBeenCalledTimes(1);
  expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "stop" }));
  await act(async () => { resolveStop(); await stop; });
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "stop" }));
});

test("stops a capture that starts after Stop and sends no more PCM", async () => {
  let resolveStart = () => {};
  mockCaptureStart.mockImplementation(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
  const handlers = callbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("http://runner.test", "token", handlers);
  const socket = mockSockets[0];
  await act(async () => { socket.emit({ type: "ready" }); await Promise.resolve(); });
  expect(mockCaptureStart).toHaveBeenCalledTimes(1);

  const stop = session.stop();
  mockPcmHandler(new Uint8Array([0, 0]));
  expect(mockSendPcm).not.toHaveBeenCalled();
  expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "stop" }));

  await act(async () => { resolveStart(); await stop; });
  expect(mockCaptureStop).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "stop" }));
  expect(handlers.onMessage).not.toHaveBeenCalledWith('{"type":"ready"}');
  mockPcmHandler(new Uint8Array([0, 0]));
  socket.emit({ type: "ready" });
  expect(mockSendPcm).not.toHaveBeenCalled();
  expect(mockCaptureStart).toHaveBeenCalledTimes(1);
});

test("reports PCM backpressure and capture error through the session", async () => {
  const handlers = callbacks();
  const { result } = await renderHook(() => useStreamingSttTransport());
  const session = result.current.connect("http://runner.test", "token", handlers);
  await act(async () => { mockSockets[0].emit({ type: "ready" }); await Promise.resolve(); });
  mockSendPcm.mockImplementationOnce(() => { throw new Error("backpressure_exceeded"); });
  mockPcmHandler(new Uint8Array([0, 0]));
  expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining("音声送信が追いつきません"));
  mockCaptureError(new Error("bad pcm"));
  expect(handlers.onError).toHaveBeenCalledWith("マイクの音声データを読み取れませんでした。");
  await act(async () => { await session.abort(); });
});
