import type { AVPlaybackStatus } from "expo-av";
import { Audio } from "../app/audio";
import { playVoiceInputSound } from "./voiceInputSounds";

jest.mock("../app/audio", () => ({ Audio: { Sound: { createAsync: jest.fn() } } }));

let status: ((value: AVPlaybackStatus) => void) | null;
const sound = {
  setOnPlaybackStatusUpdate: jest.fn((handler: ((value: AVPlaybackStatus) => void) | null) => { status = handler; }),
  playAsync: jest.fn(async () => ({})),
  unloadAsync: jest.fn(async () => ({})),
};
const loadedSound = () => ({ sound } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  status = null;
  sound.playAsync.mockImplementation(async () => ({}));
  sound.unloadAsync.mockImplementation(async () => ({}));
  jest.mocked(Audio.Sound.createAsync).mockResolvedValue(loadedSound());
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("playback completes at the real finished event and releases the sound", async () => {
  let finished = false;
  const pending = playVoiceInputSound("ready").then(() => { finished = true; });
  await flush();
  expect(sound.playAsync).toHaveBeenCalledTimes(1);
  expect(finished).toBe(false);
  status!({ isLoaded: true, didJustFinish: true } as AVPlaybackStatus);
  await pending;
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
  expect(status).toBeNull();
});

test("cancelling active playback unloads once without waiting for a finish event", async () => {
  const controller = new AbortController();
  const pending = playVoiceInputSound("ready", controller.signal);
  await flush();
  controller.abort();
  await pending;
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
  expect(status).toBeNull();
});

test("cancelled load is cleaned up when it eventually resolves and never plays", async () => {
  let load!: (value: ReturnType<typeof loadedSound>) => void;
  jest.mocked(Audio.Sound.createAsync).mockImplementationOnce(() => new Promise((resolve) => { load = resolve; }));
  const controller = new AbortController();
  const pending = playVoiceInputSound("ready", controller.signal);
  controller.abort();
  await pending;
  load(loadedSound());
  await flush();
  expect(sound.playAsync).not.toHaveBeenCalled();
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("a hanging load times out and its late sound is cleaned up", async () => {
  let load!: (value: ReturnType<typeof loadedSound>) => void;
  jest.mocked(Audio.Sound.createAsync).mockImplementationOnce(() => new Promise((resolve) => { load = resolve; }));
  const pending = expect(playVoiceInputSound("ready")).rejects.toThrow("voice_input_sound_timeout");
  await jest.advanceTimersByTimeAsync(2_000);
  await pending;
  load(loadedSound());
  await flush();
  expect(sound.playAsync).not.toHaveBeenCalled();
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("playback failure rejects after freeing the sound", async () => {
  sound.playAsync.mockRejectedValueOnce(new Error("speaker failed"));
  await expect(playVoiceInputSound("send")).rejects.toThrow("speaker failed");
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});

test("completion waits for native unload before allowing another capture", async () => {
  let release!: () => void;
  sound.unloadAsync.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}); }));
  let finished = false;
  const pending = playVoiceInputSound("send").then(() => { finished = true; });
  await flush();
  status!({ isLoaded: true, didJustFinish: true } as AVPlaybackStatus);
  await flush();
  expect(finished).toBe(false);
  release();
  await pending;
  expect(finished).toBe(true);
});

test("a hanging unload reports unsafe audio release instead of allowing capture", async () => {
  sound.unloadAsync.mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(playVoiceInputSound("send")).rejects.toThrow("voice_input_sound_release_failed");
  await flush();
  status!({ isLoaded: true, didJustFinish: true } as AVPlaybackStatus);
  await jest.advanceTimersByTimeAsync(2_000);
  await pending;
});

test("already cancelled requests do not allocate or play a sound", async () => {
  const controller = new AbortController(); controller.abort();
  await playVoiceInputSound("ready", controller.signal);
  expect(Audio.Sound.createAsync).not.toHaveBeenCalled();
});


test("a synchronous native error status cannot play an already released sound", async () => {
  sound.setOnPlaybackStatusUpdate.mockImplementationOnce((handler) => {
    handler?.({ isLoaded: false, error: "native failure" });
  });
  await expect(playVoiceInputSound("ready")).rejects.toThrow("native failure");
  expect(sound.playAsync).not.toHaveBeenCalled();
  expect(sound.unloadAsync).toHaveBeenCalledTimes(1);
});
