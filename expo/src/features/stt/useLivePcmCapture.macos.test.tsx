import { act, renderHook } from "@testing-library/react-native";
import { NativeModules } from "react-native";

const mockListeners = new Map<string, (value: unknown) => void>();

jest.mock("react-native/Libraries/EventEmitter/NativeEventEmitter", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    addListener: (name: string, listener: (value: unknown) => void) => {
      mockListeners.set(name, listener);
      return { remove: () => mockListeners.delete(name) };
    },
  })),
}));

const microphone = { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) };
NativeModules.BittyMicrophone = microphone;
const { LIVE_PCM_FORMAT, supportsLivePcmCapture, useLivePcmCapture } = require("./useLivePcmCapture.macos") as typeof import("./useLivePcmCapture.macos");

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
});

test("streams Mac PCM16 to the shared capture contract and stops delivery", async () => {
  const onPcm = jest.fn();
  const { result } = await renderHook(() => useLivePcmCapture(onPcm));
  expect(supportsLivePcmCapture).toBe(true);
  expect(LIVE_PCM_FORMAT).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });

  await act(async () => { await result.current.start(); });
  expect(microphone.start).toHaveBeenCalledTimes(1);
  expect(result.current.isRecording).toBe(true);
  mockListeners.get("BittyMicrophoneData")?.({ data: "AQD+/w==" });
  expect(onPcm).toHaveBeenCalledWith(new Uint8Array([1, 0, 254, 255]));

  await act(async () => { await result.current.stop(); });
  expect(microphone.stop).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(0);
});

test("reports native conversion failures to the STT session", async () => {
  const onError = jest.fn();
  const { result } = await renderHook(() => useLivePcmCapture(jest.fn(), onError));
  await act(async () => { await result.current.start(); });
  mockListeners.get("BittyMicrophoneError")?.({});
  expect(onError).toHaveBeenCalledWith(expect.any(Error));
});
