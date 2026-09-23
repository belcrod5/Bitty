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
