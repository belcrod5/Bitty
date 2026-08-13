import { Audio, supportsAudioRecording } from "./audio.macos";

test("declares recording unavailable on macOS", () => {
  expect(supportsAudioRecording).toBe(false);
  expect(() => new Audio.Recording()).toThrow("録音機能はMacでは利用できません。");
});
