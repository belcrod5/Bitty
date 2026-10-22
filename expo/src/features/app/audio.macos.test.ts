import { NativeModules } from "react-native";

const nativeAudio = {
  create: jest.fn(),
  play: jest.fn(),
  playFromPosition: jest.fn(),
  setStatus: jest.fn(),
  unload: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
NativeModules.BittyAudio = nativeAudio;
const { Audio, supportsAudioRecording } = require("./audio.macos") as typeof import("./audio.macos");

beforeEach(() => { jest.clearAllMocks(); });

test("declares recording unavailable on macOS", () => {
  expect(supportsAudioRecording).toBe(false);
  expect(() => new Audio.Recording()).toThrow("録音機能はMacでは利用できません。");
});

test("passes authenticated remote sources to native playback and releases the player", async () => {
  const status = { isLoaded: true, didJustFinish: false, isPlaying: false };
  nativeAudio.create.mockResolvedValue({ soundId: "preview", status });
  nativeAudio.play.mockResolvedValue({ ...status, isPlaying: true });
  nativeAudio.playFromPosition.mockResolvedValue({ ...status, isPlaying: true });
  nativeAudio.setStatus.mockResolvedValue(status);
  nativeAudio.unload.mockResolvedValue({ isLoaded: false });
  const headers = { authorization: "Bearer token", "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" };
  const { sound } = await Audio.Sound.createAsync({ uri: "https://runner.test/files/media?path=音声.wav", headers }, { shouldPlay: false });
  expect(nativeAudio.create).toHaveBeenCalledWith("https://runner.test/files/media?path=音声.wav", { shouldPlay: false }, headers);
  const onStatus = jest.fn();
  sound.setOnPlaybackStatusUpdate(onStatus);
  await sound.playAsync();
  await sound.setStatusAsync({ shouldPlay: false });
  sound.receiveStatus({ ...status, didJustFinish: true } as never);
  expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ didJustFinish: true }));
  await sound.replayAsync();
  expect(nativeAudio.playFromPosition).toHaveBeenCalledWith("preview", 0);
  await sound.unloadAsync();
  onStatus.mockClear();
  sound.receiveStatus(status as never);
  expect(onStatus).not.toHaveBeenCalled();
  expect(nativeAudio.unload).toHaveBeenCalledWith("preview");
});
