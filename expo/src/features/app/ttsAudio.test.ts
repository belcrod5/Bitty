import { NativeModules, Platform } from "react-native";
import { Audio } from "./audio";
import { createTtsSoundAsync } from "./ttsAudio";
import { VISUAL_THEMES } from "./theme/visualThemes";
import { configureCloudflareAccessFetch } from "./utils/cloudflareAccessFetch";

jest.mock("./audio", () => ({ Audio: { Sound: { createAsync: jest.fn() } } }));

const createAsync = Audio.Sound.createAsync as jest.Mock;
const process = jest.fn();
const cancel = jest.fn(async () => {});
const remove = jest.fn(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
  process.mockReset();
  process.mockResolvedValue("file:///tmp/prepared.caf");
  (NativeModules as Record<string, unknown>).BittyTtsEffects = { process, cancel, remove };
  configureCloudflareAccessFetch({ runnerUrl: "https://cloudflare.example.com",
    credentials: { clientId: "test-access-id", clientSecret: "test-access-secret" } });
});

test("standard TTS trims file edges through the same native preparation as themed audio", async () => {
  const sound = { unloadAsync: jest.fn(async () => {}) };
  createAsync.mockResolvedValue({ sound });

  await expect(createTtsSoundAsync("https://runner/tts", { shouldPlay: true, volume: 1 }, null))
    .resolves.toBe(sound);
  expect(createAsync).toHaveBeenCalledWith(
    { uri: "file:///tmp/prepared.caf" }, { shouldPlay: true, volume: 1 }
  );
  expect(process).toHaveBeenCalledWith("https://runner/tts", null, expect.any(String), {});
});

test("themed TTS processes audio locally and removes its file on unload", async () => {
  const sound = { unloadAsync: jest.fn(async () => ({ isLoaded: false })) };
  process.mockResolvedValue("file:///tmp/processed.caf");
  createAsync.mockResolvedValue({ sound });
  const effect = VISUAL_THEMES.cyberpunk.ttsEffect;

  const loaded = await createTtsSoundAsync(
    "https://runner/tts", { shouldPlay: false, volume: 1 }, effect
  );
  expect(process).toHaveBeenCalledWith("https://runner/tts", effect, expect.any(String), {});
  expect(createAsync).toHaveBeenCalledWith(
    { uri: "file:///tmp/processed.caf" }, { shouldPlay: false, volume: 1 }
  );
  await loaded.unloadAsync();
  expect(remove).toHaveBeenCalledWith("file:///tmp/processed.caf");
});

test("failed playback load removes processed audio", async () => {
  process.mockResolvedValue("file:///tmp/processed.caf");
  createAsync.mockRejectedValue(new Error("load failed"));

  await expect(createTtsSoundAsync(
    "https://runner/tts", { shouldPlay: false, volume: 1 }, VISUAL_THEMES.cyberpunk.ttsEffect
  )).rejects.toThrow("load failed");
  expect(remove).toHaveBeenCalledWith("file:///tmp/processed.caf");
});

test("aborting a pending effect stops native work", async () => {
  let rejectProcess: (error: Error) => void = () => {};
  process.mockImplementation(() => new Promise((_resolve, reject) => {
    rejectProcess = reject;
  }));
  const controller = new AbortController();
  const pending = createTtsSoundAsync(
    "https://runner/tts", { shouldPlay: false, volume: 1 },
    VISUAL_THEMES.cyberpunk.ttsEffect, controller.signal
  );
  const requestId = process.mock.calls[0][2];

  controller.abort();
  expect(cancel).toHaveBeenCalledWith(requestId);
  rejectProcess(new Error("TTS音声加工を中止しました。"));
  await expect(pending).rejects.toThrow("中止");
  expect(createAsync).not.toHaveBeenCalled();
});

test("standard Cloudflare TTS supplies origin-scoped credentials to native preparation", async () => {
  const sound = { unloadAsync: jest.fn(async () => {}) };
  createAsync.mockResolvedValue({ sound });
  await createTtsSoundAsync("https://cloudflare.example.com/tts-media/audio.mp3", { shouldPlay: false, volume: 1 }, null);
  expect(process).toHaveBeenCalledWith("https://cloudflare.example.com/tts-media/audio.mp3", null, expect.any(String),
    { "CF-Access-Client-Id": "test-access-id", "CF-Access-Client-Secret": "test-access-secret" });
});

test("themed Cloudflare TTS supplies the same credentials to its native downloader", async () => {
  process.mockResolvedValue("file:///tmp/processed.caf");
  createAsync.mockResolvedValue({ sound: { unloadAsync: jest.fn(async () => {}) } });
  await createTtsSoundAsync("https://cloudflare.example.com/tts-media/audio.mp3", { shouldPlay: false, volume: 1 }, VISUAL_THEMES.cyberpunk.ttsEffect);
  expect(process).toHaveBeenCalledWith("https://cloudflare.example.com/tts-media/audio.mp3",
    VISUAL_THEMES.cyberpunk.ttsEffect, expect.any(String),
    { "CF-Access-Client-Id": "test-access-id", "CF-Access-Client-Secret": "test-access-secret" });
});

test("switching from LAN to Cloudflare changes media credentials without sending them to other origins", async () => {
  createAsync.mockResolvedValue({ sound: { unloadAsync: jest.fn(async () => {}) } });
  const status = { shouldPlay: false, volume: 1 };
  await createTtsSoundAsync("https://mac.local:8789/tts-media/lan.mp3", status, null);
  await createTtsSoundAsync("https://cloudflare.example.com/tts-media/cloud.mp3", status, null);
  await createTtsSoundAsync("https://cloudflare.example.com.attacker.test/tts-media/other.mp3", status, null);
  expect(process.mock.calls[0][3]).toEqual({});
  expect(process.mock.calls[1][3]["CF-Access-Client-Secret"]).toBe("test-access-secret");
  expect(process.mock.calls[2][3]).toEqual({});
});

test("Apple builds require native preparation even without a theme", async () => {
  (NativeModules as Record<string, unknown>).BittyTtsEffects = undefined;
  await expect(createTtsSoundAsync("https://runner/tts", { shouldPlay: false, volume: 1 }, null))
    .rejects.toThrow("再ビルド");
  expect(createAsync).not.toHaveBeenCalled();
});

test("platforms without Apple preparation retain plain playback", async () => {
  const platform = jest.replaceProperty(Platform, "OS", "android");
  try {
    (NativeModules as Record<string, unknown>).BittyTtsEffects = undefined;
    const sound = { unloadAsync: jest.fn(async () => {}) };
    createAsync.mockResolvedValue({ sound });
    await expect(createTtsSoundAsync("https://runner/tts", { shouldPlay: false, volume: 1 }, null))
      .resolves.toBe(sound);
    expect(process).not.toHaveBeenCalled();
  } finally { platform.restore(); }
});
